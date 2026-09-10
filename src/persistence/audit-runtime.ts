import type { AgentSessionCheckpoint } from "./checkpoint.ts";
import { projectAuditEvent, type NormalizedPersistenceEvent } from "./projection.ts";
import type { InternalSessionHistoryEntry, OperationAbortReason, OperationKind, AuditLogHeaderRecord } from "./records.ts";
import type { PersistedMachineCode } from "./integrity.ts";
import type { PersistenceRepair } from "./reducer.ts";
import type { PersistenceStateRuntime, PresentationPersistenceEvent } from "./state-runtime.ts";
import type { TranscriptTerminalCheckpointChanges } from "./transcript-runtime.ts";
import { FileSessionLogWriter, type SessionLogWriterLock } from "./session-log-writer.ts";

type TransitionEvent = Extract<NormalizedPersistenceEvent, { kind: "transition" }>;

export interface AuditLogIdentity {
  readonly path: string;
  readonly auditLogId: string;
  readonly generation: number;
  readonly header: AuditLogHeaderRecord;
}

export class AuditPersistenceRuntime {
  private failed = false;

  private constructor(
    private readonly writer: FileSessionLogWriter<"audit">,
    readonly identity: AuditLogIdentity,
  ) {}

  static async create(options: {
    readonly path: string;
    readonly header: AuditLogHeaderRecord;
    readonly writerLock?: SessionLogWriterLock;
  }): Promise<AuditPersistenceRuntime> {
    const writer = await FileSessionLogWriter.create({
      kind: "audit",
      path: options.path,
      header: options.header,
      maxRecordBytes: options.header.effectiveLimits.maxRecordBytes,
      writerLock: options.writerLock,
    });
    return new AuditPersistenceRuntime(writer, {
      path: options.path,
      auditLogId: options.header.auditLogId,
      generation: options.header.generation,
      header: structuredClone(options.header),
    });
  }

  static async resume(options: {
    readonly path: string;
    readonly agentSessionId: string;
    readonly auditLogId: string;
    readonly generation: number;
    readonly writerLock?: SessionLogWriterLock;
  }): Promise<AuditPersistenceRuntime> {
    const { writer, header } = await FileSessionLogWriter.resumeAuditLog({
      path: options.path,
      expected: {
        agentSessionId: options.agentSessionId,
        auditLogId: options.auditLogId,
        generation: options.generation,
      },
      writerLock: options.writerLock,
    });
    return new AuditPersistenceRuntime(writer, {
      path: options.path, auditLogId: options.auditLogId,
      generation: options.generation, header,
    });
  }

  get healthy(): boolean { return !this.failed; }

  async append(event: NormalizedPersistenceEvent, durable = false, ts = Date.now()): Promise<boolean> {
    const record = projectAuditEvent(event, {
      auditLogId: this.identity.auditLogId,
      generation: this.identity.generation,
      agentSessionId: this.identity.header.agentSessionId,
      seq: this.writer.nextSequence,
      ts,
      policy: this.identity.header.effectivePolicy,
    });
    if (!record) return false;
    try {
      await this.writer.append(record, { durable });
      return true;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async sync(): Promise<void> { await this.writer.sync(); }
  async close(): Promise<void> { await this.writer.close(); }
}

/** Apply one normalized event stream to continuation state and its separate audit sink. */
export class AuditedPersistenceRuntime implements PersistenceStateRuntime {
  private active: { readonly operationId: string; readonly kind: OperationKind } | null = null;
  constructor(
    private readonly primary: PersistenceStateRuntime,
    readonly audit: AuditPersistenceRuntime,
  ) {}

  get checkpoint() { return this.primary.checkpoint; }
  get recovery() { return this.primary.recovery; }
  get openingRepairs(): readonly PersistenceRepair[] { return this.primary.openingRepairs; }
  get conversationAvailability() { return this.primary.conversationAvailability; }
  get healthy() { return this.primary.healthy && this.audit.healthy; }
  get internalSessionHistory() { return this.primary.internalSessionHistory; }
  setCheckpointPublisher(publisher: (checkpoint: AgentSessionCheckpoint, history: readonly InternalSessionHistoryEntry[]) => Promise<void>) { this.primary.setCheckpointPublisher(publisher); }

  async beginOperation(operationId: string, kind: OperationKind, ts = Date.now()): Promise<void> {
    await this.primary.beginOperation(operationId, kind, ts);
    try {
      await this.audit.append({ kind: "operation", event: "started", operationId, operationKind: kind }, true, ts);
      this.active = { operationId, kind };
    } catch (error) {
      await this.primary.abortOperation("pre_dispatch_persistence_failure", ts).catch(() => undefined);
      throw error;
    }
  }

  async appendEvent(event: NormalizedPersistenceEvent, ts = Date.now()): Promise<boolean> {
    const [primary, audit] = await Promise.all([
      this.primary.appendEvent(event, ts),
      this.audit.append(event, false, ts),
    ]);
    return primary || audit;
  }

  async appendPresentationEvent(event: PresentationPersistenceEvent, ts = Date.now()) {
    const [primary] = await Promise.all([
      this.primary.appendPresentationEvent(event, ts),
      this.audit.append(event, false, ts),
    ]);
    return primary;
  }

  async appendTransitionEvent(event: Omit<TransitionEvent, "event"> & { readonly event: Exclude<TransitionEvent["event"], "target_activated"> }, options: { readonly durable?: boolean; readonly ts?: number } = {}): Promise<void> {
    const ts = options.ts ?? Date.now();
    await this.primary.appendTransitionEvent(event, options);
    await this.audit.append(event, options.durable ?? true, ts);
  }

  async publishCheckpoint(changes: TranscriptTerminalCheckpointChanges, ts?: number) { return await this.primary.publishCheckpoint(changes, ts); }
  async activateTransition(event: Omit<TransitionEvent, "event"> & { readonly event: "target_activated" }, ts = Date.now()) {
    const checkpoint = await this.primary.activateTransition(event, ts);
    await this.audit.append(event, true, ts);
    return checkpoint;
  }
  async syncBeforeDispatch() { await this.primary.syncBeforeDispatch(); await this.audit.sync(); }

  async finishOperation(event: "settled" | "failed" | "cancelled" | "interrupted", changes: TranscriptTerminalCheckpointChanges = {}, errorCode?: PersistedMachineCode, ts = Date.now()) {
    const active = this.active;
    if (!active) throw new Error("no audited persistence operation is active");
    const checkpoint = await this.primary.finishOperation(event, changes, errorCode, ts);
    await this.audit.append({ kind: "operation", event, operationId: active.operationId, operationKind: active.kind, ...(errorCode ? { errorCode } : {}) }, true, ts);
    this.active = null;
    return checkpoint;
  }

  async abortOperation(reason: OperationAbortReason, ts = Date.now()) {
    const active = this.active;
    if (!active) throw new Error("no audited persistence operation is active");
    const checkpoint = await this.primary.abortOperation(reason, ts);
    await this.audit.append({ kind: "operation", event: "aborted", operationId: active.operationId, operationKind: active.kind, abortReason: reason }, true, ts);
    this.active = null;
    return checkpoint;
  }
  async acceptHarnessRecovery(ts?: number) { return await this.primary.acceptHarnessRecovery(ts); }
  async close() { await Promise.all([this.primary.close(), this.audit.close()]); }
}
