import { createAgentSessionCheckpoint, type AgentSessionCheckpoint } from "./checkpoint.ts";
import type { NormalizedPersistenceEvent } from "./projection.ts";
import type { InternalSessionHistoryEntry, OperationKind } from "./records.ts";
import type { OperationAbortReason } from "./records.ts";
import { sha256CanonicalJson } from "./integrity.ts";
import type { PersistenceRepair, SessionRecoveryStatus } from "./reducer.ts";
import type { TranscriptTerminalCheckpointChanges } from "./transcript-runtime.ts";
import type { PersistedMachineCode } from "./integrity.ts";
import type { TranscriptPresentationRecord } from "./presentation.ts";

type TransitionEvent = Extract<NormalizedPersistenceEvent, { kind: "transition" }>;
export type PresentationPersistenceEvent = Extract<
  NormalizedPersistenceEvent,
  { kind: "message" | "reasoning" | "activity" }
>;
export type { TranscriptPresentationRecord } from "./presentation.ts";

export interface PersistenceStateRuntime {
  readonly checkpoint: AgentSessionCheckpoint;
  readonly recovery: SessionRecoveryStatus;
  readonly openingRepairs: readonly PersistenceRepair[];
  readonly conversationAvailability: "available" | "partial" | "not_captured";
  readonly healthy: boolean;
  readonly internalSessionHistory: readonly InternalSessionHistoryEntry[];
  setCheckpointPublisher(publisher: (checkpoint: AgentSessionCheckpoint, history: readonly InternalSessionHistoryEntry[]) => Promise<void>): void;
  beginOperation(operationId: string, kind: OperationKind, ts?: number): Promise<void>;
  appendEvent(event: NormalizedPersistenceEvent, ts?: number): Promise<boolean>;
  appendPresentationEvent(
    event: PresentationPersistenceEvent,
    ts?: number,
  ): Promise<TranscriptPresentationRecord | null>;
  appendTransitionEvent(event: Omit<TransitionEvent, "event"> & { readonly event: Exclude<TransitionEvent["event"], "target_activated"> }, options?: { readonly durable?: boolean; readonly ts?: number }): Promise<void>;
  publishCheckpoint(changes: TranscriptTerminalCheckpointChanges, ts?: number): Promise<AgentSessionCheckpoint>;
  activateTransition(event: Omit<TransitionEvent, "event"> & { readonly event: "target_activated" }, ts?: number): Promise<AgentSessionCheckpoint>;
  syncBeforeDispatch(): Promise<void>;
  finishOperation(event: "settled" | "failed" | "cancelled" | "interrupted", changes?: TranscriptTerminalCheckpointChanges, errorCode?: PersistedMachineCode, ts?: number): Promise<AgentSessionCheckpoint>;
  abortOperation(reason: OperationAbortReason, ts?: number): Promise<AgentSessionCheckpoint>;
  acceptHarnessRecovery(ts?: number): Promise<AgentSessionCheckpoint>;
  close(): Promise<void>;
}

/** Registry-only checkpoint state. Publication is the durable boundary. */
export class RegistryPersistenceRuntime implements PersistenceStateRuntime {
  private current: AgentSessionCheckpoint;
  private history: readonly InternalSessionHistoryEntry[];
  private active: { readonly operationId: string; readonly kind: OperationKind } | null = null;
  private publisher: ((checkpoint: AgentSessionCheckpoint, history: readonly InternalSessionHistoryEntry[]) => Promise<void>) | null = null;
  private failed = false;

  constructor(checkpoint: AgentSessionCheckpoint, history: readonly InternalSessionHistoryEntry[] = []) {
    if (checkpoint.transcript !== null) throw new Error("registry runtime requires a registry-only checkpoint");
    this.current = structuredClone(checkpoint);
    this.history = Object.freeze(history.map((entry) => structuredClone(entry)));
  }

  get checkpoint() { return structuredClone(this.current); }
  get recovery() { return { kind: "clean" } as const; }
  get openingRepairs() { return []; }
  get conversationAvailability() { return "not_captured" as const; }
  get healthy() { return !this.failed; }
  get internalSessionHistory() { return this.history.map((entry) => structuredClone(entry)); }

  setCheckpointPublisher(publisher: (checkpoint: AgentSessionCheckpoint, history: readonly InternalSessionHistoryEntry[]) => Promise<void>): void {
    if (this.publisher) throw new Error("managed checkpoint publisher is already attached");
    this.publisher = publisher;
  }

