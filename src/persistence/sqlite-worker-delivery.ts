import { normalizeWorkerFailure } from "./worker-terminal-reason.ts";
import type { Database } from "bun:sqlite";
import type {
  StagedWorkerAssignment, WorkerAssignmentBinding, WorkerAssignmentFailure, WorkerAssignmentOutcome,
  WorkerAssignmentDiscovery, WorkerAssignmentReplacement, WorkerAssignmentReservation,
  WorkerDeliveryRepository, WorkerDeliveryState, WorkerDestination,
} from "./worker-delivery-contract.ts";

type Runner = <T>(work: () => T) => Promise<T>;
interface Row {
  assignment_id: string;
  worker_id: string;
  owner_id: string;
  reservation_seq: number;
  destination_kind: WorkerDestination["kind"];
  original_destination_kind: WorkerDestination["kind"];
  worker_handle: string | null;
  initial_message_id: string;
  initial_contributing_policies: string;
  awaiting_continuation: number;
  replacement_of: string | null;
  replacement_message: string | null;
  replacement_disposition: "replaced" | "old_settled" | null;
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
  const destination = typeof value.delivery.destination === "string"
    ? { kind: "native" as const, id: value.delivery.destination } : value.delivery.destination;
  return { ...value, delivery: { ...value.delivery, destination, state: row.delivery_state } };
}

export class SqliteWorkerDelivery implements WorkerDeliveryRepository {
  constructor(
    private readonly database: Database,
    private readonly write: Runner,
    private readonly read: Runner,
    private readonly ownerId: string,
    private readonly ownerCutoff: number,
  ) {}

  private row(id: string): Row | null {
    return this.database.query<Row, [string]>("SELECT * FROM worker_assignments WHERE assignment_id = ?").get(id);
  }

  private binding(row: Row): WorkerAssignmentBinding {
    return { assignmentId: row.assignment_id, workerConversationId: row.worker_id,
      workerHandle: row.worker_handle ?? row.worker_id, messageId: row.message_id,
      ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
      ...(row.final_record_id === null ? {} : { finalRecordId: row.final_record_id }),
      destination: { id: row.destination, kind: row.destination_kind },
      originatingPolicyNames: JSON.parse(row.originating_policies),
      contributingPolicyNames: JSON.parse(row.contributing_policies) };
  }

  private matches(row: Row, binding: WorkerAssignmentReservation): boolean {
    return row.worker_id === binding.workerConversationId && row.initial_message_id === binding.messageId &&
      (row.worker_handle ?? row.worker_id) === binding.workerHandle &&
      row.original_destination === binding.destination.id && row.original_destination_kind === binding.destination.kind &&
      row.originating_policies === JSON.stringify(names(binding.originatingPolicyNames)) &&
      row.initial_contributing_policies === JSON.stringify(names(binding.contributingPolicyNames));
  }

  private claimed(workerId: string, messageId: string): boolean {
    return Boolean(this.database.query(`
      SELECT 1 FROM worker_assignments WHERE worker_id = ?1 AND message_id = ?2
      UNION ALL SELECT 1 FROM worker_assignment_continuations WHERE worker_id = ?1 AND predecessor_message_id = ?2
      LIMIT 1
    `).get(workerId, messageId));
  }

  private insert(binding: WorkerAssignmentReservation, replacement?: {
    oldId: string; messageId: string; disposition: "replaced" | "old_settled";
  }): void {
    const { assignmentId, workerConversationId, messageId, destination, workerHandle } = binding;
    const originating = JSON.stringify(names(binding.originatingPolicyNames));
    const contributing = JSON.stringify(names(binding.contributingPolicyNames));
    this.database.query(`
      INSERT INTO worker_assignments (
        assignment_id, worker_id, message_id, owner_id, original_destination, destination,
        originating_policies, contributing_policies, original_destination_kind, destination_kind,
        worker_handle, initial_message_id, initial_contributing_policies, reservation_seq,
        replacement_of, replacement_message, replacement_disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT COALESCE(MAX(reservation_seq), 0) + 1 FROM worker_assignments), ?, ?, ?)
    `).run(assignmentId, workerConversationId, messageId, this.ownerId, destination.id, destination.id, originating,
      contributing, destination.kind, destination.kind, workerHandle, messageId, contributing,
      replacement?.oldId ?? null, replacement?.messageId ?? null, replacement?.disposition ?? null);
  }

  reserve(input: WorkerAssignmentReservation): Promise<"reserved" | "existing" | "conflict"> {
    const binding = structuredClone(input);
    return this.write(() => {
      const row = this.row(binding.assignmentId);
      if (row) return row.replacement_of === null && this.matches(row, binding) ? "existing" : "conflict";
      if (this.claimed(binding.workerConversationId, binding.messageId)) return "conflict";
      this.insert(binding);
      return "reserved";
    });
  }

