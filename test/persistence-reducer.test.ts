import { describe, expect, test } from "bun:test";
import { createAgentSessionCheckpoint, type AgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import { sha256CanonicalJson } from "../src/persistence/integrity.ts";
import {
  EMPTY_HISTORY_DIGEST,
  TranscriptReductionError,
  reduceTranscriptHistory,
  reduceTranscriptState,
} from "../src/persistence/reducer.ts";
import type {
  InternalSessionDescriptor,
  InternalSessionHistoryEntry,
  TranscriptCheckpointRecord,
  TranscriptOperationRecord,
  TranscriptTransitionRecord,
} from "../src/persistence/records.ts";

const BASE_TIME = Date.parse("2026-09-08T12:00:00.000Z");
const PATH = "/tmp/acp-client/transcripts/agent-1.jsonl";

describe("canonical transcript reducer", () => {
  test("folds canonical history independently and validates the selected checkpoint", () => {
    const entry = historyEntry();
    const activation = transitionActivation(3, entry);
    const history = reduceTranscriptHistory([activation]);
    expect(history).toEqual({ entries: [entry], revision: 1, digest: sha256CanonicalJson([entry]) });
    expect(EMPTY_HISTORY_DIGEST).toBe(sha256CanonicalJson([]));

    const invalidBase = checkpointRecord(baseCheckpoint(), 2);
    expect(() => reduceTranscriptState(invalidBase, history, [])).toThrow(TranscriptReductionError);
  });

  test("deterministically rebuilds an uncovered target activation", () => {
    const base = baseCheckpoint();
    const activation = transitionActivation(3, historyEntry());
    const result = reduceTranscriptState(checkpointRecord(base, 2), reduceTranscriptHistory([]), [activation]);
    expect(result.checkpoint.internalSessionId).toBe("provider-2");
    expect(result.checkpoint.transcript?.coveredSequence).toBe(3);
    expect(result.internalSessionHistory).toEqual([historyEntry()]);
    expect(result.repairs).toEqual([{ kind: "activation_checkpoint_rebuilt", transitionId: "switch-1", stateRevision: 2 }]);
    expect(result.recovery).toEqual({ kind: "clean" });

    const materialized = checkpointRecord(result.checkpoint, 4);
    const covered = reduceTranscriptState(checkpointRecord(base, 2), reduceTranscriptHistory([]), [activation, materialized]);
    expect(covered.repairs).toEqual([]);
    expect(covered.checkpoint).toEqual(result.checkpoint);
  });

  test("a terminal checkpoint may fill an empty thread slot but never replace one", () => {
    const base = unattachedCheckpoint();
    const baseRecord = checkpointRecord(base, 2);
    const history = reduceTranscriptHistory([]);
    const started = operation(3, "started", base.stateRevision + 1);
    const settled = operation(4, "settled");

    // The turn that justifies the thread is the turn that records it, so a crash cannot
    // leave a completed response disagreeing with the thread it came from.
    const attached = reduceTranscriptState(baseRecord, history, [
      started,
      settled,
      checkpointRecord(attachedTerminalCheckpoint(
        reduceTranscriptState(baseRecord, history, [started]).checkpoint,
        4,
      ), 5),
    ]);
    expect(attached.checkpoint.internalSessionId).toBe("provider-1");
    expect(attached.checkpoint.internalSessionActivatedAt).toBe(iso(4_000));
    expect(attached.internalSessionHistory).toEqual([]);
    expect(attached.recovery).toEqual({ kind: "clean" });

    // Replacing a thread that is already selected stays a transition.
    const selected = checkpointRecord(baseCheckpoint(), 2);
    const selectedStarted = operation(3, "started", 2);
    expect(() => reduceTranscriptState(selected, history, [
      selectedStarted,
      settled,
      checkpointRecord(attachedTerminalCheckpoint(
        reduceTranscriptState(selected, history, [selectedStarted]).checkpoint,
        4,
        "provider-9",
      ), 5),
    ])).toThrow(TranscriptReductionError);

    // A non-terminal checkpoint cannot attach either.
    expect(() => reduceTranscriptState(baseRecord, history, [
      checkpointRecord(attachedTerminalCheckpoint(base, 2), 3),
    ])).toThrow(TranscriptReductionError);
  });

  test("classifies started and terminal operation boundaries without guessing provider state", () => {
    const baseRecord = checkpointRecord(baseCheckpoint(), 2);
    const started = operation(3, "started", 2);
    const startedOnly = reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [started]);
    expect(startedOnly.checkpoint.boundary).toEqual({
      status: "in_flight", lastSettledOperationId: null,
      interruptedOperationId: "op-1", cause: "operation_started",
    });
    expect(startedOnly.recovery).toEqual({ kind: "uncertain", operationId: "op-1", boundary: "started_without_terminal" });

    const terminal = operation(4, "settled");
    const terminalOnly = reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [started, terminal]);
    expect(terminalOnly.recovery).toEqual({ kind: "uncertain", operationId: "op-1", boundary: "terminal_without_checkpoint" });

    const settled = createCheckpoint({ stateRevision: 3, coveredSequence: 4, updatedAt: iso(2_000), lastSettledOperationId: "op-1" });
    const clean = reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [started, terminal, checkpointRecord(settled, 5)]);
    expect(clean.recovery).toEqual({ kind: "clean" });
  });

  test("requires the physical in-flight checkpoint to equal the started-record projection", () => {
    const baseRecord = checkpointRecord(baseCheckpoint(), 2);
    const started = operation(3, "started", 2);
    const derived = reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [started]).checkpoint;
    const changed = createAgentSessionCheckpoint({ ...withoutDigest(derived), model: "unexplained" });
    expect(() => reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [started, checkpointRecord(changed, 4)]))
      .toThrow(TranscriptReductionError);
    const materialized = reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [started, checkpointRecord(derived, 4)]);
    expect(materialized.recovery).toEqual({ kind: "uncertain", operationId: "op-1", boundary: "in_flight_checkpoint" });
  });

  test("turns a durable pre-dispatch abort into a deterministic settled repair", () => {
    const baseRecord = checkpointRecord(baseCheckpoint(), 2);
    const result = reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [
      operation(3, "started", 2),
      operation(4, "aborted", 3),
    ]);
    expect(result.checkpoint.updatedAt).toBe(iso(2_000));
    expect(result.checkpoint.boundary).toEqual({ status: "settled", lastSettledOperationId: "op-1" });
    expect(result.repairs).toEqual([{ kind: "aborted_checkpoint_rebuilt", operationId: "op-1", stateRevision: 3 }]);
    expect(result.recovery).toEqual({ kind: "clean" });
  });

  test("rejects sequence, identity, descriptor, and deterministic-checkpoint disagreement", () => {
    const baseRecord = checkpointRecord(baseCheckpoint(), 2);
    const started = operation(3, "started", 2);
    expect(() => reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [started, started])).toThrow(TranscriptReductionError);
    expect(() => reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [{ ...started, agentSessionId: "other" }])).toThrow(TranscriptReductionError);

    const badActivation = { ...transitionActivation(3, historyEntry()), from: { ...descriptor("provider-1"), model: "wrong" } };
    expect(() => reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [badActivation])).toThrow(TranscriptReductionError);

    const activation = transitionActivation(3, historyEntry());
    const rebuilt = reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [activation]).checkpoint;
    const disagreement = createAgentSessionCheckpoint({
      ...withoutDigest(rebuilt),
      model: "different",
    });
    expect(() => reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [activation, checkpointRecord(disagreement, 4)]))
      .toThrow(TranscriptReductionError);

    const unexplainedRouting = createAgentSessionCheckpoint({
      ...withoutDigest(baseCheckpoint()), stateRevision: 2, internalSessionId: "provider-other",
      internalSessionActivatedAt: iso(1_000), updatedAt: iso(1_000),
    });
    expect(() => reduceTranscriptState(baseRecord, reduceTranscriptHistory([]), [checkpointRecord(unexplainedRouting, 3)]))
      .toThrow(TranscriptReductionError);
  });
});

