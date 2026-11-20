import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: dispatch evidence fences duplicates and distinguishes uncertain effects`, () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-evidence-"));
  try {
    const adapter = kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, "db.sqlite"));
    const identity = { sessionId: "s", compatibilityKey: "k" };
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw new Error(r.error.message); return r.value; };
    const s = must(adapter.open({ mode: "create", identity }));
    must(s.acceptItem({ kind: "participant_message", channelId: "a", senderId: "u", text: "hello", itemId: "m" }));
    const turn = must(s.beginTurn("a"))!.turn.turnId;
    must(s.appendMessage(turn, { role: "assistant", content: null, calls: [{ id: "a", name: "t", arguments: "{}" }, { id: "b", name: "t", arguments: "{}" }] }));
    expect(must(s.snapshot()).turns[0]!.state).toMatchObject({ status: "running", dispatchedCallIds: [] });
    must(s.markToolDispatched(turn, "a")); const before = must(s.snapshot());
    expect(s.markToolDispatched(turn, "a")).toMatchObject({ ok: false });
    expect(s.markToolDispatched(turn, "missing")).toMatchObject({ ok: false });
    expect(must(s.snapshot())).toEqual(before);
    s.close();
    const recovered = must(adapter.open({ mode: "open", identity }));
    expect(must(recovered.snapshot()).turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["a"] });
    recovered.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["memory", "sqlite"] as const) test(`${kind}: import validates dispatch evidence and legacy resumed calls start a fresh list`, () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-import-"));
  try {
    const create = (name: string) => kind === "memory" ? createMemoryStorageAdapter() : createSqliteStorageAdapter(join(dir, name));
    const adapter = create("source"), identity = { sessionId: "s", compatibilityKey: "k" };
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }) => { if (!r.ok) throw new Error(r.error.message); return r.value; };
    const s = must(adapter.open({ mode: "create", identity }));
    must(s.acceptItem({ kind: "participant_message", channelId: "a", senderId: "u", text: "hello", itemId: "m" }));
    const turn = must(s.beginTurn("a"))!.turn.turnId;
    must(s.appendMessage(turn, { role: "assistant", content: null, calls: [{ id: "one", name: "t", arguments: "{}" }] }));
    must(s.markToolDispatched(turn, "one")); must(s.appendMessage(turn, { role: "tool", callId: "one", content: "ok" }));
    expect(s.markToolDispatched(turn, "one")).toMatchObject({ ok: false });
    must(s.beginChannelSuspend("a")); must(s.checkpointTurn(turn)); must(s.beginSuspend()); must(s.completeSuspend());
    const archive = must(s.exportArchive()); s.close();
    for (const invalid of [["one", "one"], [""], ["foreign"]]) {
      const copy = structuredClone(archive), state = copy.snapshot.turns[0]!.state as { dispatchedCallIds?: string[] };
      state.dispatchedCallIds = invalid;
      expect(create(`bad-${invalid.join("-")}`).importArchive(copy)).toMatchObject({ ok: false, error: { code: "invalid_archive" } });
    }
    const missingResult = structuredClone(archive); missingResult.snapshot.timeline = missingResult.snapshot.timeline.filter(entry => entry.message.role !== "tool");
    expect(create("bad-unanswered").importArchive(missingResult)).toMatchObject({ ok: false, error: { code: "invalid_archive" } });
    const legacy = structuredClone(archive); delete (legacy.snapshot.turns[0]!.state as { dispatchedCallIds?: string[] }).dispatchedCallIds;
    const destination = create("legacy"); must(destination.importArchive(legacy)); const reopened = must(destination.open({ mode: "open", identity }));
    must(reopened.resume()); must(reopened.resumeChannel("a"));
    must(reopened.appendMessage(turn, { role: "assistant", content: null, calls: [{ id: "two", name: "t", arguments: "{}" }] }));
    expect(must(reopened.snapshot()).turns[0]!.state).toMatchObject({ status: "running", dispatchedCallIds: [] });
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
