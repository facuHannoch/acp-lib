import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionCheckpoint } from "../src/persistence/checkpoint.ts";
import { TRANSCRIPT_PRESETS } from "../src/persistence/config.ts";
import { EMPTY_HISTORY_DIGEST } from "../src/persistence/reducer.ts";
import type { KnownTranscriptRecord, TranscriptHeaderRecord } from "../src/persistence/records.ts";
import {
  TranscriptCursorInvalidError,
  TranscriptReader,
  TranscriptReaderError,
} from "../src/persistence/transcript-reader.ts";

const roots: string[] = [];
const TS = Date.parse("2026-09-09T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("v2 transcript pagination", () => {
  test("returns the newest projected items oldest-first and navigates without overlap", async () => {
    const path = await fixtureTranscript();
    const reader = new TranscriptReader(path);
    const newest = await reader.readPage({ limit: 3 });
    expect(newest.items.map((item) => item.seq)).toEqual([9, 10, 11]);
    expect(newest.hasOlder).toBe(true);
    expect(newest.hasNewer).toBe(false);
    expect(newest.olderCursor).not.toBeNull();
    expect(newest.newerCursor).toBeNull();
    expect(Buffer.byteLength(newest.snapshot, "utf8")).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(newest.olderCursor!, "utf8")).toBeLessThanOrEqual(256);

    const older = await reader.readPage({ limit: 3, cursor: newest.olderCursor! });
    expect(older.items.map((item) => item.seq)).toEqual([6, 7, 8]);
    expect(older.hasOlder).toBe(true);
    expect(older.hasNewer).toBe(true);
    expect(older.snapshot).toBe(newest.snapshot);

    const forward = await reader.readPage({ limit: 3, cursor: older.newerCursor! });
    expect(forward.items.map((item) => item.seq)).toEqual([9, 10, 11]);
    expect(forward.snapshot).toBe(newest.snapshot);
  });

  test("binds navigation to its projection while one snapshot survives concurrent append", async () => {
    const path = await fixtureTranscript();
    const reader = new TranscriptReader(path);
    const first = await reader.readPage({ view: "records", types: ["message"], limit: 2 });
    expect(first.items.map((item) => item.seq)).toEqual([9, 11]);

    await appendRecord(path, message(13, "assistant", "new after snapshot"));
    const older = await reader.readPage({
      view: "records",
      types: ["message"],
      limit: 2,
      cursor: first.olderCursor!,
    });
    expect(older.items.map((item) => item.seq)).toEqual([3, 6]);
    expect(older.snapshot).toBe(first.snapshot);

    const fresh = await reader.readPage({ view: "records", types: ["message"], limit: 2 });
    expect(fresh.items.map((item) => item.seq)).toEqual([11, 13]);
    await expect(reader.readPage({ view: "timeline", cursor: first.olderCursor! }))
      .rejects.toBeInstanceOf(TranscriptCursorInvalidError);
  });

  test("records exposes unknown envelopes while timeline excludes structural and raw records", async () => {
    const path = await fixtureTranscript();
    const reader = new TranscriptReader(path);
    const records = await reader.readPage({ view: "records", limit: 2 });
    expect(records.items.map((item) => item.t)).toEqual(["message", "future_display"]);
    expect(records.items.at(-1)).toMatchObject({ t: "future_display", seq: 12, value: { payload: { future: true } } });

    await expect(reader.readPage({ view: "timeline", types: ["checkpoint"] }))
      .rejects.toBeInstanceOf(TranscriptReaderError);
    await expect(reader.readPage({ view: "conversation", types: ["message"] }))
      .rejects.toBeInstanceOf(TranscriptReaderError);
    const emptyFilter = await reader.readPage({ view: "records", types: [] });
    expect(emptyFilter.items).toEqual([]);
    expect(emptyFilter.snapshot).toBeTruthy();
    for (const limit of [0, -1, 1.5, Infinity, 501]) {
      await expect(reader.readPage({ limit })).rejects.toBeInstanceOf(TranscriptReaderError);
    }
  });

  test("detects a rewrite before a navigation or snapshot boundary", async () => {
    const path = await fixtureTranscript();
    const reader = new TranscriptReader(path);
    const page = await reader.readPage({ limit: 2 });
    const handle = await open(path, "r+");
    try {
      const content = await readFile(path);
      const index = content.indexOf(Buffer.from("first user"));
      expect(index).toBeGreaterThan(0);
      await handle.write(Buffer.from("X"), 0, 1, index);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await expect(reader.readPage({ limit: 2, cursor: page.olderCursor! }))
      .rejects.toBeInstanceOf(TranscriptCursorInvalidError);
    await expect(reader.listActivityStates({ at: page.snapshot }))
      .rejects.toBeInstanceOf(TranscriptCursorInvalidError);
  });

  test("rejects malformed, oversized, and wrong-kind cursors", async () => {
    const reader = new TranscriptReader(await fixtureTranscript());
    const page = await reader.readPage({ limit: 2 });
    await expect(reader.readPage({ cursor: "%%%" as never }))
      .rejects.toBeInstanceOf(TranscriptCursorInvalidError);
    await expect(reader.readPage({ cursor: "a".repeat(257) as never }))
      .rejects.toBeInstanceOf(TranscriptCursorInvalidError);
    await expect(reader.listActivityStates({ at: page.olderCursor as never }))
      .rejects.toBeInstanceOf(TranscriptCursorInvalidError);
  });

  test("folds activity at an inclusive, view-independent snapshot before filtering", async () => {
    const path = await fixtureTranscript();
    const reader = new TranscriptReader(path);
    const page = await reader.readPage({ view: "conversation", limit: 2 });
    const atSnapshot = await reader.listActivityStates({ at: page.snapshot });
    expect(atSnapshot.activities.map((activity) => [activity.activityId, activity.activityRevision, activity.execution]))
      .toEqual([["tool-b", 1, "terminal"], ["tool-a", 2, "historically_open"]]);

    await appendRecord(path, activity(13, "tool-a", 3, "settled", "completed"));
    const stillOld = await reader.listActivityStates({ at: page.snapshot, status: "open" });
    expect(stillOld.activities.map((activity) => activity.activityId)).toEqual(["tool-a"]);
    const fresh = await reader.listActivityStates({ order: "updated_asc", status: "terminal" });
    expect(fresh.activities.map((activity) => [activity.activityId, activity.activityRevision]))
      .toEqual([["tool-b", 1], ["tool-a", 3]]);
  });

  test("backward pages preserve a record and Unicode split across byte chunks", async () => {
    const path = await fixtureTranscript();
    const long = "x".repeat(70_000);
    const unicode = `${"y".repeat(65_535)}🧭tail`;
    await appendRecord(path, message(13, "user", long));
    await appendRecord(path, message(14, "assistant", unicode));
    const page = await new TranscriptReader(path).readPage({ view: "conversation", limit: 2 });
    expect(page.items.map((item) => item.seq)).toEqual([13, 14]);
    expect(page.items[0]?.text).toBe(long);
    expect(page.items[1]?.text).toBe(unicode);
  });
});