function unattachedCheckpoint(): AgentSessionCheckpoint {
  const { version: _version, digest: _digest, ...body } = baseCheckpoint();
  return createAgentSessionCheckpoint({
    ...body,
    internalSessionId: null,
    internalSessionActivatedAt: null,
  });
}

function attachedTerminalCheckpoint(
  previous: AgentSessionCheckpoint,
  coveredSequence: number,
  internalSessionId = "provider-1",
  activatedAt = iso(4_000),
): AgentSessionCheckpoint {
  const { version: _version, digest: _digest, ...body } = previous;
  return createAgentSessionCheckpoint({
    ...body,
    stateRevision: previous.stateRevision + 1,
    internalSessionId,
    internalSessionActivatedAt: activatedAt,
    transcript: { ...previous.transcript!, coveredSequence },
    boundary: { status: "settled", lastSettledOperationId: "op-1" },
    updatedAt: iso(4_000),
  });
}

function baseCheckpoint(): AgentSessionCheckpoint {
  return createCheckpoint({ stateRevision: 1, coveredSequence: 1, updatedAt: iso(0), lastSettledOperationId: null });
}

function createCheckpoint(input: {
  stateRevision: number;
  coveredSequence: number;
  updatedAt: string;
  lastSettledOperationId: string | null;
}): AgentSessionCheckpoint {
  return createAgentSessionCheckpoint({
    agentSessionId: "agent-1", incarnationId: "creation-1", stateRevision: input.stateRevision,
    adapterId: "opencode", mode: "normal", internalSessionId: "provider-1",
    internalSessionActivatedAt: iso(0), internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: EMPTY_HISTORY_DIGEST, model: "model-1",
    sessionConfiguration: configuration(), protocol: { name: "acp", version: 1 },
    transcript: { transcriptId: "transcript-1", generation: 1, path: PATH, coveredSequence: input.coveredSequence },
    boundary: { status: "settled", lastSettledOperationId: input.lastSettledOperationId },
    updatedAt: input.updatedAt,
  });
}

