import {
  createAgentSessionCheckpoint,
  type AgentSessionBoundary,
  type AgentSessionCheckpoint,
  type AgentSessionCheckpointInput,
  type SessionConfigurationCheckpoint,
} from "./checkpoint.ts";
import { projectTranscriptEvent, type NormalizedPersistenceEvent } from "./projection.ts";
import {
  reduceInternalSessionHistory,
  reduceTranscriptState,
  type PersistenceRepair,
  type SessionRecoveryStatus,
  type TranscriptHistoryReduction,
} from "./reducer.ts";
import type {
  InternalSessionHistoryEntry,
  OperationAbortReason,
  OperationKind,
  TranscriptCheckpointRecord,
  TranscriptOperationRecord,
} from "./records.ts";
import type { PersistedMachineCode } from "./integrity.ts";
import {
  FileSessionLogWriter,
  type FileSessionLogWriterOptions,
  type ResumeTranscriptWriterOptions,
} from "./session-log-writer.ts";
import type { TranscriptHeaderRecord } from "./records.ts";

export interface TranscriptTerminalCheckpointChanges {
  readonly model?: string | null;
  readonly sessionConfiguration?: SessionConfigurationCheckpoint;
  readonly metering?: AgentSessionCheckpoint["metering"];
  readonly boundary?: AgentSessionBoundary;
}

type NormalizedTransitionEvent = Extract<NormalizedPersistenceEvent, { kind: "transition" }>;
type TargetActivationEvent = Omit<NormalizedTransitionEvent, "event"> & {
  readonly event: "target_activated";
};
type NonActivationTransitionEvent = Omit<NormalizedTransitionEvent, "event"> & {
  readonly event: Exclude<NormalizedTransitionEvent["event"], "target_activated">;
};

export interface CreateTranscriptRuntimeOptions {
  readonly path: string;
  readonly header: TranscriptHeaderRecord;
  /** Supplied directly by transaction coordinators that already established the target. */
  readonly checkpoint?: AgentSessionCheckpoint;
  /**
   * Called only after the transcript header and ownership lock are durable. Live-session
   * creation uses this to establish the provider thread without a dispatch-before-WAL gap.
   */
  readonly initializeCheckpoint?: () => Promise<AgentSessionCheckpoint>;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

export class TranscriptRuntimeStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptRuntimeStateError";
  }
}

/**
 * Live v2 transcript state machine. It is deliberately provider-agnostic: callers own
 * dispatch, while this object owns the durable-before-dispatch and terminal boundaries.
 */
export class TranscriptPersistenceRuntime {
  private selectedCheckpointRecord: TranscriptCheckpointRecord;
  private history: TranscriptHistoryReduction;
  private _checkpoint: AgentSessionCheckpoint;
  private _recovery: SessionRecoveryStatus;
  private readonly _openingRepairs: readonly PersistenceRepair[];
  private activeOperation: {
    operationId: string;
    kind: OperationKind;
    started: TranscriptOperationRecord;
  } | null = null;
  private failure: Error | null = null;
  private closed = false;

  private constructor(
    private readonly writer: FileSessionLogWriter<"transcript">,
    private readonly header: Awaited<ReturnType<typeof FileSessionLogWriter.resumeTranscript>>["scan"]["header"],
    selectedCheckpointRecord: TranscriptCheckpointRecord,
    history: TranscriptHistoryReduction,
    checkpoint: AgentSessionCheckpoint,
    recovery: SessionRecoveryStatus,
    repairs: readonly PersistenceRepair[],
    private readonly conversationWasTruncated: boolean,
  ) {
    this.selectedCheckpointRecord = selectedCheckpointRecord;
    this.history = history;
    this._checkpoint = checkpoint;
    this._recovery = recovery;
    this._openingRepairs = Object.freeze([...repairs]);
  }