async function fixtureTranscript(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-v2-reader-"));
  roots.push(root);
  const path = join(root, "agent-1.jsonl");
  const header: TranscriptHeaderRecord = {
    ...envelope(1),
    t: "header",
    event: "created",
    createdAt: new Date(TS).toISOString(),
    preset: "activity",
    effectivePolicy: TRANSCRIPT_PRESETS.activity,
    effectiveLimits: {
      maxRecordBytes: 256 * 1024,
      maxCapturedFieldBytes: 128 * 1024,
      maxJsonDepth: 16,
      maxCursorBytes: 256,
    },
    includeTruncationDigests: false,
    installation: { kind: "creation", operationId: "create-1", requestDigest: "a".repeat(64) },
  };
  const checkpoint = createAgentSessionCheckpoint({
    agentSessionId: "agent-1",
    incarnationId: "create-1",
    stateRevision: 1,
    adapterId: "fake",
    mode: "normal",
    internalSessionId: "provider-1",
    internalSessionActivatedAt: new Date(TS).toISOString(),
    internalSessionHistoryRevision: 0,
    internalSessionHistoryDigest: EMPTY_HISTORY_DIGEST,
    model: "model-1",
    sessionConfiguration: {
      adapterId: "fake",
      effective: {},
      restorationTargets: [],
      announcedConfigIds: [],
      schemaDigest: null,
      observedAt: new Date(TS).toISOString(),
      restorationFidelity: "exact",
      omittedConfigIds: [],
    },
    protocol: { name: "acp", version: 1 },
    transcript: { transcriptId: "transcript-1", generation: 1, path, coveredSequence: 1 },
    boundary: { status: "settled", lastSettledOperationId: null },
    updatedAt: new Date(TS).toISOString(),
  });
  const records: Array<KnownTranscriptRecord | Record<string, unknown>> = [
    header,
    { ...envelope(2), t: "checkpoint", stateRevision: 1, checkpoint },
    message(3, "user", "first user"),
    activity(4, "tool-a", 1, "announced", "pending"),
    { ...envelope(5), t: "lifecycle", event: "session_opened" },
    message(6, "assistant", "first assistant"),
    activity(7, "tool-a", 2, "input", "in_progress"),
    {
      ...envelope(8), t: "reasoning", reasoningId: "reason-1", reasoningRevision: 1,
      operationId: "op-2", text: "thinking", status: "completed",
    },
    message(9, "user", "second user"),
    activity(10, "tool-b", 1, "settled", "completed"),
    message(11, "assistant", "second assistant"),
    { ...envelope(12), t: "future_display", payload: { future: true } },
  ];
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

async function appendRecord(path: string, record: Record<string, unknown>): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

function message(seq: number, role: "user" | "assistant", text: string) {
  return { ...envelope(seq), t: "message", operationId: `op-${seq}`, role, text } as const;
}

function activity(
  seq: number,
  activityId: string,
  activityRevision: number,
  reason: "announced" | "input" | "settled",
  status: string,
) {
  return {
    ...envelope(seq),
    t: "activity",
    activityId,
    activityRevision,
    operationId: `op-${activityId}`,
    reason,
    kind: "tool",
    status,
    data: { title: activityId },
  } as const;
}

function envelope(seq: number) {
  return {
    v: 2 as const,
    transcriptId: "transcript-1",
    generation: 1,
    agentSessionId: "agent-1",
    seq,
    ts: TS + seq,
  };
}
