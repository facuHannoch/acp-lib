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
  type TranscriptStructuralRecord,
} from "./reducer.ts";
import type {
  InternalSessionHistoryEntry,
  OperationAbortReason,
  OperationKind,
  TranscriptCheckpointRecord,
  TranscriptOperationRecord,
  TranscriptActivityRecord,
  TranscriptMessageRecord,
  TranscriptReasoningRecord,
} from "./records.ts";
import type { PersistedMachineCode } from "./integrity.ts";
import {
  FileSessionLogWriter,
  type FileSessionLogWriterOptions,
  type ResumeTranscriptWriterOptions,
  type SessionLogWriterLock,
} from "./session-log-writer.ts";
import type { TranscriptHeaderRecord } from "./records.ts";
import type {
  PersistenceStateRuntime,
  PresentationPersistenceEvent,
  TranscriptPresentationRecord,
} from "./state-runtime.ts";

export interface TranscriptTerminalCheckpointChanges {
  readonly model?: string | null;
  readonly sessionConfiguration?: SessionConfigurationCheckpoint;
  readonly metering?: AgentSessionCheckpoint["metering"];
  readonly boundary?: AgentSessionBoundary;
  /**
   * Fill in a thread slot the conversation never had.
   *
   * A newly created provider thread is kept in memory until a completed turn justifies
   * selecting it for a later resume; the turn's own terminal checkpoint is what records
   * it, so the response and the thread it came from commit together. Replacing an already
   * selected thread is a transition and is rejected here.
   */
  readonly providerAttachment?: {
    readonly internalSessionId: string;
    readonly activatedAt: string;
  };
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
  /** @internal Ownership transferred from managed creation. */
  readonly writerLock?: SessionLogWriterLock;
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
export class TranscriptPersistenceRuntime implements PersistenceStateRuntime {
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
  /**
   * Writes run one at a time: each picks its sequence number from the writer when it runs, so two
   * overlapping callers would otherwise claim the same number and the second would fail the transcript.
   */
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private checkpointPublisher: ((
    checkpoint: AgentSessionCheckpoint,
    history: readonly InternalSessionHistoryEntry[],
  ) => Promise<void>) | null = null;
  /**
   * Each presentation item's first position and time. An item's id names its operation and a
   * revision from another operation is refused, so an item never outlives its operation: entries
   * are dropped when it ends.
   */
  private readonly presentationStates = new Map<string, {
    readonly position: number;
    readonly startedAt: number;
    readonly revision: number;
    readonly kind: PresentationPersistenceEvent["kind"];
    readonly operationId: string;
  }>();