function checkpointRecord(checkpoint: AgentSessionCheckpoint, seq: number): TranscriptCheckpointRecord {
  return { ...envelope(seq), t: "checkpoint", stateRevision: checkpoint.stateRevision, checkpoint };
}

function operation(seq: number, event: TranscriptOperationRecord["event"], stateRevision?: number): TranscriptOperationRecord {
  return {
    ...envelope(seq), t: "operation", operationId: "op-1", operationKind: "prompt", event,
    ...(stateRevision === undefined ? {} : { stateRevision }),
    ...(event === "aborted" ? { abortReason: "pre_dispatch_persistence_failure" as const } : {}),
  };
}

function transitionActivation(seq: number, entry: InternalSessionHistoryEntry): TranscriptTransitionRecord {
  return {
    ...envelope(seq), t: "transition", transitionId: "switch-1", kind: "switch", event: "target_activated",
    from: descriptor("provider-1"), to: descriptor("provider-2", iso(3_000)), historyEntry: entry,
    activationState: {
      resultingStateRevision: 2, updatedAt: iso(3_000), transitionAt: iso(3_000),
      boundary: { status: "settled", lastSettledOperationId: null },
    },
  };
}

function historyEntry(): InternalSessionHistoryEntry {
  return {
    internalSessionId: "provider-1", adapterId: "opencode", model: "model-1",
    sessionConfiguration: configuration(), protocol: { name: "acp", version: 1 },
    activatedAt: iso(0), deactivatedAt: iso(3_000),
    transition: { kind: "switch", transitionId: "switch-1" },
  };
}

function descriptor(internalSessionId: string, activatedAt = iso(0)): InternalSessionDescriptor {
  return {
    internalSessionId, adapterId: "opencode", mode: "normal", model: "model-1",
    sessionConfiguration: configuration(), activatedAt, protocol: { name: "acp", version: 1 },
  };
}

function configuration() {
  return {
    adapterId: "opencode", schemaDigest: null, announcedConfigIds: [], restorationTargets: [],
    effective: {}, omittedConfigIds: [], restorationFidelity: "exact" as const, observedAt: iso(0),
  };
}

function envelope(seq: number) {
  return {
    v: 2 as const, transcriptId: "transcript-1", generation: 1,
    agentSessionId: "agent-1", seq, ts: BASE_TIME + (seq - 2) * 1_000,
  };
}

function iso(offset: number): string {
  return new Date(BASE_TIME + offset).toISOString();
}

function withoutDigest(checkpoint: AgentSessionCheckpoint) {
  const { version: _version, digest: _digest, ...input } = checkpoint;
  return input;
}
