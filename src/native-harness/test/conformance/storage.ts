import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionStorage, SessionStorageAdapter, StorageErrorCode, StorageResult } from "../../src/contracts/storage.ts";

/** Shared executable contract for storage revision 2 (decision 0013). Each call
 * to `location` returns an adapter for a fresh, empty location; reusing that
 * adapter reopens the same session. */
export function storageConformance(name: string, location: () => SessionStorageAdapter) {
  const id = (key = "k1") => ({ sessionId: "s1", compatibilityKey: key });
  function ok<T>(result: StorageResult<T>): T {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
  }
  function refused(result: StorageResult<unknown>, code: StorageErrorCode) {
    expect(result.ok ? "ok" : result.error.code).toBe(code);
  }
  const create = (adapter = location()) => ({ adapter, s: ok(adapter.open({ mode: "create", identity: id() })) });
  const reopen = (adapter: SessionStorageAdapter, s: SessionStorage, key = "k1") => {
    ok(s.close());
    return ok(adapter.open({ mode: "open", identity: id(key) }));
  };
  const msg = (s: SessionStorage, text: string, channelId = "c1", itemId?: string) =>
    s.acceptItem({ kind: "participant_message", channelId, senderId: "ana", text, ...(itemId ? { itemId } : {}) });
  const notice = (s: SessionStorage, text: string, channelId = "c1") =>
    s.acceptItem({ kind: "channel_notice", channelId, senderId: "channel:c2", sourceChannelId: "c2", text });
  const say = (s: SessionStorage, turnId: number, content: string) => ok(s.appendMessage(turnId, { role: "assistant", content, calls: [] }));
  const call = (s: SessionStorage, turnId: number, callId: string) =>
    ok(s.appendMessage(turnId, { role: "assistant", content: null, calls: [{ id: callId, name: "echo", arguments: "{}" }] }));
  const snap = (s: SessionStorage) => ok(s.snapshot());
  /** A refused or no-op call must leave the committed state byte-identical. */
  function unchanged(s: SessionStorage, act: () => void) {
    const before = JSON.stringify(snap(s));
    act();
    expect(JSON.stringify(snap(s))).toBe(before);
  }
  const begin = (s: SessionStorage, channelId = "c1") => ok(s.beginTurn(channelId))!;

  describe(`${name} storage conformance`, () => {
    test("explicit create/open, ownership, identity and closed handles", () => {
      const adapter = location();
      refused(adapter.open({ mode: "open", identity: id() }), "not_found");
      refused(adapter.open({ mode: "bogus" as "open", identity: id() }), "invalid_input");
      const s = ok(adapter.open({ mode: "create", identity: id() }));
      refused(adapter.open({ mode: "open", identity: id() }), "owner_conflict");
      ok(msg(s, "hello"));
      ok(s.close()); ok(s.close());
      refused(s.snapshot(), "closed"); refused(msg(s, "x"), "closed"); refused(s.beginTurn("c1"), "closed");
      refused(adapter.open({ mode: "create", identity: id() }), "already_exists");
      refused(adapter.open({ mode: "open", identity: { sessionId: "other", compatibilityKey: "k1" } }), "incompatible");
      // A different key opens normally and is never written.
      const again = ok(adapter.open({ mode: "open", identity: id("k2") }));
      const view = snap(again);
      expect(view.session).toMatchObject({ sessionId: "s1", formatVersion: 2, lifecycle: "running", compatibilityKey: "k1" });
      expect(view.items.map(item => item.text)).toEqual(["hello"]);
      ok(again.close());
      expect(snap(ok(adapter.open({ mode: "open", identity: id() }))).session.compatibilityKey).toBe("k1");
    });

    test("acceptance commits a pending item with the exact signature and allocated IDs", () => {
      const { s } = create();
      const first = ok(msg(s, "one"));
      expect(first).toMatchObject({ duplicate: false, item: { itemId: "auto:1", milestone: "received", acceptedSeq: 1 } });
      expect(first.item.turnId).toBeUndefined();
      expect(first.item.signature).toBe(createHash("sha256")
        .update(JSON.stringify(["participant_message", "c1", "ana", null, "one"]), "utf8").digest("hex"));
      expect(ok(notice(s, "ping")).item).toMatchObject({ itemId: "auto:2", sourceChannelId: "c2",
        signature: createHash("sha256").update(JSON.stringify(["channel_notice", "c1", "channel:c2", "c2", "ping"])).digest("hex") });
      expect(ok(msg(s, "reserved", "c1", "auto:7")).item.itemId).toBe("auto:7");
      expect(ok(msg(s, "next")).item.itemId).toBe("auto:8");
      expect(ok(msg(s, "low", "c1", "auto:3")).item.itemId).toBe("auto:3");
      expect(ok(msg(s, "after")).item.itemId).toBe("auto:9");
      const view = snap(s);
      // Accepted work is outside the timeline and creates no turn.
      expect(view.timeline).toEqual([]); expect(view.turns).toEqual([]);
      expect(view.channels).toEqual([{ channelId: "c1", participantIds: [] }]);
      expect(view.participants).toEqual([{ participantId: "ana" }]);
      expect(view.items.map(item => item.acceptedSeq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(view.revision).toBe(6);
    });

    test("identical retries return the original; conflicts and invalid input change nothing", () => {
      const { adapter, s } = create();
      const original = ok(msg(s, "pay", "c1", "m1"));
      unchanged(s, () => {
        const retry = s.acceptItem({ itemId: "m1", kind: "participant_message", channelId: "c1", senderId: "ana", text: "pay" });
        expect(ok(retry)).toEqual({ item: original.item, duplicate: true });
        expect(retry.ok && retry.revision).toBe(1);
        refused(msg(s, "pay twice", "c1", "m1"), "item_conflict");
        refused(msg(s, "pay", "c9", "m1"), "item_conflict");
        refused(msg(s, "  "), "invalid_input");
        refused(msg(s, "x", " "), "invalid_input");
        refused(s.acceptItem({ kind: "other" as "channel_notice", channelId: "c1", senderId: "ana", text: "x" }), "invalid_input");
        refused(s.acceptItem({ kind: "channel_notice", channelId: "c1", senderId: "channel:c2", text: "no source" }), "invalid_input");
        refused(s.acceptItem(null as never), "invalid_input");
        refused(notice(s, "nobody home", "never-used"), "not_found");
      });
      const turn = begin(s);
      const later = reopen(adapter, s);
      // After restart the retry reports where the original now is.
      expect(ok(msg(later, "pay", "c1", "m1"))).toMatchObject({ duplicate: true, item: { milestone: "taken", turnId: turn.turn.turnId } });
      refused(msg(later, "different", "c1", "m1"), "item_conflict");
    });

    test("beginTurn takes every pending item once, in acceptance order", () => {
      const { s } = create();
      ok(msg(s, "a", "c1", "a")); ok(msg(s, "other", "c2", "z")); ok(notice(s, "n")); ok(msg(s, "b", "c1", "b"));
      expect(ok(s.beginTurn("empty"))).toBeNull();
      const taken = begin(s);
      expect(taken.turn).toMatchObject({ turnId: 1, channelId: "c1", itemIds: ["a", "auto:1", "b"], compatibilityKey: "k1", state: { status: "running" } });
      expect(taken.items.map(item => [item.milestone, item.turnId])).toEqual([["taken", 1], ["taken", 1], ["taken", 1]]);
      expect(taken.entries.map(entry => entry.message)).toEqual([
        { role: "user", content: 'Participant: "ana"\n\na' }, { role: "user", content: "n" }, { role: "user", content: 'Participant: "ana"\n\nb' }]);
      expect(taken.entries.map(entry => [entry.from, entry.kind, entry.itemId, entry.sourceChannelId])).toEqual([
        ["ana", "participant_message", "a", undefined], ["channel:c2", "channel_notice", "auto:1", "c2"], ["ana", "participant_message", "b", undefined]]);
      expect(taken.items.map(item => item.entrySeq)).toEqual(taken.entries.map(entry => entry.seq));
      // One live turn per channel; another channel is independent.
      ok(msg(s, "c", "c1", "c"));
      unchanged(s, () => expect(ok(s.beginTurn("c1"))).toBeNull());
      expect(begin(s, "c2").turn).toMatchObject({ turnId: 2, itemIds: ["z"] });
      const view = snap(s);
      expect(view.channels).toEqual([{ channelId: "c1", participantIds: ["ana"] }, { channelId: "c2", participantIds: ["ana"] }]);
      expect(view.items.find(item => item.itemId === "c")).toMatchObject({ milestone: "received" });
      const seqs = view.timeline.map(entry => entry.seq);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); expect(new Set(seqs).size).toBe(seqs.length);
    });

    test("the finish decision and the pending check are one step", () => {
      const { s } = create();
      ok(msg(s, "a", "c1", "a"));
      const { turn } = begin(s);
      unchanged(s, () => refused(s.finishTurn(turn.turnId, { status: "completed" }), "invalid_state"));
      say(s, turn.turnId, "answer");
      // Accept commits first: the turn stays open and takes the item itself.
      ok(msg(s, "b", "c1", "b"));
      unchanged(s, () => expect(ok(s.finishTurn(turn.turnId, { status: "completed" }))).toEqual({ finished: false, pending: 1 }));
      unchanged(s, () => expect(ok(s.beginTurn("c1"))).toBeNull());
      expect(ok(s.takePending(turn.turnId))).toMatchObject({ turn: { itemIds: ["a", "b"] }, items: [{ itemId: "b", turnId: turn.turnId }] });
      unchanged(s, () => expect(ok(s.takePending(turn.turnId)).items).toEqual([]));
      unchanged(s, () => refused(s.finishTurn(turn.turnId, { status: "completed" }), "invalid_state"));
      say(s, turn.turnId, "second answer");
      expect(ok(s.finishTurn(turn.turnId, { status: "completed" }))).toMatchObject({ finished: true, turn: { state: { status: "completed" }, itemIds: ["a", "b"] } });
      // Finish commits first: the item starts the next turn, exactly once.
      ok(msg(s, "c", "c1", "c"));
      unchanged(s, () => {
        refused(s.takePending(turn.turnId), "invalid_state");
        refused(s.finishTurn(turn.turnId, { status: "completed" }), "invalid_state");
        refused(s.finishTurn(turn.turnId, { status: "failed", reason: "late" }), "invalid_state");
      });
      expect(begin(s).turn).toMatchObject({ turnId: 2, itemIds: ["c"] });
      expect(snap(s).items.filter(item => item.itemId === "c")).toHaveLength(1);
    });

    test("messages pair calls with results and reject unserializable data without partial writes", () => {
      const { s } = create();
      ok(msg(s, "a"));
      const { turn } = begin(s), t = turn.turnId;
      unchanged(s, () => {
        refused(s.appendMessage(t, { role: "tool", callId: "x", content: "orphan" }), "invalid_input");
        refused(s.appendMessage(t, { role: "user", content: "no" } as never), "invalid_input");
        refused(s.appendMessage(99, { role: "assistant", content: "x", calls: [] }), "not_found");
        refused(s.appendMessage(t, { role: "assistant", content: null, calls: [], providerState: { at: new Date() } }), "serialization_error");
        refused(s.appendMessage(t, { role: "assistant", content: null, calls: [], providerState: { fn() {} } }), "serialization_error");
        refused(s.appendMessage(t, { role: "assistant", content: null, calls: [], providerState: { gap: undefined } }), "serialization_error");
        refused(s.appendMessage(t, { role: "assistant", content: null, calls: [], providerState: 10n }), "serialization_error");
        refused(s.appendMessage(t, { role: "assistant", content: null, calls: [{ id: "x", name: "echo", arguments: "{}" }, { id: "x", name: "echo", arguments: "{}" }] }), "invalid_input");
      });
      const state = { opaque: [1, "two", { three: null }] };
      const requested = ok(s.appendMessage(t, { role: "assistant", content: "working", providerState: state,
        calls: [{ id: "c1", name: "echo", arguments: "{\"a\":1}" }, { id: "c2", name: "echo", arguments: "{}" }] }));
      expect(requested).toMatchObject({ from: "agent", turnId: t, channelId: "c1" });
      unchanged(s, () => {
        refused(s.appendMessage(t, { role: "assistant", content: "too early", calls: [] }), "invalid_state");
        refused(s.finishTurn(t, { status: "completed" }), "invalid_state");
      });
      expect(ok(s.appendMessage(t, { role: "tool", callId: "c2", content: "r2" })).from).toBe("tool");
      unchanged(s, () => refused(s.appendMessage(t, { role: "tool", callId: "c2", content: "again" }), "invalid_input"));
      ok(s.appendMessage(t, { role: "tool", callId: "c1", content: "r1" }));
      unchanged(s, () => refused(s.appendMessage(t, { role: "assistant", content: null, calls: [{ id: "c1", name: "echo", arguments: "{}" }] }), "invalid_input"));
      say(s, t, "done");
      ok(s.finishTurn(t, { status: "completed" }));
      const stored = snap(s).timeline.find(entry => entry.seq === requested.seq)!.message;
      expect(stored.role === "assistant" && stored.providerState).toEqual(state);
    });

    test("results and snapshots never alias stored records", () => {
      const { s } = create();
      const accepted = ok(msg(s, "a"));
      accepted.item.text = "tampered";
      const taken = begin(s);
      taken.turn.itemIds.push("ghost"); taken.entries[0]!.message = { role: "user", content: "tampered" };
      const view = snap(s);
      view.items[0]!.milestone = "seen"; view.turns[0]!.state = { status: "completed" };
      const fresh = snap(s);
      expect(fresh.items[0]).toMatchObject({ text: "a", milestone: "taken" });
      expect(fresh.turns[0]).toMatchObject({ itemIds: ["auto:1"], state: { status: "running" } });
      expect(fresh.timeline[0]!.message).toEqual({ role: "user", content: 'Participant: "ana"\n\na' });
    });

    test("receipts advance only for a running turn's items and only forward", () => {
      const { adapter, s } = create();
      ok(msg(s, "a", "c1", "a")); ok(msg(s, "elsewhere", "c2", "z"));
      const { turn } = begin(s), t = turn.turnId;
      begin(s, "c2");
      expect(ok(s.confirmReceipts(t, "delivered")).map(item => [item.itemId, item.milestone])).toEqual([["a", "delivered"]]);
      unchanged(s, () => expect(ok(s.confirmReceipts(t, "delivered"))).toEqual([]));
      ok(msg(s, "b", "c1", "b")); ok(s.takePending(t));
      expect(ok(s.confirmReceipts(t, "seen")).map(item => item.itemId)).toEqual(["a", "b"]);
      unchanged(s, () => {
        expect(ok(s.confirmReceipts(t, "delivered"))).toEqual([]);
        refused(s.confirmReceipts(t, "taken" as "seen"), "invalid_input");
        refused(s.confirmReceipts(77, "seen"), "not_found");
      });
      // Another channel's inference never advanced these.
      expect(snap(s).items.find(item => item.itemId === "z")!.milestone).toBe("taken");
      ok(s.finishTurn(t, { status: "interrupted", reason: "stop" }));
      unchanged(s, () => refused(s.confirmReceipts(t, "seen"), "invalid_state"));
      const view = snap(reopen(adapter, s));
      expect(view.items.filter(item => item.channelId === "c1").map(item => [item.milestone, item.turnId])).toEqual([["seen", t], ["seen", t]]);
    });

    test("failed and interrupted turns keep their record, fence late output and leave the channel usable", () => {
      const { s } = create();
      for (const status of ["failed", "interrupted"] as const) {
        ok(msg(s, `ask ${status}`));
        const { turn } = begin(s), t = turn.turnId;
        call(s, t, `${status}-1`);
        ok(s.appendMessage(t, { role: "tool", callId: `${status}-1`, content: "kept" }));
        call(s, t, `${status}-2`);
        ok(msg(s, "queued behind", "c1", `${status}-queued`));
        unchanged(s, () => refused(s.finishTurn(t, { status, reason: " " }), "invalid_input"));
        expect(ok(s.finishTurn(t, { status, reason: "boom" }))).toMatchObject({ finished: true,
          turn: { state: { status, reason: "boom", uncertainCallIds: [`${status}-2`] } } });
        // The late result of the uncertain call, a late receipt and a late take all commit nothing.
        unchanged(s, () => {
          refused(s.appendMessage(t, { role: "tool", callId: `${status}-2`, content: "late" }), "invalid_state");
          refused(s.appendMessage(t, { role: "assistant", content: "late", calls: [] }), "invalid_state");
          refused(s.confirmReceipts(t, "seen"), "invalid_state");
          refused(s.takePending(t), "invalid_state");
          refused(s.checkpointTurn(t), "invalid_state");
          refused(s.finishTurn(t, { status: "completed" }), "invalid_state");
          refused(s.finishTurn(t, { status: "interrupted", reason: "again" }), "invalid_state");
        });
        const view = snap(s);
        expect(view.timeline.filter(entry => entry.turnId === t).map(entry => entry.message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(view.items.find(item => item.turnId === t)).toMatchObject({ milestone: "taken" });
        // Fresh work runs on the same channel; the uncertain call stays unanswered forever.
        const next = begin(s);
        expect(next.turn.itemIds).toEqual([`${status}-queued`]);
        say(s, next.turn.turnId, "fresh");
        ok(s.finishTurn(next.turn.turnId, { status: "completed" }));
        expect(snap(s).turns.find(row => row.turnId === t)!.state).toEqual({ status, reason: "boom", uncertainCallIds: [`${status}-2`] });
      }
    });

    test("IDs, seq and revision keep increasing across reopen", () => {
      const { adapter, s } = create();
      ok(msg(s, "a"));
      const first = begin(s);
      say(s, first.turn.turnId, "one");
      ok(s.finishTurn(first.turn.turnId, { status: "completed" }));
      const before = snap(s);
      const again = reopen(adapter, s);
      // A clean, idle reopen writes nothing.
      expect(snap(again)).toEqual(before);
      expect(ok(msg(again, "b")).item).toMatchObject({ itemId: "auto:2", acceptedSeq: before.revision + 1 });
      const second = begin(again);
      expect(second.turn.turnId).toBe(2);
      expect(second.entries[0]!.seq).toBeGreaterThan(before.timeline.at(-1)!.seq);
      const after = snap(again);
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.timeline.slice(0, before.timeline.length)).toEqual(before.timeline);
    });

    test("suspension refuses new messages, starts nothing and still accepts notices", () => {
      const { s } = create();
      ok(msg(s, "a", "c1", "a")); ok(msg(s, "idle channel", "c2", "z"));
      const { turn } = begin(s);
      unchanged(s, () => { refused(s.checkpointTurn(turn.turnId), "invalid_state"); refused(s.completeSuspend(), "invalid_state"); });
      expect(ok(s.beginSuspend()).lifecycle).toBe("suspending");
      unchanged(s, () => {
        expect(ok(s.beginSuspend()).lifecycle).toBe("suspending");
        refused(msg(s, "new"), "not_running");
        refused(s.beginTurn("c2"), "not_running");
        refused(s.takePending(turn.turnId), "not_running");
        refused(s.resume(), "invalid_state");
        refused(s.completeSuspend(), "invalid_state");
        // A retry of accepted input is still answered.
        expect(ok(msg(s, "a", "c1", "a"))).toMatchObject({ duplicate: true, item: { milestone: "taken" } });
      });
      expect(ok(notice(s, "from finishing work")).item.milestone).toBe("received");
      expect(snap(s).items.filter(item => item.milestone === "received").map(item => item.channelId)).toEqual(["c2", "c1"]);
    });

    test("while suspending a finished turn completes and a turn needing inference is checkpointed", () => {
      const { adapter, s } = create();
      ok(msg(s, "done soon", "c1")); ok(msg(s, "needs tools", "c2")); ok(msg(s, "gets a notice", "c3")); ok(msg(s, "just begun", "c4"));
      const done = begin(s, "c1").turn.turnId, tools = begin(s, "c2").turn.turnId, noticed = begin(s, "c3").turn.turnId, fresh = begin(s, "c4").turn.turnId;
      call(s, tools, "t1");
      ok(s.beginSuspend());
      // Naturally finished, nothing pending: complete, never checkpoint.
      say(s, done, "final");
      unchanged(s, () => refused(s.checkpointTurn(done), "invalid_state"));
      expect(ok(s.finishTurn(done, { status: "completed" })).finished).toBe(true);
      // An unanswered call cannot be checkpointed; after its result the next step is inference.
      unchanged(s, () => refused(s.checkpointTurn(tools), "invalid_state"));
      const result = ok(s.appendMessage(tools, { role: "tool", callId: "t1", content: "r" }));
      expect(ok(s.checkpointTurn(tools)).state).toEqual({ status: "suspended", checkpoint: { nextStep: "inference", afterSeq: result.seq } });
      // A notice that won the finish race keeps its turn open: checkpoint, do not take.
      say(s, noticed, "final?");
      ok(notice(s, "wait for me", "c3"));
      unchanged(s, () => expect(ok(s.finishTurn(noticed, { status: "completed" }))).toEqual({ finished: false, pending: 1 }));
      expect(ok(s.checkpointTurn(noticed)).state.status).toBe("suspended");
      unchanged(s, () => { refused(s.completeSuspend(), "invalid_state"); refused(s.checkpointTurn(noticed), "invalid_state"); });
      expect(ok(s.checkpointTurn(fresh)).state.status).toBe("suspended");
      expect(ok(s.completeSuspend()).lifecycle).toBe("suspended");
      unchanged(s, () => {
        expect(ok(s.completeSuspend()).lifecycle).toBe("suspended"); expect(ok(s.beginSuspend()).lifecycle).toBe("suspended");
        refused(msg(s, "new"), "not_running"); refused(notice(s, "new"), "not_running"); refused(s.beginTurn("c1"), "not_running");
        expect(ok(msg(s, "done soon", "c1", "auto:1"))).toMatchObject({ duplicate: true, item: { milestone: "taken", turnId: done } });
        refused(msg(s, "changed", "c1", "auto:1"), "item_conflict");
        expect(ok(s.interruptActive("stop"))).toEqual([]);
      });

      // Clean suspension survives reopen untouched, and nothing runs.
      const suspended = snap(s);
      const wrong = reopen(adapter, s, "k2");
      expect(snap(wrong)).toEqual(suspended);
      unchanged(wrong, () => refused(wrong.resume(), "incompatible"));
      const right = reopen(adapter, wrong);
      expect(snap(right)).toEqual(suspended);
      const resumed = ok(right.resume());
      expect(resumed.session.lifecycle).toBe("running");
      expect(resumed.turns.map(turn => [turn.turnId, turn.state.status])).toEqual([[tools, "running"], [noticed, "running"], [fresh, "running"]]);
      unchanged(right, () => expect(ok(right.resume()).turns).toEqual([]));
      // The resumed turn takes the item that lost the race; it reaches exactly one turn.
      expect(ok(right.takePending(noticed)).items.map(item => item.turnId)).toEqual([noticed]);
      expect(ok(right.beginTurn("c3"))).toBeNull();
      expect(snap(right).turns.find(turn => turn.turnId === done)!.state).toEqual({ status: "completed" });
    });

    test("interruptActive follows the lifecycle", () => {
      const { adapter, s } = create();
      ok(msg(s, "a", "c1")); ok(msg(s, "b", "c2")); ok(msg(s, "waiting", "c3", "w"));
      const one = begin(s, "c1").turn.turnId, two = begin(s, "c2").turn.turnId;
      call(s, one, "x1");
      unchanged(s, () => refused(s.interruptActive(""), "invalid_input"));
      // Running: only running turns, pending input untouched.
      expect(ok(s.interruptActive("stop")).map(turn => [turn.turnId, turn.state])).toEqual([
        [one, { status: "interrupted", reason: "stop", uncertainCallIds: ["x1"] }], [two, { status: "interrupted", reason: "stop", uncertainCallIds: [] }]]);
      unchanged(s, () => expect(ok(s.interruptActive("stop"))).toEqual([]));
      expect(snap(s).items.find(item => item.itemId === "w")!.milestone).toBe("received");

      // Suspending: running and already checkpointed turns; this attempt can no longer suspend.
      ok(msg(s, "c", "c1")); ok(msg(s, "d", "c2"));
      const saved = begin(s, "c1").turn.turnId, active = begin(s, "c2").turn.turnId;
      ok(s.beginSuspend()); ok(s.checkpointTurn(saved));
      expect(ok(s.interruptActive("stop now")).map(turn => [turn.turnId, turn.state.status])).toEqual([[saved, "interrupted"], [active, "interrupted"]]);
      expect(snap(s).session.lifecycle).toBe("running");
      unchanged(s, () => refused(s.completeSuspend(), "invalid_state"));

      // Suspended: clean checkpoints are kept.
      const kept = begin(s, "c3").turn.turnId;
      ok(s.beginSuspend()); ok(s.checkpointTurn(kept)); ok(s.completeSuspend());
      unchanged(s, () => expect(ok(s.interruptActive("stop"))).toEqual([]));
      expect(snap(reopen(adapter, s)).turns.find(turn => turn.turnId === kept)!.state.status).toBe("suspended");
    });

    test("reopen without clean suspension interrupts running and checkpointed turns", () => {
      for (const lifecycle of ["running", "suspending"] as const) {
        const { adapter, s } = create();
        ok(msg(s, "a", "c1", "a")); ok(msg(s, "b", "c2", "b")); ok(msg(s, "never taken", "c3", "p"));
        const one = begin(s, "c1").turn.turnId, two = begin(s, "c2").turn.turnId;
        call(s, one, "u1");
        ok(s.confirmReceipts(one, "seen"));
        if (lifecycle === "suspending") { ok(s.beginSuspend()); ok(s.checkpointTurn(two)); }
        const before = snap(s);
        const again = reopen(adapter, s);
        const view = snap(again);
        expect(view.session.lifecycle).toBe("running");
        expect(view.turns.map(turn => [turn.turnId, turn.state.status])).toEqual([[one, "interrupted"], [two, "interrupted"]]);
        expect(view.turns[0]!.state).toMatchObject({ uncertainCallIds: ["u1"] });
        // Taken items stay with their turn; untaken input stays pending; history is intact.
        expect(view.items.map(item => [item.itemId, item.milestone, item.turnId])).toEqual([["a", "seen", one], ["b", "taken", two], ["p", "received", undefined]]);
        expect(view.timeline).toEqual(before.timeline);
        expect(view.revision).toBeGreaterThan(before.revision);
        // Recovery ran once: a second reopen changes nothing.
        expect(snap(reopen(adapter, again))).toEqual(view);
      }
    });

    test("recovered channels accept and run fresh work without replaying the uncertain call", () => {
      const { adapter, s } = create();
      ok(msg(s, "a"));
      const old = begin(s).turn.turnId;
      call(s, old, "effect");
      const again = reopen(adapter, s);
      unchanged(again, () => refused(again.appendMessage(old, { role: "tool", callId: "effect", content: "late" }), "invalid_state"));
      ok(msg(again, "fresh"));
      const next = begin(again).turn;
      expect(next.turnId).toBe(old + 1);
      say(again, next.turnId, "ok");
      expect(ok(again.finishTurn(next.turnId, { status: "completed" })).finished).toBe(true);
      expect(snap(again).turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["effect"] });
    });

    test("export needs an idle or cleanly suspended session", () => {
      const { s } = create();
      expect(ok(s.exportArchive())).toMatchObject({ format: "harness-session", archiveVersion: 1, allocation: { nextTurnId: 1, nextSeq: 1, nextItemNumber: 1 } });
      ok(msg(s, "a"));
      unchanged(s, () => refused(s.exportArchive(), "busy"));
      const t = begin(s).turn.turnId;
      unchanged(s, () => refused(s.exportArchive(), "busy"));
      ok(s.beginSuspend()); ok(s.checkpointTurn(t));
      // Every turn is checkpointed, yet suspension has not committed.
      unchanged(s, () => refused(s.exportArchive(), "busy"));
      ok(s.completeSuspend());
      unchanged(s, () => expect(ok(s.exportArchive()).snapshot).toEqual(snap(s)));
      ok(s.resume()); say(s, t, "x"); ok(s.finishTurn(t, { status: "completed" }));
      expect(ok(s.exportArchive()).snapshot.session.lifecycle).toBe("running");
    });

    test("an archive round-trips a suspended session with IDs, deduplication and counters", () => {
      const { s } = create();
      ok(msg(s, "a", "c1", "a")); ok(msg(s, "b", "c2", "auto:5"));
      const one = begin(s, "c1").turn.turnId, two = begin(s, "c2").turn.turnId;
      call(s, one, "k1"); ok(s.appendMessage(one, { role: "tool", callId: "k1", content: "once" }));
      ok(s.confirmReceipts(one, "seen"));
      say(s, two, "bye"); ok(s.finishTurn(two, { status: "completed" }));
      ok(msg(s, "pending", "c2", "p"));
      ok(s.beginSuspend()); ok(s.checkpointTurn(one)); ok(s.completeSuspend());
      const archive = JSON.parse(JSON.stringify(ok(s.exportArchive())));
      const source = snap(s);

      const home = location();
      const imported = home.importArchive(archive, { sessionId: "copy" });
      expect(ok(imported)).toEqual({ ...source.session, sessionId: "copy" });
      refused(home.importArchive(archive), "already_exists");
      refused(home.open({ mode: "open", identity: id() }), "incompatible");
      const copy = ok(home.open({ mode: "open", identity: { sessionId: "copy", compatibilityKey: "k1" } }));
      // Import does not open, start or resume; the copy is the same session state.
      expect(snap(copy)).toEqual({ ...source, session: { ...source.session, sessionId: "copy" } });
      expect(ok(msg(copy, "a", "c1", "a"))).toMatchObject({ duplicate: true, item: { milestone: "seen", turnId: one } });
      refused(msg(copy, "changed", "c2", "p"), "item_conflict");
      expect(ok(copy.resume()).turns.map(turn => turn.turnId)).toEqual([one]);
      expect(ok(msg(copy, "new")).item.itemId).toBe("auto:6");
      expect(begin(copy, "c2").turn).toMatchObject({ turnId: two + 1, itemIds: ["p"] });
      expect(ok(copy.appendMessage(one, { role: "assistant", content: "resumed", calls: [] })).seq).toBeGreaterThan(source.revision);
    });

    test("invalid archives and occupied destinations leave nothing partial", () => {
      const { s } = create();
      ok(msg(s, "a", "c1", "a"));
      const t = begin(s).turn.turnId;
      say(s, t, "x"); ok(s.finishTurn(t, { status: "completed" }));
      const good = JSON.stringify(ok(s.exportArchive()));
      const broken: ((archive: any) => void)[] = [
        a => { a.format = "something-else"; },
        a => { a.archiveVersion = 2; },
        a => { a.snapshot.session.formatVersion = 3; },
        a => { a.snapshot.session.lifecycle = "suspending"; },
        a => { a.snapshot.turns[0].state = { status: "running" }; },
        a => { a.snapshot.turns[0].state = { status: "suspended", checkpoint: { nextStep: "inference", afterSeq: 1 } }; },
        a => { a.snapshot.items[0].text = "edited"; },
        a => { a.snapshot.items[0].turnId = 9; },
        a => { a.snapshot.items.push({ ...a.snapshot.items[0] }); },
        // A second item at an existing acceptance position, otherwise self-consistent.
        a => { const copy = { ...a.snapshot.items[0], itemId: "twin" }; delete copy.turnId; delete copy.entrySeq; copy.milestone = "received";
          a.snapshot.session.lifecycle = "suspended"; a.snapshot.items.push(copy); },
        a => { a.snapshot.timeline.reverse(); },
        a => { a.snapshot.timeline[0].turnId = 4; },
        a => { a.snapshot.turns[0].itemIds = []; },
        a => { a.allocation.nextSeq = 1; },
        a => { a.allocation.nextTurnId = 1; },
        a => { delete a.snapshot.timeline; },
      ];
      for (const damage of broken) {
        const archive = JSON.parse(good); damage(archive);
        const home = location();
        refused(home.importArchive(archive), "invalid_archive");
        refused(home.open({ mode: "open", identity: id() }), "not_found");
      }
      for (const junk of [null, "text", 5, [], {}]) refused(location().importArchive(junk as never), "invalid_archive");
      refused(location().importArchive(JSON.parse(good), { sessionId: " " }), "invalid_input");
      // An occupied destination keeps its own session.
      const occupied = create();
      ok(msg(occupied.s, "mine", "c1", "mine"));
      unchanged(occupied.s, () => refused(occupied.adapter.importArchive(JSON.parse(good)), "already_exists"));
    });
  });
}
