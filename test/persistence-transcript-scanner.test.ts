import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionCheckpoint, type AgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import { TRANSCRIPT_PRESETS } from "../src/persistence/config.ts";
import { EMPTY_HISTORY_DIGEST } from "../src/persistence/reducer.ts";
import type { KnownTranscriptRecord, TranscriptHeaderRecord, TranscriptOperationRecord } from "../src/persistence/records.ts";
import { FileSessionLogWriter } from "../src/persistence/session-log-writer.ts";
import {
  TranscriptCorruptionError,
  TranscriptIdentityError,
  TranscriptNotFoundError,
  scanTranscriptContinuation,
} from "../src/persistence/transcript-scanner.ts";

const roots: string[] = [];
const TS = Date.parse("2026-09-08T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("transcript continuation scanner", () => {
  test("streams a generation, ignores a torn final line, and reduces its structural tail", async () => {
    const path = await transcriptPath();
    const checkpoint = initialCheckpoint(path);
    await writeLines(path, [header(path), checkpointRecord(checkpoint, 2), operation(3, "started", 2)], "{\"v\":2");

    const scan = await scanTranscriptContinuation(path, { agentSessionId: "agent-1" });
    expect(scan.header.t).toBe("header");
    expect(scan.selectedCheckpointRecord.seq).toBe(2);
    expect(scan.lastCompleteSequence).toBe(3);
    expect(scan.ignoredTrailingBytes).toBeGreaterThan(0);
    expect(scan.reduction.recovery).toEqual({
      kind: "uncertain", operationId: "op-1", boundary: "started_without_terminal",
    });
  });

  test("uses successive checkpoints to validate the whole structural chain", async () => {
    const path = await transcriptPath();
    const initial = initialCheckpoint(path);
    const started = operation(3, "started", 2);
    const inFlight = createAgentSessionCheckpoint({
      ...withoutDigest(initial), stateRevision: 2, updatedAt: iso(1_000),
      transcript: { ...initial.transcript!, coveredSequence: 3 },
      boundary: { status: "in_flight", lastSettledOperationId: null, interruptedOperationId: "op-1", cause: "operation_started" },
    });
    const abort = operation(5, "aborted", 3);
    await writeLines(path, [header(path), checkpointRecord(initial, 2), started, checkpointRecord(inFlight, 4), abort]);

    const scan = await scanTranscriptContinuation(path);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
    expect(scan.reduction.repairs).toEqual([{ kind: "aborted_checkpoint_rebuilt", operationId: "op-1", stateRevision: 3 }]);
    expect(scan.reduction.checkpoint.transcript?.coveredSequence).toBe(5);
  });

  test("skips a valid unknown display record without weakening structural reduction", async () => {
    const path = await transcriptPath();
    const checkpoint = initialCheckpoint(path);
    const future = { ...envelope(3), t: "future_display", payload: { safe: true } };
    await writeLines(path, [header(path), checkpointRecord(checkpoint, 2), future as never]);
    const scan = await scanTranscriptContinuation(path);
    expect(scan.lastCompleteSequence).toBe(3);
    expect(scan.reduction.recovery).toEqual({ kind: "clean" });
  });

  test("reports complete malformed data and requested identity mismatch distinctly", async () => {
    const path = await transcriptPath();
    await writeLines(path, [header(path), checkpointRecord(initialCheckpoint(path), 2)]);
    await expect(scanTranscriptContinuation(path, { transcriptId: "wrong" })).rejects.toBeInstanceOf(TranscriptIdentityError);

    await writeFile(path, `${JSON.stringify(header(path))}\nnot-json\n`);
    await expect(scanTranscriptContinuation(path)).rejects.toBeInstanceOf(TranscriptCorruptionError);
  });

  test("reports a missing transcript distinctly", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-scanner-missing-"));
    roots.push(root);
    await expect(scanTranscriptContinuation(join(root, "missing.jsonl"))).rejects.toBeInstanceOf(TranscriptNotFoundError);
  });

  test("resumes append ownership at the last complete record and removes only a torn suffix", async () => {
    const path = await transcriptPath();
    const checkpoint = initialCheckpoint(path);
    await writeLines(path, [header(path), checkpointRecord(checkpoint, 2)]);
    await appendFile(path, "{\"partial\":", "utf8");

    const { writer, scan } = await FileSessionLogWriter.resumeTranscript({
      path,
      expected: { agentSessionId: "agent-1", transcriptId: "transcript-1", generation: 1 },
    });
    expect(scan.ignoredTrailingBytes).toBeGreaterThan(0);
    expect(writer.nextSequence).toBe(3);
    await writer.append(operation(3, "started", 2), { durable: true });
    await writer.close();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([1, 2, 3]);
  });
});

async function transcriptPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-scanner-"));
  roots.push(root);
  return join(root, "agent-1.jsonl");
}

async function writeLines(path: string, records: readonly KnownTranscriptRecord[], suffix = ""): Promise<void> {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n${suffix}`);
}

function header(path: string): TranscriptHeaderRecord {
  void path;
  return {
    ...envelope(1), t: "header", event: "created", createdAt: iso(0), preset: "activity",
    effectivePolicy: TRANSCRIPT_PRESETS.activity,
    effectiveLimits: { maxRecordBytes: 4_096, maxCapturedFieldBytes: 1_024, maxJsonDepth: 16, maxCursorBytes: 4_096 },
    includeTruncationDigests: false,
    installation: { kind: "creation", operationId: "creation-1", requestDigest: "a".repeat(64) },
  };
}

function initialCheckpoint(path: string): AgentSessionCheckpoint {
  return createAgentSessionCheckpoint({
    agentSessionId: "agent-1", incarnationId: "creation-1", stateRevision: 1,
    adapterId: "opencode", mode: "normal", internalSessionId: "provider-1",
    internalSessionActivatedAt: iso(0), internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: EMPTY_HISTORY_DIGEST, model: "model-1",
    sessionConfiguration: {
      adapterId: "opencode", schemaDigest: null, announcedConfigIds: [], restorationTargets: [],
      effective: {}, omittedConfigIds: [], restorationFidelity: "exact", observedAt: iso(0),
    },
    protocol: { name: "acp", version: 1 },
    transcript: { transcriptId: "transcript-1", generation: 1, path, coveredSequence: 1 },
    boundary: { status: "settled", lastSettledOperationId: null }, updatedAt: iso(0),
  });
}

function checkpointRecord(checkpoint: AgentSessionCheckpoint, seq: number) {
  return { ...envelope(seq), t: "checkpoint" as const, stateRevision: checkpoint.stateRevision, checkpoint };
}

function operation(seq: number, event: TranscriptOperationRecord["event"], stateRevision: number): TranscriptOperationRecord {
  return {
    ...envelope(seq), t: "operation", operationId: "op-1", operationKind: "prompt", event, stateRevision,
    ...(event === "aborted" ? { abortReason: "pre_dispatch_persistence_failure" as const } : {}),
  };
}

function envelope(seq: number) {
  return {
    v: 2 as const, transcriptId: "transcript-1", generation: 1,
    agentSessionId: "agent-1", seq, ts: TS + (seq - 2) * 1_000,
  };
}

function iso(offset: number): string {
  return new Date(TS + offset).toISOString();
}

function withoutDigest(checkpoint: AgentSessionCheckpoint) {
  const { version: _version, digest: _digest, ...input } = checkpoint;
  return input;
}
