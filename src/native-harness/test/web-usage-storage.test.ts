import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: paid web dispatch survives lost result and atomically stores result usage`, () => {
  const dir = mkdtempSync(join(tmpdir(), "web-evidence-"));
  try {
    const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "db"));
    const identity = { sessionId: "s", compatibilityKey: "k" };
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw Error(r.error.message); return r.value; };
    let session = must(adapter.open({ mode: "create", identity }));
    must(session.acceptItem({ kind: "participant_message", channelId: "a", senderId: "p", text: "go", itemId: "input" }));
    const turn = must(session.beginTurn("a"))!.turn.turnId;
    must(session.appendMessage(turn, { role: "assistant", content: null, calls: [{ id: "c1", name: "web_search", arguments: "{}" }, { id: "c2", name: "web_fetch", arguments: "{}" }] }));
    expect(session.markToolDispatched(turn, "c1", { backend: "exa", operation: "web_fetch", paid: true })).toMatchObject({ ok: false });
    expect(must(session.snapshot()).session.formatVersion).toBe(6);
    must(session.markToolDispatched(turn, "c1", { backend: "exa", operation: "web_search", paid: true }));
    must(session.appendMessage(turn, { role: "tool", callId: "c1", content: "{}", usage: { requestId: "r", usd: 0 } }));
    must(session.markToolDispatched(turn, "c2", { backend: "exa", operation: "web_fetch", paid: true }));
    expect(must(session.snapshot()).session.formatVersion).toBe(10);
    session.close(); session = must(adapter.open({ mode: "open", identity }));
    const restored = must(session.snapshot());
    expect(restored.webDispatches).toEqual([{ turnId: turn, callId: "c1", evidence: { backend: "exa", operation: "web_search", paid: true } }, { turnId: turn, callId: "c2", evidence: { backend: "exa", operation: "web_fetch", paid: true } }]);
    expect(restored.timeline.find(entry => entry.message.role === "tool")?.message).toMatchObject({ usage: { requestId: "r", usd: 0 } });
    expect(restored.turns[0]?.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["c2"] });
    session.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
