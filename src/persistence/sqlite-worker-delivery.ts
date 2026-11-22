import { normalizeWorkerFailure } from "./worker-terminal-reason.ts";
import type { Database } from "bun:sqlite";
import type {
  StagedWorkerAssignment, WorkerAssignmentBinding, WorkerAssignmentFailure, WorkerAssignmentOutcome,
  WorkerDeliveryRepository, WorkerDeliveryState,
} from "./worker-delivery-contract.ts";

type Runner = <T>(work: () => T) => Promise<T>;
interface Row {
  assignment_id: string;
  worker_id: string;
  owner_id: string;
  message_id: string;
  operation_id: string | null;
  original_destination: string;
  destination: string;
  originating_policies: string;
  contributing_policies: string;
  final_record_id: string | null;
  staged_json: string | null;
  delivery_state: WorkerDeliveryState | null;
}

const names = (values: readonly string[]) => [...new Set(values)].sort();

function staged(row: Row | null): StagedWorkerAssignment | undefined {
  if (!row?.staged_json || !row.delivery_state) return;
  const value = JSON.parse(row.staged_json) as StagedWorkerAssignment;
  return { ...value, delivery: { ...value.delivery, state: row.delivery_state } };
}

export class SqliteWorkerDelivery implements WorkerDeliveryRepository {
  constructor(
    private readonly database: Database,
    private readonly write: Runner,
    private readonly read: Runner,
    private readonly ownerId: string,
  ) {}

  private row(id: string): Row | null {
    return this.database.query<Row, [string]>("SELECT * FROM worker_assignments WHERE assignment_id = ?").get(id);
  }

