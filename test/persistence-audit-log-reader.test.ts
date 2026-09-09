import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUDIT_LOG_CAPTURE } from "../src/persistence/config.ts";
import type { AuditLogHeaderRecord, KnownAuditLogRecord } from "../src/persistence/records.ts";
import {
  AuditLogCursorInvalidError,
  AuditLogReader,
  AuditLogReaderError,
} from "../src/persistence/audit-log-reader.ts";

const roots: string[] = [];
const TS = Date.parse("2026-09-09T15:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("audit-log pagination", () => {
  test("pages newest-first without overlap and preserves an append-stable snapshot", async () => {
    const path = await fixtureAuditLog();
    const reader = new AuditLogReader(path);
    const newest = await reader.readPage({ limit: 3 });
    expect(newest.items.map((item) => item.seq)).toEqual([8, 9, 10]);
    expect(newest.hasOlder).toBe(true);
    expect(newest.hasNewer).toBe(false);
    expect(Buffer.byteLength(newest.snapshot)).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(newest.olderCursor!)).toBeLessThanOrEqual(256);

    await append(path, lifecycle(11, "session_stopped"));
    const older = await reader.readPage({ limit: 3, cursor: newest.olderCursor! });
    expect(older.items.map((item) => item.seq)).toEqual([5, 6, 7]);
    expect(older.snapshot).toBe(newest.snapshot);
    const forward = await reader.readPage({ limit: 3, cursor: older.newerCursor! });
    expect(forward.items.map((item) => item.seq)).toEqual([8, 9, 10]);

    const fresh = await reader.readPage({ limit: 2 });
    expect(fresh.items.map((item) => item.seq)).toEqual([10, 11]);
  });

  test("binds type filters and preserves unknown future records", async () => {
    const reader = new AuditLogReader(await fixtureAuditLog());
    const operations = await reader.readPage({ types: ["operation"], limit: 2 });
    expect(operations.items.map((item) => [item.seq, item.t])).toEqual([[2, "operation"], [7, "operation"]]);
    await expect(reader.readPage({ types: ["activity"], cursor: operations.olderCursor! }))
      .rejects.toBeInstanceOf(AuditLogCursorInvalidError);

    const newest = await reader.readPage({ limit: 1 });
    expect(newest.items[0]).toMatchObject({ t: "future_audit", seq: 10, value: { future: true } });
    const empty = await reader.readPage({ types: [] });
    expect(empty.items).toEqual([]);
    expect(empty.snapshot).toBeTruthy();
    await expect(reader.readPage({ types: ["message" as never] }))
      .rejects.toBeInstanceOf(AuditLogReaderError);
  });

  test("rejects transcript, malformed, oversized, and rewritten cursors", async () => {
    const auditPath = await fixtureAuditLog();
    const audit = new AuditLogReader(auditPath);
    const page = await audit.readPage({ limit: 2 });
    await expect(audit.readPage({ cursor: "%%%" as never }))
      .rejects.toBeInstanceOf(AuditLogCursorInvalidError);
    await expect(audit.readPage({ cursor: "a".repeat(257) as never }))
      .rejects.toBeInstanceOf(AuditLogCursorInvalidError);

    const foreignWire = JSON.parse(Buffer.from(page.olderCursor!, "base64url").toString("utf8"));
    foreignWire[1] = "n";
    const transcriptKindCursor = Buffer.from(JSON.stringify(foreignWire)).toString("base64url");
    await expect(audit.readPage({ cursor: transcriptKindCursor as never }))
      .rejects.toBeInstanceOf(AuditLogCursorInvalidError);

    const content = await readFile(auditPath);
    const index = content.indexOf(Buffer.from("tool-a"));
    const handle = await open(auditPath, "r+");
    try {
      await handle.write(Buffer.from("X"), 0, 1, index);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await expect(audit.readPage({ cursor: page.olderCursor! }))
      .rejects.toBeInstanceOf(AuditLogCursorInvalidError);
  });
});

async function fixtureAuditLog(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-audit-reader-"));
  roots.push(root);
  const path = join(root, "agent-1.audit.jsonl");
  const header: AuditLogHeaderRecord = {
    ...envelope(1),
    t: "header",
    event: "created",
    createdAt: new Date(TS).toISOString(),
    effectivePolicy: DEFAULT_AUDIT_LOG_CAPTURE,
    effectiveLimits: {
      maxRecordBytes: 256 * 1024,
      maxCapturedFieldBytes: 128 * 1024,
      maxJsonDepth: 16,
      maxCursorBytes: 256,
    },
    includeTruncationDigests: false,
    installation: { kind: "creation", operationId: "create-1", requestDigest: "a".repeat(64) },
  };
  const records: Array<KnownAuditLogRecord | Record<string, unknown>> = [
    header,
    { ...envelope(2), t: "operation", operationId: "op-1", operationKind: "prompt", event: "started" },
    activity(3, "announced", "pending"),
    { ...envelope(4), t: "permission", permissionId: "permission-1", event: "requested" },
    activity(5, "input", "in_progress"),
    lifecycle(6, "session_opened"),
    { ...envelope(7), t: "operation", operationId: "op-1", operationKind: "prompt", event: "settled" },
    activity(8, "settled", "completed"),
    { ...envelope(9), t: "metering_reference", operationId: "op-1", meteringRecordId: "meter-1", status: "available" },
    { ...envelope(10), t: "future_audit", future: true },
  ];
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

async function append(path: string, record: Record<string, unknown>): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

function activity(seq: number, reason: "announced" | "input" | "settled", status: string) {
  return {
    ...envelope(seq), t: "activity", activityId: "tool-a", activityRevision: seq,
    operationId: "op-1", reason, kind: "tool", status, data: { title: "tool-a" },
  } as const;
}

function lifecycle(seq: number, event: "session_opened" | "session_stopped") {
  return { ...envelope(seq), t: "lifecycle", event } as const;
}

function envelope(seq: number) {
  return {
    v: 1 as const,
    auditLogId: "audit-1",
    generation: 1,
    agentSessionId: "agent-1",
    seq,
    ts: TS + seq,
  };
}
