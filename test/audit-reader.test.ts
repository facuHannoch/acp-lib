import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionId } from "../src/agent-ids.ts";
import {
  AgentAuditLogReader,
  AgentAuditLogReaderError,
  AgentAuditRuntime,
  resolveAgentAuditLogConfig,
  type AgentAuditEntryV2,
} from "../src/audit/index.ts";
import { SqliteAgentPersistence } from "../src/persistence/sqlite-backend.ts";

const roots: string[] = [];
const backends: SqliteAgentPersistence[] = [];
const runtimes: AgentAuditRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.allSettled(backends.splice(0).map((backend) => backend.close()));
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentAuditLogReader", () => {
  test("paginates across segments and holds the first-page snapshot boundary", async () => {
    const fixture = await createFixture({ rotation: { maxBytes: 300, maxAgeMs: false } });
    await enqueue(fixture, 1, "x".repeat(400));
    await enqueue(fixture, 2, "x".repeat(400));
    await enqueue(fixture, 3, "x".repeat(400));
    fixture.runtime.notifyPending();
    await fixture.runtime.flush({ timeoutMs: 3_000 });

    const reader = await AgentAuditLogReader.open({ directory: fixture.auditDirectory });
    const first = await reader.readPage({ mode: "logical", limit: 1 });
    expect(first.entries.map((entry) => entry.auditSequence)).toEqual([1]);
    expect(first.nextCursor).toBeDefined();

    await enqueue(fixture, 4, "later");
    fixture.runtime.notifyPending();
    await fixture.runtime.flush({ timeoutMs: 3_000 });
    const rest = await collect(reader, "logical", first.nextCursor!, 1);
    expect(rest.map((entry) => entry.auditSequence)).toEqual([2, 3]);

    const fresh = await collect(reader, "logical", undefined, 2);
    expect(fresh.map((entry) => entry.auditSequence)).toEqual([1, 2, 3, 4]);
  });

  test("logical mode deduplicates a bounded replay while physical mode preserves it", async () => {
    const fixture = await createFixture();
    await enqueue(fixture, 1, "one");
    await enqueue(fixture, 2, "two");
    await enqueue(fixture, 3, "three");
    fixture.runtime.notifyPending();
    await fixture.runtime.flush({ timeoutMs: 3_000 });
    await fixture.runtime.close();
    runtimes.splice(runtimes.indexOf(fixture.runtime), 1);

    const path = join(fixture.auditDirectory, "audit.000001.jsonl");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await appendFile(path, `${lines[2]}\n${lines[3]}\n`);
    const reader = await AgentAuditLogReader.open({ directory: fixture.auditDirectory });
    const logical = await collect(reader, "logical", undefined, 1);
    const physical = await collect(reader, "physical", undefined, 2);
    expect(logical.map((entry) => entry.auditSequence)).toEqual([1, 2, 3]);
    expect(physical.map((entry) => entry.auditSequence)).toEqual([1, 2, 3, 2, 3]);
  });

  test("reports digest corruption and torn tails without mutating the stream", async () => {
    const fixture = await createFixture();
    await enqueue(fixture, 1, "original");
    fixture.runtime.notifyPending();
    await fixture.runtime.flush({ timeoutMs: 3_000 });
    await fixture.runtime.close();
    runtimes.splice(runtimes.indexOf(fixture.runtime), 1);
    const path = join(fixture.auditDirectory, "audit.000001.jsonl");
    const valid = await readFile(path, "utf8");

    await appendFile(path, "{\"v\":2");
    const torn = await readFile(path, "utf8");
    const reader = await AgentAuditLogReader.open({ directory: fixture.auditDirectory });
    await expect(reader.readPage()).rejects.toThrow("torn audit tail");
    expect(await readFile(path, "utf8")).toBe(torn);

    const lines = valid.trimEnd().split("\n");
    const changed = JSON.parse(lines[1]!) as AgentAuditEntryV2;
    await writeFile(path, `${lines[0]}\n${JSON.stringify({ ...changed, payload: { content: "changed" } })}\n`);
    await expect(reader.readPage()).rejects.toBeInstanceOf(AgentAuditLogReaderError);
  });
});

async function createFixture(overrides: Parameters<typeof resolveAgentAuditLogConfig>[0] = { directory: "unused" }) {
  const root = await mkdtemp(join(tmpdir(), "acp-audit-reader-"));
  roots.push(root);
  const backend = await SqliteAgentPersistence.open({
    path: join(root, "agent.sqlite"),
    agentSessionId: createAgentSessionId(),
  });
  backends.push(backend);
  const auditDirectory = join(root, "audit");
  const config = resolveAgentAuditLogConfig({ ...overrides, directory: auditDirectory });
  const state = await backend.auditOutbox.initialize("audit-log-1", config.captureFingerprint);
  const runtime = await AgentAuditRuntime.open({
    persistence: backend,
    agentSessionId: backend.identityRecord.agentSessionId,
    config,
    auditState: state,
  });
  runtimes.push(runtime);
  return { backend, auditDirectory, config, runtime };
}

async function enqueue(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sequence: number,
  content: string,
): Promise<void> {
  await fixture.backend.auditOutbox.enqueue({
    outboxId: `outbox-${sequence}`,
    sourceObservationId: `source-${sequence}`,
    occurredAt: `2026-09-19T00:00:0${sequence}.000Z`,
    kind: "message",
    captureLevel: "content",
    captureFingerprint: fixture.config.captureFingerprint,
    payload: { content },
    createdAt: `2026-09-19T00:00:0${sequence}.000Z`,
  });
}

async function collect(
  reader: AgentAuditLogReader,
  mode: "logical" | "physical",
  cursor: string | undefined,
  limit: number,
): Promise<AgentAuditEntryV2[]> {
  const entries: AgentAuditEntryV2[] = [];
  let next = cursor;
  do {
    const page = await reader.readPage({ mode, limit, ...(next ? { cursor: next } : {}) });
    entries.push(...page.entries);
    next = page.nextCursor;
  } while (next);
  return entries;
}