  readBinding(id: string): Promise<WorkerAssignmentBinding | undefined> {
    return this.read(() => {
      const row = this.row(id);
      return row ? this.binding(row) : undefined;
    });
  }

  markSteered(workerId: string, messageIds: readonly string[]): Promise<void> {
    const causes = [...messageIds];
    return this.write(() => {
      const active = this.causalBindings(workerId, causes);
      const bindings = this.policyBindings(workerId, causes, active);
      const policies = JSON.stringify(this.policyUnion(bindings));
      for (const row of bindings) {
        if (row.owner_id !== this.ownerId || row.staged_json !== null || row.final_record_id !== null) continue;
        this.database.query(`UPDATE worker_assignments
          SET awaiting_continuation = MAX(awaiting_continuation, ?), contributing_policies = ? WHERE assignment_id = ?`)
          .run(causes.includes(row.message_id) ? 1 : 0, policies, row.assignment_id);
      }
    });
  }

  continueAssignment(id: string, predecessor: string, successor: string): Promise<"continued" | "existing" | "conflict"> {
    return this.write(() => {
      const row = this.row(id);
      if (!row) return "conflict";
      const previous = this.database.query<{ successor_message_id: string; assignment_id: string }, [string, string]>(
        "SELECT successor_message_id, assignment_id FROM worker_assignment_continuations WHERE worker_id = ? AND predecessor_message_id = ?",
      ).get(row.worker_id, predecessor);
      if (previous) return previous.assignment_id === id && previous.successor_message_id === successor ? "existing" : "conflict";
      if (row.owner_id !== this.ownerId || row.message_id !== predecessor || row.staged_json !== null ||
        row.final_record_id !== null || this.claimed(row.worker_id, successor)) return "conflict";
      this.database.query("INSERT INTO worker_assignment_continuations VALUES (?, ?, ?, ?)")
        .run(row.worker_id, predecessor, successor, id);
      this.database.query("UPDATE worker_assignments SET message_id = ?, awaiting_continuation = 0 WHERE assignment_id = ?")
        .run(successor, id);
      return "continued";
    });
  }

  closeContinuation(id: string, expected: string, failure: WorkerAssignmentFailure): Promise<StagedWorkerAssignment | undefined> {
    const terminal = normalizeWorkerFailure(failure);
    return this.write(() => {
      const row = this.row(id);
      if (!row || row.message_id !== expected) return;
      if (row.staged_json !== null) return staged(row);
      if (row.owner_id !== this.ownerId || row.final_record_id !== null || !row.awaiting_continuation) return;
      return this.writeStage(row, terminal);
    });
  }

  replaceAssignment(id: string, expected: string, input: WorkerAssignmentReservation): Promise<WorkerAssignmentReplacement> {
    const binding = structuredClone(input);
    return this.write(() => {
      const existing = this.row(binding.assignmentId);
      if (existing) return existing.replacement_of === id && existing.replacement_message === expected &&
        existing.replacement_disposition && this.matches(existing, binding)
        ? { kind: existing.replacement_disposition, reservation: "existing" } : { kind: "conflict" };
      const old = this.row(id);
      if (!old || old.worker_id !== binding.workerConversationId || old.message_id !== expected ||
        this.claimed(binding.workerConversationId, binding.messageId)) return { kind: "conflict" };
      const settled = old.final_record_id !== null || old.staged_json !== null;
      const abandoned = old.owner_id !== this.ownerId;
      const disposition = settled || abandoned ? "old_settled" : "replaced";
      if (!settled) this.writeStage(old, abandoned ? { kind: "uncertain" } : {
        kind: "interrupted", reason: "worker interrupted by steering", possiblePartialEffects: true,
      });
      this.insert(binding, { oldId: id, messageId: expected, disposition });
      return { kind: disposition, reservation: "reserved" };
    });
  }