  async beginOperation(operationId: string, kind: OperationKind, ts = Date.now()): Promise<void> {
    if (this.active) throw new Error("another persistence operation is already active");
    const previous = this.current;
    this.active = { operationId, kind };
    this.current = nextCheckpoint(previous, {
      boundary: {
        status: "in_flight",
        lastSettledOperationId: previous.boundary.status === "settled"
          ? previous.boundary.lastSettledOperationId
          : previous.boundary.lastSettledOperationId,
        interruptedOperationId: operationId,
        cause: "operation_started",
      },
    }, ts);
    try { await this.publish(); } catch (error) {
      this.active = null;
      this.current = previous;
      this.failed = true;
      throw error;
    }
  }

  async appendEvent(): Promise<boolean> { return false; }
  async appendPresentationEvent(): Promise<null> { return null; }
  async appendTransitionEvent(): Promise<void> {}
  async syncBeforeDispatch(): Promise<void> {}

  async publishCheckpoint(changes: TranscriptTerminalCheckpointChanges, ts = Date.now()): Promise<AgentSessionCheckpoint> {
    this.current = nextCheckpoint(this.current, changes, ts);
    await this.publish();
    return this.checkpoint;
  }

  async activateTransition(event: Omit<TransitionEvent, "event"> & { readonly event: "target_activated" }): Promise<AgentSessionCheckpoint> {
    if (!event.to || !event.activationState) throw new Error("registry transition activation requires target state");
    if (event.historyEntry) this.history = Object.freeze([...this.history, structuredClone(event.historyEntry)]);
    const state = event.activationState;
    const { version: _version, digest: _digest, ...input } = this.current;
    this.current = createAgentSessionCheckpoint({
      ...input,
      stateRevision: state.resultingStateRevision,
      adapterId: event.to.adapterId,
      mode: event.to.mode,
      internalSessionId: event.to.internalSessionId,
      internalSessionActivatedAt: event.to.activatedAt,
      internalSessionHistoryRevision: this.history.length,
      internalSessionHistoryDigest: sha256CanonicalJson(this.history),
      lastTransition: {
        transitionId: event.transitionId,
        kind: event.transitionKind,
        at: state.transitionAt,
      },
      model: event.to.model,
      sessionConfiguration: event.to.sessionConfiguration,
      protocol: event.to.protocol,
      transcript: null,
      boundary: state.boundary,
      updatedAt: state.updatedAt,
    });
    await this.publish();
    return this.checkpoint;
  }

  async finishOperation(
    _event: "settled" | "failed" | "cancelled" | "interrupted",
    changes: TranscriptTerminalCheckpointChanges = {},
    _errorCode?: string,
    ts = Date.now(),
  ): Promise<AgentSessionCheckpoint> {
    const active = this.requireActive();
    this.current = nextCheckpoint(this.current, {
      ...changes,
      boundary: changes.boundary ?? { status: "settled", lastSettledOperationId: active.operationId },
    }, ts);
    this.active = null;
    await this.publish();
    return this.checkpoint;
  }

  async abortOperation(_reason: OperationAbortReason, ts = Date.now()): Promise<AgentSessionCheckpoint> {
    const active = this.requireActive();
    this.current = nextCheckpoint(this.current, {
      boundary: { status: "settled", lastSettledOperationId: active.operationId },
    }, ts);
    this.active = null;
    await this.publish();
    return this.checkpoint;
  }

  async acceptHarnessRecovery(): Promise<AgentSessionCheckpoint> { return this.checkpoint; }
  async close(): Promise<void> {}

  private requireActive() {
    if (!this.active) throw new Error("no persistence operation is active");
    return this.active;
  }

  private async publish(): Promise<void> {
    if (!this.publisher) return;
    try { await this.publisher(this.checkpoint, this.internalSessionHistory); }
    catch (error) { this.failed = true; throw error; }
  }
}

function nextCheckpoint(
  source: AgentSessionCheckpoint,
  changes: TranscriptTerminalCheckpointChanges,
  ts: number,
): AgentSessionCheckpoint {
  const { version: _version, digest: _digest, ...input } = source;
  return createAgentSessionCheckpoint({
    ...input,
    ...(changes.model === undefined ? {} : { model: changes.model }),
    ...(changes.sessionConfiguration === undefined ? {} : { sessionConfiguration: changes.sessionConfiguration }),
    ...(changes.metering === undefined ? {} : { metering: changes.metering }),
    stateRevision: source.stateRevision + 1,
    boundary: changes.boundary ?? source.boundary,
    updatedAt: new Date(ts).toISOString(),
  });
}