  /**
   * Install a new transcript generation and its initial continuation checkpoint.
   *
   * Creation transaction ownership remains with the caller: if this method fails after
   * installing the header, the caller may remove the destination only when the header's
   * installation provenance proves that it belongs to that same prepared transaction.
   */
  static async create(options: CreateTranscriptRuntimeOptions): Promise<TranscriptPersistenceRuntime> {
    if ((options.checkpoint === undefined) === (options.initializeCheckpoint === undefined)) {
      throw new TranscriptRuntimeStateError("transcript creation requires exactly one checkpoint source");
    }
    if (options.checkpoint) assertInitialCheckpoint(options.header, options.path, options.checkpoint);
    const writerOptions: FileSessionLogWriterOptions<"transcript"> = {
      kind: "transcript",
      path: options.path,
      header: options.header,
      maxRecordBytes: options.header.effectiveLimits.maxRecordBytes,
      lockTimeoutMs: options.lockTimeoutMs,
      lockRetryMs: options.lockRetryMs,
    };
    const writer = await FileSessionLogWriter.create(writerOptions);
    try {
      const checkpoint = options.checkpoint ?? await options.initializeCheckpoint!();
      assertInitialCheckpoint(options.header, options.path, checkpoint);
      const physical = checkpointRecord(writer.nextSequence, checkpoint, options.header);
      await writer.append(physical, { durable: true });
      const history = reduceInternalSessionHistory([]);
      const reduced = reduceTranscriptState(physical, history, []);
      if (reduced.recovery.kind !== "clean") {
        throw new TranscriptRuntimeStateError("initial transcript checkpoint must be settled");
      }
      return new TranscriptPersistenceRuntime(
        writer,
        options.header,
        physical,
        history,
        reduced.checkpoint,
        reduced.recovery,
        [],
        false,
      );
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  }

  static async resume(options: ResumeTranscriptWriterOptions): Promise<TranscriptPersistenceRuntime> {
    const { writer, scan } = await FileSessionLogWriter.resumeTranscript(options);
    try {
      let selected = scan.selectedCheckpointRecord;
      let history = scan.historyAtSelectedCheckpoint;
      let checkpoint = scan.reduction.checkpoint;
      if (scan.reduction.repairs.length > 0) {
        const record = checkpointRecord(writer.nextSequence, checkpoint, scan.header);
        await writer.append(record, { durable: true });
        selected = record;
        history = reduceInternalSessionHistory(scan.reduction.internalSessionHistory);
      }
      return new TranscriptPersistenceRuntime(
        writer,
        scan.header,
        selected,
        history,
        checkpoint,
        scan.reduction.recovery,
        scan.reduction.repairs,
        scan.conversationTruncated,
      );
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  }

  get checkpoint(): AgentSessionCheckpoint {
    return structuredClone(this._checkpoint);
  }

  get recovery(): SessionRecoveryStatus {
    return structuredClone(this._recovery);
  }

  get openingRepairs(): readonly PersistenceRepair[] {
    return this._openingRepairs.map((repair) => structuredClone(repair));
  }

  get conversationAvailability(): "available" | "partial" | "not_captured" {
    if (this.header.effectivePolicy.messages === "none") return "not_captured";
    return this.conversationWasTruncated ? "partial" : "available";
  }

  get healthy(): boolean {
    return this.failure === null;
  }

  get nextSequence(): number {
    return this.writer.nextSequence;
  }

  async beginOperation(operationId: string, kind: OperationKind, ts = Date.now()): Promise<void> {
    this.assertUsable();
    if (this._recovery.kind !== "clean") throw new TranscriptRuntimeStateError("uncertain transcript recovery must be resolved before dispatch");
    if (this.activeOperation) throw new TranscriptRuntimeStateError("another transcript operation is already active");
    const record: TranscriptOperationRecord = {
      ...this.envelope(this.writer.nextSequence, ts),
      t: "operation",
      operationId,
      operationKind: kind,
      event: "started",
      stateRevision: this._checkpoint.stateRevision + 1,
    };
    await this.writer.append(record, { durable: true });
    const reduced = reduceTranscriptState(this.selectedCheckpointRecord, this.history, [record]);
    this._checkpoint = reduced.checkpoint;
    this._recovery = reduced.recovery;
    this.activeOperation = { operationId, kind, started: record };
  }

  async appendEvent(event: NormalizedPersistenceEvent, ts = Date.now()): Promise<boolean> {
    this.assertUsable();
    if (event.kind === "transition") {
      throw new TranscriptRuntimeStateError("transitions require the dedicated transition boundary API");
    }
    const record = projectTranscriptEvent(event, {
      transcriptId: this.header.transcriptId,
      generation: this.header.generation,
      agentSessionId: this.header.agentSessionId,
      seq: this.writer.nextSequence,
      ts,
      policy: this.header.effectivePolicy,
    });
    if (!record) return false;
    try {
      await this.writer.append(record);
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  async appendTransitionEvent(
    event: NonActivationTransitionEvent,
    options: { readonly durable?: boolean; readonly ts?: number } = {},
  ): Promise<void> {
    this.assertUsable();
    if (this.activeOperation) throw new TranscriptRuntimeStateError("a transition phase cannot be recorded during an active provider operation");
    const record = projectTranscriptEvent(event, {
      transcriptId: this.header.transcriptId,
      generation: this.header.generation,
      agentSessionId: this.header.agentSessionId,
      seq: this.writer.nextSequence,
      ts: options.ts ?? Date.now(),
      policy: this.header.effectivePolicy,
    });
    if (!record || record.t !== "transition") throw new TranscriptRuntimeStateError("transition projection did not produce a structural record");
    try {
      await this.writer.append(record, { durable: options.durable ?? true });
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /** Publish resumable non-routing state when no provider operation is active. */
  async publishCheckpoint(
    changes: TranscriptTerminalCheckpointChanges,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    this.assertUsable();
    if (this._recovery.kind !== "clean") {
      throw new TranscriptRuntimeStateError("uncertain transcript recovery must be resolved before checkpoint publication");
    }
    if (this.activeOperation) {
      throw new TranscriptRuntimeStateError("standalone checkpoint cannot publish during an active operation");
    }
    const next = createAgentSessionCheckpoint({
      ...checkpointInput(this._checkpoint),
      ...(changes.model === undefined ? {} : { model: changes.model }),
      ...(changes.sessionConfiguration === undefined
        ? {}
        : { sessionConfiguration: structuredClone(changes.sessionConfiguration) }),
      ...(changes.metering === undefined ? {} : { metering: structuredClone(changes.metering) }),
      stateRevision: this._checkpoint.stateRevision + 1,
      boundary: changes.boundary ?? this._checkpoint.boundary,
      updatedAt: timestampToIso(ts),
    });
    const physical = checkpointRecord(this.writer.nextSequence, next, this.header);
    try {
      await this.writer.append(physical, { durable: true });
      const reduced = reduceTranscriptState(this.selectedCheckpointRecord, this.history, [physical]);
      this.installCheckpoint(physical, reduced.checkpoint, reduced.recovery);
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  async activateTransition(
    event: TargetActivationEvent,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    this.assertUsable();
    if (this._recovery.kind !== "clean") throw new TranscriptRuntimeStateError("uncertain transcript recovery must be resolved before transition activation");
    if (this.activeOperation) throw new TranscriptRuntimeStateError("a transition target cannot activate during an active provider operation");
    const projected = projectTranscriptEvent(event, {
      transcriptId: this.header.transcriptId,
      generation: this.header.generation,
      agentSessionId: this.header.agentSessionId,
      seq: this.writer.nextSequence,
      ts,
      policy: this.header.effectivePolicy,
    });
    if (!projected || projected.t !== "transition") {
      throw new TranscriptRuntimeStateError("target activation projection did not produce a structural record");
    }
    try {
      await this.writer.append(projected, { durable: true });
      const reduced = reduceTranscriptState(this.selectedCheckpointRecord, this.history, [projected]);
      const physical = checkpointRecord(this.writer.nextSequence, reduced.checkpoint, this.header);
      await this.writer.append(physical, { durable: true });
      reduceTranscriptState(this.selectedCheckpointRecord, this.history, [projected, physical]);
      this.installCheckpoint(
        physical,
        reduced.checkpoint,
        reduced.recovery,
        reduced.internalSessionHistory,
      );
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /** Flush policy-projected input appended after beginOperation before provider dispatch. */
  async syncBeforeDispatch(): Promise<void> {
    this.assertUsable();
    this.requireActive();
    await this.writer.sync();
  }

  async finishOperation(
    event: "settled" | "failed" | "cancelled" | "interrupted",
    changes: TranscriptTerminalCheckpointChanges = {},
    errorCode?: PersistedMachineCode,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    this.assertUsable();
    const active = this.requireActive();
    const terminal: TranscriptOperationRecord = {
      ...this.envelope(this.writer.nextSequence, ts),
      t: "operation",
      operationId: active.operationId,
      operationKind: active.kind,
      event,
      ...(errorCode === undefined ? {} : { errorCode }),
    };
    try {
      await this.writer.append(terminal);
      const next = createAgentSessionCheckpoint({
        ...checkpointInput(this._checkpoint),
        ...(changes.model === undefined ? {} : { model: changes.model }),
        ...(changes.sessionConfiguration === undefined
          ? {}
          : { sessionConfiguration: structuredClone(changes.sessionConfiguration) }),
        ...(changes.metering === undefined ? {} : { metering: structuredClone(changes.metering) }),
        stateRevision: this._checkpoint.stateRevision + 1,
        transcript: { ...this._checkpoint.transcript!, coveredSequence: terminal.seq },
        boundary: changes.boundary ?? { status: "settled", lastSettledOperationId: active.operationId },
        updatedAt: timestampToIso(ts),
      });
      const physical = checkpointRecord(this.writer.nextSequence, next, this.header);
      await this.writer.append(physical, { durable: true });
      const reduced = reduceTranscriptState(
        this.selectedCheckpointRecord,
        this.history,
        [active.started, terminal, physical],
      );
      this.installCheckpoint(physical, reduced.checkpoint, reduced.recovery);
      this.activeOperation = null;
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  async abortOperation(
    reason: OperationAbortReason,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    this.assertUsable();
    const active = this.requireActive();
    const aborted: TranscriptOperationRecord = {
      ...this.envelope(this.writer.nextSequence, ts),
      t: "operation",
      operationId: active.operationId,
      operationKind: active.kind,
      event: "aborted",
      abortReason: reason,
      stateRevision: this._checkpoint.stateRevision + 1,
    };
    try {
      await this.writer.append(aborted);
      const reduced = reduceTranscriptState(
        this.selectedCheckpointRecord,
        this.history,
        [active.started, aborted],
      );
      const physical = checkpointRecord(this.writer.nextSequence, reduced.checkpoint, this.header);
      await this.writer.append(physical, { durable: true });
      reduceTranscriptState(
        this.selectedCheckpointRecord,
        this.history,
        [active.started, aborted, physical],
      );
      this.installCheckpoint(physical, reduced.checkpoint, reduced.recovery);
      this.activeOperation = null;
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writer.close();
  }

  private installCheckpoint(
    record: TranscriptCheckpointRecord,
    checkpoint: AgentSessionCheckpoint,
    recovery: SessionRecoveryStatus,
    historyEntries: readonly InternalSessionHistoryEntry[] = this.history.entries,
  ): void {
    this.selectedCheckpointRecord = record;
    this.history = reduceInternalSessionHistory(historyEntries);
    this._checkpoint = checkpoint;
    this._recovery = recovery;
  }

  private envelope(seq: number, ts: number) {
    return {
      v: 2 as const,
      transcriptId: this.header.transcriptId,
      generation: this.header.generation,
      agentSessionId: this.header.agentSessionId,
      seq,
      ts,
    };
  }

  private requireActive() {
    if (!this.activeOperation) throw new TranscriptRuntimeStateError("no transcript operation is active");
    return this.activeOperation;
  }

  private assertUsable(): void {
    if (this.closed) throw new TranscriptRuntimeStateError("transcript persistence runtime is closed");
    if (this.failure) throw new TranscriptRuntimeStateError(`transcript persistence runtime failed: ${this.failure.message}`);
  }
}

function checkpointRecord(
  seq: number,
  checkpoint: AgentSessionCheckpoint,
  header: { transcriptId: string; generation: number; agentSessionId: string },
): TranscriptCheckpointRecord {
  return {
    v: 2,
    t: "checkpoint",
    transcriptId: header.transcriptId,
    generation: header.generation,
    agentSessionId: header.agentSessionId,
    seq,
    ts: Date.parse(checkpoint.updatedAt),
    stateRevision: checkpoint.stateRevision,
    checkpoint,
  };
}

function checkpointInput(checkpoint: AgentSessionCheckpoint): AgentSessionCheckpointInput {
  const { version: _version, digest: _digest, ...input } = checkpoint;
  return structuredClone(input);
}

function timestampToIso(ts: number): string {
  try {
    return new Date(ts).toISOString();
  } catch (error) {
    throw new TranscriptRuntimeStateError(`invalid operation timestamp: ${String(error)}`);
  }
}

function assertInitialCheckpoint(
  header: TranscriptHeaderRecord,
  path: string,
  checkpoint: AgentSessionCheckpoint,
): void {
  if (header.event !== "created" && header.event !== "replaced") {
    throw new TranscriptRuntimeStateError("new transcript generation requires a created or replaced header");
  }
  if (checkpoint.agentSessionId !== header.agentSessionId) {
    throw new TranscriptRuntimeStateError("initial checkpoint agentSessionId disagrees with header");
  }
  if (!checkpoint.transcript) {
    throw new TranscriptRuntimeStateError("initial transcript checkpoint has no transcript identity");
  }
  if (
    checkpoint.transcript.transcriptId !== header.transcriptId ||
    checkpoint.transcript.generation !== header.generation ||
    checkpoint.transcript.path !== path
  ) {
    throw new TranscriptRuntimeStateError("initial checkpoint transcript identity disagrees with header");
  }
  if (checkpoint.transcript.coveredSequence !== header.seq) {
    throw new TranscriptRuntimeStateError("initial checkpoint must cover exactly the transcript header");
  }
  if (checkpoint.internalSessionHistoryRevision !== 0) {
    throw new TranscriptRuntimeStateError("initial checkpoint history must be empty");
  }
  if (checkpoint.boundary.status !== "settled" || checkpoint.boundary.lastSettledOperationId !== null) {
    throw new TranscriptRuntimeStateError("initial checkpoint boundary must be settled with no operation");
  }
}