  discoverAssignments({ destinationKind, state, after, limit = 50 }: WorkerAssignmentDiscovery):
    ReturnType<WorkerDeliveryRepository["discoverAssignments"]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid assignment page limit");
    const prefix = `${destinationKind}:${state}:`;
    const sequence = after === undefined ? 0 : Number(after.slice(prefix.length));
    if (after !== undefined && (!after.startsWith(prefix) || !Number.isSafeInteger(sequence) ||
      sequence <= 0 || after !== prefix + sequence)) throw new RangeError("Invalid assignment cursor");
    return this.read(() => {
      const rows = state === "pending"
        ? this.database.query<Row, [string, number, number]>(`
            SELECT * FROM worker_assignments WHERE destination_kind = ? AND reservation_seq > ?
              AND delivery_state = 'pending' ORDER BY reservation_seq LIMIT ?
          `).all(destinationKind, sequence, limit + 1)
        : this.database.query<Row, [string, number, number, number]>(`
            SELECT * FROM (
              SELECT * FROM worker_assignments WHERE destination_kind = ?1 AND reservation_seq > ?2
                AND reservation_seq <= ?3 AND staged_json IS NULL AND final_record_id IS NULL
              ORDER BY reservation_seq LIMIT ?4
            )
            UNION ALL SELECT * FROM (
              SELECT * FROM worker_assignments WHERE destination_kind = ?1 AND reservation_seq > ?2
                AND staged_json IS NULL AND final_record_id IS NOT NULL
              ORDER BY reservation_seq LIMIT ?4
            )
            ORDER BY reservation_seq LIMIT ?4
          `).all(destinationKind, sequence, this.ownerCutoff, limit + 1);
      const page = rows.slice(0, limit);
      return {
        assignments: page.map(row => state === "pending"
          ? { state, staged: staged(row)! } : { state, binding: this.binding(row) }),
        ...(rows.length > limit ? { next: prefix + page.at(-1)!.reservation_seq } : {}),
      };
    });
  }

  latestOutcome(workerId: string, kind?: "result"): Promise<StagedWorkerAssignment | undefined> {
    return this.read(() => staged(this.database.query<Row, [string, string | null]>(`
      SELECT * FROM worker_assignments WHERE worker_id = ? AND staged_json IS NOT NULL
      AND (? IS NULL OR json_extract(staged_json, '$.outcome.kind') = 'result')
      ORDER BY reservation_seq DESC LIMIT 1
    `).get(workerId, kind ?? null)));
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

  private policyBindings(workerId: string, causes: readonly string[], active: readonly Row[]): Row[] {
    const prior = this.database.query<Row, [string, string]>(`
      SELECT a.* FROM worker_assignment_continuations c
      JOIN worker_assignments a ON a.assignment_id = c.assignment_id
      WHERE c.worker_id = ? AND c.predecessor_message_id = ?
    `);
    const bindings = new Map(active.map(row => [row.assignment_id, row]));
    for (const id of causes) {
      const row = prior.get(workerId, id);
      if (row) bindings.set(row.assignment_id, row);
    }
    return [...bindings.values()];
  }

  recordFinal(workerId: string, operationId: string, messageIds: readonly string[]): Promise<void> {
    return this.write(() => {
      const bindings = this.causalBindings(workerId, messageIds);
      if (!bindings.some(row => row.final_record_id === null && row.staged_json === null)) return;
      const record = this.database.query<{ record_id: string; search_text: string }, [string, string]>(`
        SELECT r.record_id, m.search_text FROM conversation_records r
        JOIN conversation_messages m ON m.record_row_id = r.row_id
        WHERE r.agent_conversation_id = ? AND r.operation_id = ?
          AND m.role = 'assistant' AND m.status = 'completed'
        ORDER BY r.sequence DESC LIMIT 1
      `).get(workerId, operationId);
      const policies = JSON.stringify(this.policyUnion(this.policyBindings(workerId, messageIds, bindings)));
      for (const row of bindings) {
        if (row.final_record_id !== null || row.staged_json !== null) continue;
        if (record?.search_text.trim()) {
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
      const policies = JSON.stringify(this.policyUnion(this.policyBindings(workerId, messageIds, bindings)));
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

  redirect(id: string, destination: WorkerDestination): Promise<boolean> {
    return this.write(() => this.database.query(
      "UPDATE worker_assignments SET destination = ?, destination_kind = ? WHERE assignment_id = ? AND staged_json IS NULL",
    ).run(destination.id, destination.kind, id).changes === 1);
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

  private finalText(recordId: string): string | undefined {
    return this.database.query<{ search_text: string }, [string]>(`
      SELECT m.search_text FROM conversation_records r
      JOIN conversation_messages m ON m.record_row_id = r.row_id WHERE r.record_id = ?
    `).get(recordId)?.search_text;
  }

  stage(id: string): Promise<StagedWorkerAssignment | undefined> {
    return this.write(() => {
      const row = this.row(id);
      if (!row) return;
      if (row.staged_json !== null) return staged(row);
      if (row.final_record_id === null && row.owner_id === this.ownerId) return;
      const finalText = row.final_record_id === null ? undefined : this.finalText(row.final_record_id);
      const outcome: WorkerAssignmentOutcome = row.final_record_id === null
        ? { kind: "uncertain" }
        : finalText?.trim() ? { kind: "result", finalRecordId: row.final_record_id, text: finalText }
          : { kind: "failed", reason: "worker produced no saved result", possiblePartialEffects: true };
      return this.writeStage(row, outcome);
    });
  }

  private writeStage(row: Row, outcome: WorkerAssignmentOutcome): StagedWorkerAssignment {
    const id = row.assignment_id;
    const deliveryId = `worker-result:${id}`;
    const value: StagedWorkerAssignment = {
      assignmentId: id, outcome,
      delivery: {
        id: deliveryId, destination: { id: row.destination, kind: row.destination_kind }, source: row.worker_handle ?? row.worker_id,
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