  private constructor(
    private readonly writer: FileSessionLogWriter<"transcript">,
    private readonly header: Awaited<ReturnType<typeof FileSessionLogWriter.resumeTranscript>>["scan"]["header"],
    selectedCheckpointRecord: TranscriptCheckpointRecord,
    history: TranscriptHistoryReduction,
    checkpoint: AgentSessionCheckpoint,
    recovery: SessionRecoveryStatus,
    repairs: readonly PersistenceRepair[],
    private readonly conversationWasTruncated: boolean,
    private openingStructuralTail: readonly TranscriptStructuralRecord[],
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
      writerLock: options.writerLock,
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
        [],
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
      let structuralTail = scan.structuralTailAfterSelectedCheckpoint;
      if (scan.reduction.repairs.length > 0) {
        const record = checkpointRecord(writer.nextSequence, checkpoint, scan.header);
        await writer.append(record, { durable: true });
        selected = record;
        history = reduceInternalSessionHistory(scan.reduction.internalSessionHistory);
        structuralTail = [];
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
        structuralTail,
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

  get internalSessionHistory(): readonly InternalSessionHistoryEntry[] {
    return this.history.entries.map((entry) => structuredClone(entry));
  }

  /** @internal Attach the managed registry projection after creation finalizes. */
  setCheckpointPublisher(
    publisher: (
      checkpoint: AgentSessionCheckpoint,
      history: readonly InternalSessionHistoryEntry[],
    ) => Promise<void>,
  ): void {
    if (this.checkpointPublisher) {
      throw new TranscriptRuntimeStateError("managed checkpoint publisher is already attached");
    }
    this.checkpointPublisher = publisher;
  }

  beginOperation(operationId: string, kind: OperationKind, ts = Date.now()): Promise<void> {
    return this.exclusive(() => this.beginOperationNow(operationId, kind, ts));
  }

  private async beginOperationNow(operationId: string, kind: OperationKind, ts = Date.now()): Promise<void> {
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
    try {
      await this.publishManagedCheckpoint();
    } catch (error) {
      // Registry publication is part of the managed pre-dispatch boundary. Close the
      // transcript operation truthfully before reporting failure to the caller.
      await this.abortOperationNow("pre_dispatch_persistence_failure").catch(() => undefined);
      throw error;
    }
  }

  appendEvent(event: NormalizedPersistenceEvent, ts = Date.now()): Promise<boolean> {
    return this.exclusive(() => this.appendEventNow(event, ts));
  }

  private async appendEventNow(event: NormalizedPersistenceEvent, ts = Date.now()): Promise<boolean> {
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

  appendPresentationEvent(
    event: PresentationPersistenceEvent,
    ts = Date.now(),
  ): Promise<TranscriptPresentationRecord | null> {
    return this.exclusive(() => this.appendPresentationEventNow(event, ts));
  }

  private async appendPresentationEventNow(
    event: PresentationPersistenceEvent,
    ts = Date.now(),
  ): Promise<TranscriptPresentationRecord | null> {
    this.assertUsable();
    if (!event.presentation) {
      throw new TranscriptRuntimeStateError("presentation event requires identity and revision");
    }
    const existing = this.presentationStates.get(event.presentation.id);
    if (existing && (existing.kind !== event.kind
      || existing.operationId !== presentationOperationId(event)
      || existing.revision >= event.presentation.revision)) {
      throw new TranscriptRuntimeStateError(`invalid presentation revision for ${event.presentation.id}`);
    }
    const position = existing?.position ?? this.writer.nextSequence;
    const positioned = {
      ...event,
      presentation: { ...event.presentation, position },
    } as PresentationPersistenceEvent;
    const record = projectTranscriptEvent(positioned, {
      transcriptId: this.header.transcriptId,
      generation: this.header.generation,
      agentSessionId: this.header.agentSessionId,
      seq: this.writer.nextSequence,
      ts,
      policy: this.header.effectivePolicy,
    });
    if (!record) return null;
    if (!isTranscriptPresentationRecord(record)) {
      throw new TranscriptRuntimeStateError("presentation event projected to a non-presentation record");
    }
    try {
      await this.writer.append(record);
      this.presentationStates.set(event.presentation.id, {
        position,
        startedAt: existing?.startedAt ?? ts,
        revision: event.presentation.revision,
        kind: event.kind,
        operationId: presentationOperationId(event),
      });
      return structuredClone(record);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  appendTransitionEvent(
    event: NonActivationTransitionEvent,
    options: { readonly durable?: boolean; readonly ts?: number } = {},
  ): Promise<void> {
    return this.exclusive(() => this.appendTransitionEventNow(event, options));
  }

  private async appendTransitionEventNow(
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
  publishCheckpoint(
    changes: TranscriptTerminalCheckpointChanges,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    return this.exclusive(() => this.publishCheckpointNow(changes, ts));
  }

  private async publishCheckpointNow(
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
      await this.publishManagedCheckpoint();
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  activateTransition(
    event: TargetActivationEvent,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    return this.exclusive(() => this.activateTransitionNow(event, ts));
  }

  private async activateTransitionNow(
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
      await this.publishManagedCheckpoint();
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /** Flush policy-projected input appended after beginOperation before provider dispatch. */
  syncBeforeDispatch(): Promise<void> {
    return this.exclusive(() => this.syncBeforeDispatchNow());
  }

  private async syncBeforeDispatchNow(): Promise<void> {
    this.assertUsable();
    this.requireActive();
    await this.writer.sync();
  }

  finishOperation(
    event: "settled" | "failed" | "cancelled" | "interrupted",
    changes: TranscriptTerminalCheckpointChanges = {},
    errorCode?: PersistedMachineCode,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    return this.exclusive(() => this.finishOperationNow(event, changes, errorCode, ts));
  }

  private async finishOperationNow(
    event: "settled" | "failed" | "cancelled" | "interrupted",
    changes: TranscriptTerminalCheckpointChanges = {},
    errorCode?: PersistedMachineCode,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    this.assertUsable();
    const active = this.requireActive();
    if (changes.providerAttachment && this._checkpoint.internalSessionId !== null) {
      throw new TranscriptRuntimeStateError(
        "replacing a selected provider thread is a transition, not a terminal checkpoint change",
      );
    }
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
        ...(changes.providerAttachment === undefined ? {} : {
          internalSessionId: changes.providerAttachment.internalSessionId,
          internalSessionActivatedAt: changes.providerAttachment.activatedAt,
        }),
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
      this.forgetPresentation(active.operationId);
      await this.publishManagedCheckpoint();
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  abortOperation(
    reason: OperationAbortReason,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    return this.exclusive(() => this.abortOperationNow(reason, ts));
  }

  private async abortOperationNow(
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
      this.forgetPresentation(active.operationId);
      await this.publishManagedCheckpoint();
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Durably acknowledge an uncertain provider boundary without claiming its outcome.
   *
   * The interrupted terminal closes a boundary that had no terminal. When a terminal was
   * already durable, only its missing checkpoint is materialized. The canonical reducer
   * validates the complete opening tail before the runtime exposes clean state.
   */
  acceptHarnessRecovery(ts = Date.now()): Promise<AgentSessionCheckpoint> {
    return this.exclusive(() => this.acceptHarnessRecoveryNow(ts));
  }

  private async acceptHarnessRecoveryNow(ts = Date.now()): Promise<AgentSessionCheckpoint> {
    this.assertUsable();
    if (this.activeOperation) throw new TranscriptRuntimeStateError("cannot resolve recovery during an active operation");
    if (this._recovery.kind !== "uncertain") {
      throw new TranscriptRuntimeStateError("recovery resolution requires an uncertain transcript boundary");
    }
    const recovery = this._recovery;
    const tail = this.openingStructuralTail.map((record) => structuredClone(record));
    let coveredSequence: number;
    try {
      if (recovery.boundary === "terminal_without_checkpoint") {
        const terminal = [...tail].reverse().find((record) =>
          record.t === "operation"
          && record.operationId === recovery.operationId
          && record.event !== "started");
        if (!terminal) {
          throw new TranscriptRuntimeStateError("uncertain terminal boundary has no durable terminal record");
        }
        coveredSequence = terminal.seq;
      } else {
        const terminal: TranscriptOperationRecord = {
          ...this.envelope(this.writer.nextSequence, ts),
          t: "operation",
          operationId: recovery.operationId,
          operationKind: operationKindForRecovery(this.selectedCheckpointRecord, tail, recovery.operationId),
          event: "interrupted",
          errorCode: "recovery_accepted_harness_state",
        };
        await this.writer.append(terminal);
        tail.push(terminal);
        coveredSequence = terminal.seq;
      }
      const next = createAgentSessionCheckpoint({
        ...checkpointInput(this._checkpoint),
        stateRevision: this._checkpoint.stateRevision + 1,
        transcript: { ...this._checkpoint.transcript!, coveredSequence },
        boundary: { status: "settled", lastSettledOperationId: recovery.operationId },
        updatedAt: timestampToIso(ts),
      });
      const physical = checkpointRecord(this.writer.nextSequence, next, this.header);
      await this.writer.append(physical, { durable: true });
      tail.push(physical);
      const reduced = reduceTranscriptState(this.selectedCheckpointRecord, this.history, tail);
      if (reduced.recovery.kind !== "clean") {
        throw new TranscriptRuntimeStateError("recovery acknowledgement did not produce a clean boundary");
      }
      this.installCheckpoint(physical, reduced.checkpoint, reduced.recovery, reduced.internalSessionHistory);
      this.openingStructuralTail = [];
      await this.publishManagedCheckpoint();
      await this.appendEventNow({
        kind: "lifecycle",
        event: "recovery_resolved",
        detail: {
          strategy: "accept_harness_state",
          operationId: recovery.operationId,
          priorBoundary: recovery.boundary,
        },
      });
      return this.checkpoint;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Writes already requested still land; anything requested after this is refused.
    await this.serial;
    if (this.closed) return;
    this.closed = true;
    await this.writer.close();
  }

  presentationStartedAt(presentationId: string): number | undefined {
    return this.presentationStates.get(presentationId)?.startedAt;
  }

  private forgetPresentation(operationId: string): void {
    for (const [id, state] of this.presentationStates) {
      if (state.operationId === operationId) this.presentationStates.delete(id);
    }
  }

  private exclusive<T>(write: () => Promise<T>): Promise<T> {
    const run = this.serial.then(write);
    this.serial = run.catch(() => undefined);
    return run;
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

  private async publishManagedCheckpoint(): Promise<void> {
    await this.checkpointPublisher?.(this.checkpoint, this.internalSessionHistory);
  }
}

function isTranscriptPresentationRecord(
  record: ReturnType<typeof projectTranscriptEvent>,
): record is TranscriptMessageRecord | TranscriptReasoningRecord | TranscriptActivityRecord {
  return record !== null
    && (record.t === "message" || record.t === "reasoning" || record.t === "activity");
}

function presentationOperationId(event: PresentationPersistenceEvent): string {
  return event.kind === "activity" ? event.activity.operationId : event.operationId;
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

function operationKindForRecovery(
  selected: TranscriptCheckpointRecord,
  tail: readonly TranscriptStructuralRecord[],
  operationId: string,
): OperationKind {
  const started = [...tail].reverse().find((record) =>
    record.t === "operation" && record.operationId === operationId && record.event === "started");
  if (started?.t === "operation") return started.operationKind;
  // An in-flight materialized checkpoint can be selected after its started record. Its
  // exact kind is presentation metadata, not continuation state; use the explicit
  // catch-all rather than guessing a user prompt.
  if (selected.checkpoint.boundary.status === "in_flight"
    && selected.checkpoint.boundary.interruptedOperationId === operationId) return "other";
  throw new TranscriptRuntimeStateError("cannot identify the uncertain operation kind");
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