  reserve(binding: Parameters<WorkerDeliveryRepository["reserve"]>[0]): Promise<"reserved" | "existing" | "conflict"> {
    const { assignmentId, workerConversationId, messageId, destination } = binding;
    const originating = JSON.stringify(names(binding.originatingPolicyNames));
    const contributing = JSON.stringify(names(binding.contributingPolicyNames));
    return this.write(() => {
      const row = this.row(assignmentId);
      if (row) return row.worker_id === workerConversationId && row.message_id === messageId &&
        row.original_destination === destination && row.originating_policies === originating ? "existing" : "conflict";
      const inserted = this.database.query(`
        INSERT INTO worker_assignments (
          assignment_id, worker_id, message_id, owner_id, original_destination, destination,
          originating_policies, contributing_policies
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).run(assignmentId, workerConversationId, messageId, this.ownerId, destination, destination, originating, contributing);
      if (!inserted.changes) return "conflict";
      return "reserved";
    });
  }

  readBinding(id: string): Promise<WorkerAssignmentBinding | undefined> {
    return this.read(() => {
      const row = this.row(id);
      if (!row) return;
      return { assignmentId: id, workerConversationId: row.worker_id, messageId: row.message_id,
        ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
        ...(row.final_record_id === null ? {} : { finalRecordId: row.final_record_id }),
        destination: row.destination, originatingPolicyNames: JSON.parse(row.originating_policies),
        contributingPolicyNames: JSON.parse(row.contributing_policies) };
    });
  }

  private causalBindings(workerId: string, messageIds: readonly string[]): Row[] {
    const lookup = this.database.query<Row, [string, string]>(
      "SELECT * FROM worker_assignments WHERE worker_id = ? AND message_id = ?",
    );
    return [...new Set(messageIds)].flatMap(id => {
      const row = lookup.get(workerId, id);
      return row ? [row] : [];
    });
  }

  recordFinal(workerId: string, operationId: string, messageIds: readonly string[]): Promise<void> {
    return this.write(() => {
      const bindings = this.causalBindings(workerId, messageIds);
      if (!bindings.some(row => row.final_record_id === null && row.staged_json === null)) return;
      const record = this.database.query<{ record_id: string }, [string, string]>(`
        SELECT r.record_id FROM conversation_records r
        JOIN conversation_messages m ON m.record_row_id = r.row_id
        WHERE r.agent_conversation_id = ? AND r.operation_id = ?
          AND m.role = 'assistant' AND m.status = 'completed'
        ORDER BY r.sequence DESC LIMIT 1
      `).get(workerId, operationId);
      const policies = JSON.stringify(this.policyUnion(bindings));
      for (const row of bindings) {
        if (row.final_record_id !== null || row.staged_json !== null) continue;
        if (record) {
          this.database.query(`UPDATE worker_assignments SET operation_id = ?, final_record_id = ?,
            contributing_policies = ? WHERE assignment_id = ?`).run(operationId, record.record_id, policies, row.assignment_id);
        } else {
          this.recordKnownFailure(row, operationId, policies, {
            kind: "failed", reason: "worker produced no saved result", possiblePartialEffects: true,
          });
        }
      }
    });
  }

  private policyUnion(bindings: readonly Row[]): string[] {
    return names(bindings.flatMap(row => [
      ...JSON.parse(row.originating_policies) as string[], ...JSON.parse(row.contributing_policies) as string[],
    ]));
  }

  recordFailure(workerId: string, operationId: string, messageIds: readonly string[], failure: WorkerAssignmentFailure): Promise<void> {
    return this.write(() => {
      const bindings = this.causalBindings(workerId, messageIds);
      const policies = JSON.stringify(this.policyUnion(bindings));
      for (const row of bindings) {
        if (row.final_record_id === null && row.staged_json === null) this.recordKnownFailure(row, operationId, policies, failure);
      }
    });
  }

  private recordKnownFailure(row: Row, operationId: string, policies: string, failure: WorkerAssignmentFailure): void {
    this.database.query("UPDATE worker_assignments SET operation_id = ?, contributing_policies = ? WHERE assignment_id = ?")
      .run(operationId, policies, row.assignment_id);
    this.writeStage({ ...row, contributing_policies: policies }, normalizeWorkerFailure(failure));
  }

  redirect(id: string, destination: string): Promise<boolean> {
    return this.write(() => this.database.query(
      "UPDATE worker_assignments SET destination = ? WHERE assignment_id = ? AND staged_json IS NULL",
    ).run(destination, id).changes === 1);
  }

  addContributingPolicies(id: string, policies: readonly string[]): Promise<boolean> {
    const added = [...policies];
    return this.write(() => {
      const row = this.row(id);
      if (!row || row.staged_json !== null) return false;
      const combined = names([...JSON.parse(row.contributing_policies) as string[], ...added]);
      this.database.query("UPDATE worker_assignments SET contributing_policies = ? WHERE assignment_id = ?")
        .run(JSON.stringify(combined), id);
      return true;
    });
  }

  private finalText(row: Row): string {
    return this.database.query<{ search_text: string }, [string, string, string]>(`
      SELECT m.search_text FROM conversation_records r
      JOIN conversation_messages m ON m.record_row_id = r.row_id
      WHERE r.agent_conversation_id = ? AND r.operation_id = ?
        AND m.role = 'assistant' AND m.status = 'completed'
        AND r.sequence <= (SELECT sequence FROM conversation_records WHERE record_id = ?)
      ORDER BY r.sequence
    `).all(row.worker_id, row.operation_id!, row.final_record_id!).map(message => message.search_text).join("\n");
  }

  stage(id: string): Promise<StagedWorkerAssignment | undefined> {
    return this.write(() => {
      const row = this.row(id);
      if (!row) return;
      if (row.staged_json !== null) return staged(row);
      if (row.final_record_id === null && row.owner_id === this.ownerId) return;
      const outcome: WorkerAssignmentOutcome = row.final_record_id === null
        ? { kind: "uncertain" }
        : { kind: "result", finalRecordId: row.final_record_id, text: this.finalText(row) };
      return this.writeStage(row, outcome);
    });
  }

  private writeStage(row: Row, outcome: WorkerAssignmentOutcome): StagedWorkerAssignment {
    const id = row.assignment_id;
    const deliveryId = `worker-result:${id}`;
    const value: StagedWorkerAssignment = {
      assignmentId: id, outcome,
      delivery: {
        id: deliveryId, destination: row.destination, source: row.worker_id,
        text: outcome.kind === "result" ? outcome.text : outcome.kind === "uncertain"
          ? `Worker ${row.worker_id} has no reliable result for assignment ${id}.`
          : `Worker ${row.worker_id} assignment ${id}: ${outcome.reason}. Partial external effects may have occurred.`,
        policyNames: names([...JSON.parse(row.originating_policies) as string[], ...JSON.parse(row.contributing_policies) as string[]]),
        state: "pending",
      },
    };
    this.database.query(`UPDATE worker_assignments SET staged_json = ?, delivery_id = ?, delivery_state = 'pending'
      WHERE assignment_id = ?`).run(JSON.stringify(value), deliveryId, id);
    return value;
  }

  readStaged(id: string): Promise<StagedWorkerAssignment | undefined> {
    return this.read(() => staged(this.row(id)));
  }

  transitionDelivery(id: string, transition: Parameters<WorkerDeliveryRepository["transitionDelivery"]>[1]): Promise<boolean> {
    const { from, to } = transition;
    if (from === "pending" ? !["delivered", "blocked_policy", "failed_destination"].includes(to)
      : from !== "blocked_policy" || to !== "pending" || transition.explicitRetry !== true) return Promise.resolve(false);
    return this.write(() => this.database.query(
      "UPDATE worker_assignments SET delivery_state = ? WHERE delivery_id = ? AND delivery_state = ?",
    ).run(to, id, from).changes === 1);
  }
}
