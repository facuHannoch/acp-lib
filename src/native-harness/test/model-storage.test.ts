import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateUsage } from "../src/capabilities/model/usage.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";
import type { StorageResult } from "../src/contracts/storage.ts";
const take = <T>(result: StorageResult<T>): T => { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`); return result.value; };
for (const kind of ["memory", "sqlite"] as const) test(`${kind}: model calls retain receipts, usage, identity and script reservations across reopen`, () => {
  const dir = mkdtempSync(join(tmpdir(), "model-store-"));
  const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "s.db"));
  const identity = { sessionId: "s", compatibilityKey: "key" };
  try {
    let storage = take(adapter.open({ mode: "create", identity }));
    take(storage.acceptItem({ itemId: "i", kind: "participant_message", channelId: "a", senderId: "u", text: "hello" }));
    const turn = take(storage.beginTurn("a"))!.turn, call = take(storage.startCall(String(turn.turnId), ["i"]));
    const attempt = take(storage.startAttempt(call.callId, true)); expect(attempt.scriptStep).toBe(0);
    take(storage.recordProviderRequestId(call.callId, attempt.attemptId, "provider")); take(storage.confirm(call.callId, attempt.attemptId, "seen"));
    take(storage.recordUsage(call.callId, attempt.attemptId, { inputTokens: 9 }));
    expect(storage.recordUsage(call.callId, attempt.attemptId, { inputTokens: -1 }).ok).toBe(false);
    take(storage.close()); storage = take(adapter.open({ mode: "open", identity }));
    const view = take(storage.snapshot()); expect(view.items[0]!.milestone).toBe("seen");
    expect(view.modelCalls[0]).toMatchObject({ outcome: "interrupted", attempts: [{ outcome: "interrupted", providerRequestId: "provider", usage: { inputTokens: 9 }, scriptStep: 0 }] });
    expect(view.scriptPositions.a).toBe(1);
    take(storage.acceptItem({ itemId: "i2", kind: "participant_message", channelId: "a", senderId: "u", text: "next" }));
    const nextTurn = take(storage.beginTurn("a"))!.turn, next = take(storage.startCall(String(nextTurn.turnId), ["i2"]));
    expect(next.messageId).not.toBe(call.messageId);
    const nextAttempt = take(storage.startAttempt(next.callId, true)); expect(nextAttempt.scriptStep).toBe(1);
    const response = { role: "assistant" as const, content: "done", calls: [], stopReason: "complete" as const };
    take(storage.commitResponse(next.callId, nextAttempt.attemptId, response));
    const committed = take(storage.snapshot()); expect(committed.modelCalls.at(-1)?.outcome).toBe("succeeded");
    expect(committed.timeline.at(-1)?.messageId).toBe(next.messageId);
    take(storage.finishTurn(nextTurn.turnId, { status: "completed" }));
    const archive = take(storage.exportArchive()); expect(archive.archiveVersion).toBe(5);
    const destination = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "copy.db"));
    take(destination.importArchive(archive));
    const copy = take(destination.open({ mode: "open", identity })); expect(take(copy.snapshot()).timeline.at(-1)?.messageId).toBe(next.messageId); take(copy.close());
    take(storage.close());
    storage = take(adapter.open({ mode: "open", identity })); expect(take(storage.snapshot()).timeline.at(-1)?.messageId).toBe(next.messageId); take(storage.close());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: interrupted channel accepts and completes fresh input`, async () => {
  const { createSession } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "model-channel-")), adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "s.db"));
  const storage = take(adapter.open({ mode: "create", identity: { sessionId: "s", compatibilityKey: "key" } }));
  let entered = false, release!: () => void, runs = 0;
  const session = createSession({ systemPrompt: "test", storage, configureTurn: () => ({ tools: [], executeTool: async () => "unused", model: async () => {
    if (++runs === 1) { entered = true; await new Promise<void>(resolve => { release = resolve; }); return { role: "assistant", content: "late", calls: [] }; }
    return { role: "assistant", content: "fresh", calls: [] };
  } }) });
  const until = async (check: () => boolean) => { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("timed out"); };
  try {
    session.start(); expect(session.agent.send({ channelId: "a", participantId: "u", itemId: "one", text: "first" }).accepted).toBe(true);
    await until(() => entered); const turn = session.snapshot().turns[0]!;
    expect(session.channels.interrupt("a", turn.turnId).ok).toBe(true);
    expect(session.agent.send({ channelId: "a", participantId: "u", itemId: "two", text: "second" }).accepted).toBe(true);
    await until(() => session.snapshot().turns.some(value => value.turnId !== turn.turnId && value.state.status === "completed"));
    release(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(session.snapshot().timeline.filter(entry => entry.message.role === "assistant").map(entry => entry.message.content)).toEqual(["fresh"]);
  } finally { session.stop("test complete"); storage.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: retry keeps absolute per-attempt usage without double counting`, () => {
  const dir = mkdtempSync(join(tmpdir(), "model-usage-")), adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "s.db"));
  const identity = { sessionId: "s", compatibilityKey: "k" };
  try {
    let storage = take(adapter.open({ mode: "create", identity }));
    take(storage.acceptItem({ itemId: "i", kind: "participant_message", channelId: "a", senderId: "u", text: "hi" }));
    const turn = take(storage.beginTurn("a"))!.turn, call = take(storage.startCall(String(turn.turnId), ["i"]));
    const first = take(storage.startAttempt(call.callId, true)); take(storage.recordUsage(call.callId, first.attemptId, { inputTokens: 2 }));
    take(storage.recordUsage(call.callId, first.attemptId, { inputTokens: 4 })); take(storage.finishAttempt(call.callId, first.attemptId, "transient_failure"));
    const second = take(storage.startAttempt(call.callId, true)); expect(second.scriptStep).toBe(1);
    take(storage.recordUsage(call.callId, second.attemptId, { inputTokens: 3, outputTokens: 5 }));
    take(storage.commitResponse(call.callId, second.attemptId, { role: "assistant", content: "ok", calls: [], stopReason: "complete" }));
    take(storage.recordUsage(call.callId, second.attemptId, { inputTokens: 999 })); // late report is ignored
    take(storage.finishTurn(turn.turnId, { status: "completed" })); take(storage.close()); storage = take(adapter.open({ mode: "open", identity }));
    const summary = take(storage.readCalls()).calls[0]!; expect(summary.attempts.map(value => value.usage)).toEqual([{ inputTokens: 4 }, { inputTokens: 3, outputTokens: 5 }]);
    expect(aggregateUsage(summary.attempts)).toEqual({ inputTokens: 7, outputTokens: 5 });
    expect(summary.attempts.some(item => item.usage?.totalTokens !== undefined)).toBe(false); take(storage.close());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("format 4 upgrades its script counter once from assistant history", async () => {
  const { Database } = await import("bun:sqlite"), dir = mkdtempSync(join(tmpdir(), "model-v4-")), path = join(dir, "s.db"), identity = { sessionId: "s", compatibilityKey: "k" };
  const adapter = createSqliteStorageAdapter(path);
  try {
    let storage = take(adapter.open({ mode: "create", identity }));
    take(storage.acceptItem({ itemId: "i", kind: "participant_message", channelId: "a", senderId: "u", text: "hi" }));
    const turn = take(storage.beginTurn("a"))!.turn;
    take(storage.appendMessage(turn.turnId, { role: "assistant", content: "one", calls: [] }));
    take(storage.appendMessage(turn.turnId, { role: "assistant", content: "two", calls: [] }));
    take(storage.finishTurn(turn.turnId, { status: "completed" })); take(storage.close());
    const db = new Database(path); db.exec("UPDATE meta SET value = '4' WHERE key = 'formatVersion'; DELETE FROM meta WHERE key = 'modelState'; ALTER TABLE items DROP COLUMN external_source; ALTER TABLE entries DROP COLUMN external_source"); db.close();
    storage = take(adapter.open({ mode: "open", identity })); expect(take(storage.snapshot()).scriptPositions.a).toBe(2); take(storage.close());
    storage = take(adapter.open({ mode: "open", identity })); expect(take(storage.snapshot()).scriptPositions.a).toBe(2); take(storage.close());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
