import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_PERSISTENCE_LIMITS, TRANSCRIPT_PRESETS } from "../src/persistence/config.ts";
import {
  FileSessionLogWriter,
  SessionLogAlreadyExistsError,
  SessionLogInUseError,
  SessionLogRecordTooLargeError,
  SessionLogWriteError,
} from "../src/persistence/session-log-writer.ts";
import type { TranscriptHeaderRecord, TranscriptOperationRecord } from "../src/persistence/records.ts";

const roots: string[] = [];
const TS = Date.parse("2026-09-08T12:00:00.000Z");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("FileSessionLogWriter", () => {
  test("creates an owner-only JSONL generation and durably appends records", async () => {
    const path = await transcriptPath();
    const writer = await FileSessionLogWriter.create({ kind: "transcript", path, header: header(), maxRecordBytes: 4_096 });
    await writer.append(operation(2, "started"), { durable: true });
    await writer.close();
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.seq, line.t])).toEqual([[1, "header"], [2, "operation"]]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("rejects sequence and identity disagreement without poisoning later appends", async () => {
    const path = await transcriptPath();
    const writer = await FileSessionLogWriter.create({ kind: "transcript", path, header: header(), maxRecordBytes: 4_096 });
    await expect(writer.append(operation(3, "settled"))).rejects.toThrow("expected session-log sequence 2");
    await expect(writer.append({ ...operation(2, "settled"), agentSessionId: "other" })).rejects.toBeInstanceOf(SessionLogWriteError);
    await writer.append(operation(2, "settled"));
    expect(writer.nextSequence).toBe(3);
    await writer.close();
  });

  test("rejects initialized destinations but may claim an explicit zero-byte file", async () => {
    const path = await transcriptPath();
    await writeFile(path, "existing\n", "utf8");
    await expect(FileSessionLogWriter.create({ kind: "transcript", path, header: header(), maxRecordBytes: 4_096 }))
      .rejects.toBeInstanceOf(SessionLogAlreadyExistsError);
    await writeFile(path, "", "utf8");
    const writer = await FileSessionLogWriter.create({ kind: "transcript", path, header: header(), maxRecordBytes: 4_096 });
    await writer.close();
  });

  test("enforces record byte bounds before writing", async () => {
    const path = await transcriptPath();
    const writer = await FileSessionLogWriter.create({ kind: "transcript", path, header: header(), maxRecordBytes: 4_096 });
    await expect(writer.append({
      v: 2, t: "message", transcriptId: "transcript-1", generation: 1, agentSessionId: "agent-1",
      seq: 2, ts: TS, operationId: "op-1", role: "assistant", text: "x".repeat(5_000),
    })).rejects.toBeInstanceOf(SessionLogRecordTooLargeError);
    expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(1);
    await writer.close();
  });

  test("holds its ownership lock for the writer lifetime", async () => {
    const path = await transcriptPath();
    const first = await FileSessionLogWriter.create({ kind: "transcript", path, header: header(), maxRecordBytes: 4_096 });
    await expect(FileSessionLogWriter.create({ kind: "transcript", path, header: header(), maxRecordBytes: 4_096, lockTimeoutMs: 100, lockRetryMs: 5 }))
      .rejects.toBeInstanceOf(SessionLogInUseError);
    await first.close();
  });
});

async function transcriptPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-log-")); roots.push(root); return join(root, "transcript.jsonl");
}

function header(): TranscriptHeaderRecord {
  return {
    v: 2, t: "header", transcriptId: "transcript-1", generation: 1, agentSessionId: "agent-1",
    seq: 1, ts: TS, event: "created", createdAt: new Date(TS).toISOString(), preset: "activity",
    effectivePolicy: TRANSCRIPT_PRESETS.activity,
    effectiveLimits: { ...DEFAULT_PERSISTENCE_LIMITS, maxRecordBytes: 4_096, maxCapturedFieldBytes: 1_024 },
    installation: { kind: "creation", operationId: "creation-1", requestDigest: "a".repeat(64) },
  };
}

function operation(seq: number, event: "started" | "settled"): TranscriptOperationRecord {
  return {
    v: 2, t: "operation", transcriptId: "transcript-1", generation: 1, agentSessionId: "agent-1",
    seq, ts: TS, operationId: "op-1", ...(event === "started" ? { stateRevision: 2 } : {}),
    event, operationKind: "prompt",
  };
}
