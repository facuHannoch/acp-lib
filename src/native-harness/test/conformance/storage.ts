import { legacyItemSignature } from "../../src/state/storage/policy-metadata.ts";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionStorage, SessionStorageAdapter, StorageErrorCode, StorageResult } from "../../src/contracts/storage.ts";

/** Shared executable contract for storage revision 3 (decisions 0013, 0014). Each call
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
      expect(view.session).toMatchObject({ sessionId: "s1", formatVersion: 4, lifecycle: "running", compatibilityKey: "k1" });
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
        .update(JSON.stringify(["participant_message", "c1", "ana", null, "one", null]), "utf8").digest("hex"));
      expect(ok(notice(s, "ping")).item).toMatchObject({ itemId: "auto:2", sourceChannelId: "c2",
        signature: createHash("sha256").update(JSON.stringify(["channel_notice", "c1", "channel:c2", "c2", "ping", null])).digest("hex") });
      expect(ok(msg(s, "reserved", "c1", "auto:7")).item.itemId).toBe("auto:7");
      expect(ok(msg(s, "next")).item.itemId).toBe("auto:8");
      expect(ok(msg(s, "low", "c1", "auto:3")).item.itemId).toBe("auto:3");
      expect(ok(msg(s, "after")).item.itemId).toBe("auto:9");
      const view = snap(s);
      // Accepted work is outside the timeline and creates no turn.
      expect(view.timeline).toEqual([]); expect(view.turns).toEqual([]);
      expect(view.channels).toEqual([{ channelId: "c1", lifecycle: "open", participantIds: [] }]);
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
      refused(s.beginTurn("empty"), "not_found");
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
      expect(view.channels).toEqual([{ channelId: "c1", lifecycle: "open", participantIds: ["ana"] }, { channelId: "c2", lifecycle: "open", participantIds: ["ana"] }]);
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
      expect(ok(s.checkpointTurn(tools)).state).toMatchObject({ status: "suspended", checkpoint: { nextStep: "inference", afterSeq: result.seq } });
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
      expect(ok(s.exportArchive())).toMatchObject({ format: "harness-session", archiveVersion: 3, allocation: { nextTurnId: 1, nextSeq: 1, nextItemNumber: 1 } });
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

    // ---- Channel controls, decision 0014.
    const lifecycleOf = (s: SessionStorage, channelId: string) => snap(s).channels.find(c => c.channelId === channelId)?.lifecycle;
    const stateOf = (s: SessionStorage, turnId: number) => snap(s).turns.find(t => t.turnId === turnId)!.state.status;
    /** Turn on `c1` that took "a", ran one tool call and recorded its result: at an inference boundary. */
    function atBoundary(s: SessionStorage, channelId = "c1") {
      ok(msg(s, "a", channelId, `a-${channelId}`));
      const turn = begin(s, channelId).turn.turnId;
      call(s, turn, "k"); ok(s.appendMessage(turn, { role: "tool", callId: "k", content: "done" }));
      return turn;
    }

    test("channel suspension closes admission, checkpoints with the backlog kept, and survives reopen", () => {
      const { adapter, s: first } = create();
      let s = first;
      const t = atBoundary(s); ok(msg(s, "other", "c2", "o2"));
      ok(msg(s, "p", "c1", "p"));
      const other = begin(s, "c2").turn.turnId;
      expect(ok(s.beginChannelSuspend("c1"))).toMatchObject({ lifecycle: "suspending" });
      expect(ok(s.beginChannelSuspend("c1")).lifecycle).toBe("suspending");
      // Closed to new input and to taking, for messages and notices alike; retries of accepted input answer.
      unchanged(s, () => {
        refused(msg(s, "new"), "channel_suspended"); refused(notice(s, "new"), "channel_suspended");
        refused(s.takePending(t), "channel_suspended"); refused(s.resumeChannel("c1"), "invalid_state");
        refused(s.deleteChannel("c1"), "channel_busy");
        expect(ok(msg(s, "p", "c1", "p"))).toMatchObject({ duplicate: true, item: { milestone: "received" } });
        refused(msg(s, "different", "c1", "p"), "item_conflict");
      });
      // Another channel keeps running, and the finishing turn may notify an open channel.
      expect(ok(s.acceptItem({ kind: "channel_notice", channelId: "c2", senderId: "channel:c1", sourceChannelId: "c1", text: "hi" })).duplicate).toBe(false);
      say(s, other, "ok");
      expect(ok(s.finishTurn(other, { status: "completed" })).finished).toBe(false); // the notice arrived first
      // A pending item blocks completion: the turn must checkpoint, and the channel suspends with it.
      say(s, t, "answer");
      expect(ok(s.finishTurn(t, { status: "completed" }))).toEqual({ finished: false, pending: 1 });
      expect(lifecycleOf(s, "c1")).toBe("suspending");
      const saved = ok(s.checkpointTurn(t));
      expect(saved.state).toMatchObject({ status: "suspended" });
      expect(lifecycleOf(s, "c1")).toBe("suspended");
      refused(s.exportArchive(), "busy");
      s = reopen(adapter, s); // the session was never suspended: only the channel's commit holds the checkpoint
      expect(lifecycleOf(s, "c1")).toBe("suspended");
      expect(stateOf(s, t)).toBe("suspended");
      expect(snap(s).items.find(item => item.itemId === "p")!.milestone).toBe("received");
      refused(msg(s, "new"), "channel_suspended");
      refused(s.beginTurn("c1"), "channel_suspended");
      const resumed = ok(s.resumeChannel("c1"));
      expect(resumed.channel.lifecycle).toBe("open");
      expect(resumed.turn).toMatchObject({ turnId: t, state: { status: "running" } });
      expect(ok(s.takePending(t)).items.map(item => item.itemId)).toEqual(["p"]);
      expect(ok(s.takePending(t)).items).toEqual([]);
      expect(snap(s).turns.filter(turn => turn.channelId === "c1")).toHaveLength(1);
    });

    test("an idle or already checkpointed channel suspends at once; resume of an open channel is a no-op", () => {
      const { s } = create();
      ok(s.createChannel({ channelId: "idle" }));
      expect(ok(s.beginChannelSuspend("idle")).lifecycle).toBe("suspended");
      unchanged(s, () => expect(ok(s.beginChannelSuspend("idle")).lifecycle).toBe("suspended"));
      refused(msg(s, "x", "idle"), "channel_suspended");
      expect(ok(s.resumeChannel("idle"))).toMatchObject({ channel: { lifecycle: "open" } });
      unchanged(s, () => expect(ok(s.resumeChannel("idle")).turn).toBeUndefined());
      ok(msg(s, "x", "idle"));
      refused(s.beginChannelSuspend("nope"), "not_found");
    });

    test("interrupt competes with checkpoint, completion and late results by commit order", () => {
      const { s } = create();
      // Interrupt first: the channel suspends with no checkpoint, the backlog stays, late results are fenced.
      const t = atBoundary(s); call(s, t, "late"); ok(msg(s, "p", "c1", "p"));
      ok(s.beginChannelSuspend("c1"));
      const first = ok(s.interruptTurn("c1", t, "stop it"));
      expect(first).toMatchObject({ interrupted: true, turn: { turnId: t, state: { status: "interrupted", reason: "stop it", uncertainCallIds: ["late"] } } });
      expect(lifecycleOf(s, "c1")).toBe("suspended");
      unchanged(s, () => {
        refused(s.appendMessage(t, { role: "tool", callId: "late", content: "x" }), "invalid_state");
        refused(s.checkpointTurn(t), "invalid_state"); refused(s.confirmReceipts(t, "seen"), "invalid_state");
        expect(ok(s.interruptTurn("c1", t, "again"))).toMatchObject({ interrupted: false, turn: { state: { status: "interrupted" } } });
      });
      expect(snap(s).items.find(item => item.itemId === "p")!.milestone).toBe("received");
      expect(ok(s.resumeChannel("c1")).turn).toBeUndefined();
      // A stale interrupt never reaches the newer turn that took the backlog.
      const next = begin(s).turn.turnId;
      expect(next).toBe(t + 1);
      unchanged(s, () => expect(ok(s.interruptTurn("c1", t, "stale")).interrupted).toBe(false));
      expect(stateOf(s, next)).toBe("running");
      refused(s.interruptTurn("c2", next, "wrong channel"), "not_found");
      refused(s.interruptTurn("c1", 99, "unknown"), "not_found");
      refused(s.interruptTurn("c1", next, " "), "invalid_input");
      // Checkpoint first: the turn is no longer active and the checkpoint stays.
      ok(s.beginChannelSuspend("c1"));
      ok(s.checkpointTurn(next));
      unchanged(s, () => expect(ok(s.interruptTurn("c1", next, "late")).interrupted).toBe(false));
      expect(stateOf(s, next)).toBe("suspended");
      // A turn that can finish completes and the channel suspends without a checkpoint.
      ok(s.resumeChannel("c1"));
      say(s, next, "done");
      ok(s.beginChannelSuspend("c1"));
      expect(ok(s.finishTurn(next, { status: "completed" })).finished).toBe(true);
      expect(lifecycleOf(s, "c1")).toBe("suspended");
      expect(snap(s).turns.some(turn => turn.state.status === "suspended")).toBe(false);
    });

    test("withdraw competes with take; withdrawn items stay out of the timeline and cannot be revived", () => {
      const { adapter, s: first } = create();
      let s = first;
      ok(msg(s, "m", "c1", "m")); ok(msg(s, "kept", "c1", "k"));
      ok(s.createChannel({ channelId: "c2" }));
      ok(notice(s, "n", "c2"));
      const noticeId = snap(s).items.find(item => item.kind === "channel_notice")!.itemId;
      const w = ok(s.withdrawItem("c1", "m"));
      expect(w).toMatchObject({ outcome: "withdrawn", repeated: false, item: { itemId: "m", milestone: "withdrawn" } });
      expect(w.outcome === "withdrawn" && w.item.withdrawnAt).toBeTruthy();
      expect(ok(s.withdrawItem("c1", "m"))).toMatchObject({ outcome: "withdrawn", repeated: true });
      expect(ok(s.withdrawItem("c2", noticeId))).toMatchObject({ outcome: "withdrawn", repeated: false });
      refused(s.withdrawItem("c2", "k"), "not_found"); refused(s.withdrawItem("c1", "none"), "not_found");
      // Retry cannot make it pending again, in any lifecycle and after reopen.
      s = reopen(adapter, s);
      expect(ok(msg(s, "m", "c1", "m"))).toMatchObject({ duplicate: true, item: { milestone: "withdrawn" } });
      refused(msg(s, "changed", "c1", "m"), "item_conflict");
      expect(ok(s.withdrawItem("c1", "m")).outcome).toBe("withdrawn");
      expect(ok(s.beginTurn("c2"))).toBeNull();
      const taken = begin(s);
      expect(taken.items.map(item => item.itemId)).toEqual(["k"]);
      expect(snap(s).timeline.some(entry => entry.itemId === "m")).toBe(false);
      expect(snap(s).items.map(item => item.itemId)).toContain("m");
      expect(snap(s).channels[0]!.participantIds).toEqual(["ana"]);
      // Take won: the owning turn is reported and nothing changes, also after the turn ended.
      unchanged(s, () => expect(ok(s.withdrawItem("c1", "k"))).toMatchObject({ outcome: "taken", turnId: taken.turn.turnId, item: { milestone: "taken" } }));
      say(s, taken.turn.turnId, "x"); ok(s.finishTurn(taken.turn.turnId, { status: "completed" }));
      expect(ok(s.withdrawItem("c1", "k")).outcome).toBe("taken");
      // Withdrawal works while suspended, so a backlog can be cleared.
      ok(msg(s, "later", "c1", "l")); ok(s.beginChannelSuspend("c1"));
      expect(ok(s.withdrawItem("c1", "l")).outcome).toBe("withdrawn");
    });

    test("create, edit, delete and retired IDs", () => {
      const { adapter, s: first } = create();
      let s = first;
      const made = ok(s.createChannel({ channelId: "c1", displayName: "  Alice  " }));
      expect(made).toMatchObject({ created: true, channel: { channelId: "c1", displayName: "Alice", lifecycle: "open" } });
      unchanged(s, () => {
        expect(ok(s.createChannel({ channelId: "c1", displayName: "Alice" })).created).toBe(false);
        refused(s.createChannel({ channelId: "c1", displayName: "Other" }), "already_exists");
        refused(s.createChannel({ channelId: "c1" }), "already_exists");
        refused(s.createChannel({ channelId: " " }), "invalid_input");
        refused(s.createChannel({ channelId: "x", displayName: "" }), "invalid_input");
        refused(s.createChannel({ channelId: "x", displayName: "n".repeat(201) }), "invalid_input");
        refused(s.editChannel("c1", "  "), "invalid_input"); refused(s.editChannel("nope", "n"), "not_found");
        expect(ok(s.editChannel("c1", "Alice")).displayName).toBe("Alice");
      });
      expect(snap(s).turns).toEqual([]); // creating starts nothing
      expect(ok(notice(s, "hi", "c1")).duplicate).toBe(false); // an explicit create is a record
      expect(ok(s.editChannel("c1", "Alicia"))).toMatchObject({ displayName: "Alicia", lifecycle: "open" });
      expect(ok(s.editChannel("c1", null)).displayName).toBeUndefined();
      ok(s.editChannel("c1", "Named"));
      // First send still creates an unused channel.
      ok(msg(s, "first", "fresh", "f")); expect(lifecycleOf(s, "fresh")).toBe("open");
      // Delete: acceptance first blocks it; every unfinished state blocks it.
      refused(s.deleteChannel("fresh"), "channel_busy");
      const t = begin(s, "fresh").turn.turnId;
      refused(s.deleteChannel("fresh"), "channel_busy");
      ok(s.beginChannelSuspend("fresh")); ok(s.checkpointTurn(t));
      refused(s.deleteChannel("fresh"), "channel_busy"); // a checkpoint blocks, resolved or not
      ok(s.resumeChannel("fresh")); say(s, t, "x"); ok(s.finishTurn(t, { status: "completed" }));
      ok(s.beginChannelSuspend("fresh")); // deletion from suspended is allowed once nothing is unresolved
      const gone = ok(s.deleteChannel("fresh"));
      expect(gone).toMatchObject({ lifecycle: "retired", participantIds: ["ana"] });
      unchanged(s, () => {
        expect(ok(s.deleteChannel("fresh")).lifecycle).toBe("retired");
        refused(msg(s, "again", "fresh"), "channel_retired"); refused(notice(s, "again", "fresh"), "channel_retired");
        refused(s.createChannel({ channelId: "fresh" }), "channel_retired"); refused(s.editChannel("fresh", "n"), "channel_retired");
        refused(s.beginChannelSuspend("fresh"), "channel_retired"); refused(s.resumeChannel("fresh"), "channel_retired");
        refused(s.beginTurn("fresh"), "channel_retired");
        expect(ok(msg(s, "first", "fresh", "f")).duplicate).toBe(true); // a duplicate answers before the retirement check
      });
      s = reopen(adapter, s);
      expect(lifecycleOf(s, "fresh")).toBe("retired");
      refused(msg(s, "again", "fresh"), "channel_retired");
      expect(snap(s).timeline.filter(entry => entry.channelId === "fresh").length).toBeGreaterThan(0);
      // Delete wins over a later send; withdrawing the backlog first makes delete possible.
      ok(msg(s, "x", "c9", "x9")); refused(s.deleteChannel("c9"), "channel_busy");
      ok(s.withdrawItem("c9", "x9")); expect(ok(s.deleteChannel("c9")).lifecycle).toBe("retired");
      // Allowed while the session is suspended too, and retirement survives.
      ok(s.beginSuspend()); ok(s.completeSuspend());
      expect(ok(s.createChannel({ channelId: "late", displayName: "L" })).created).toBe(true);
      expect(ok(s.deleteChannel("late")).lifecycle).toBe("retired");
      refused(msg(s, "x", "late"), "channel_retired"); // retired is reported before the session check
      refused(msg(s, "x", "open-one"), "not_running");
    });

    test("session resume skips an individually suspended channel and never checks its key", () => {
      const { adapter, s: first } = create();
      let s = first;
      const a = atBoundary(s, "c1"); ok(msg(s, "p", "c1", "p")); ok(msg(s, "q", "c2", "q"));
      ok(s.beginChannelSuspend("c1")); ok(s.checkpointTurn(a));
      ok(s.beginSuspend());
      refused(msg(s, "x", "c1"), "not_running"); // both closed: the session answers first
      refused(s.takePending(a), "invalid_state");
      ok(s.completeSuspend());
      // Another configuration resumes the session; the old checkpoint is neither resumed nor blocking.
      s = reopen(adapter, s, "k2");
      expect(lifecycleOf(s, "c1")).toBe("suspended");
      expect(ok(s.resume()).turns).toEqual([]);
      expect(stateOf(s, a)).toBe("suspended");
      expect(snap(s).session.lifecycle).toBe("running");
      unchanged(s, () => refused(s.resumeChannel("c1"), "incompatible")); // checked only when it would continue the turn
      expect(begin(s, "c2").items.map(item => item.itemId)).toEqual(["q"]); // other work runs
      s = reopen(adapter, s, "k1");
      expect(ok(s.resumeChannel("c1")).turn).toMatchObject({ turnId: a, state: { status: "running" } });
      expect(ok(s.takePending(a)).items.map(item => item.itemId)).toEqual(["p"]);
    });

    test("resuming a channel during session suspension clears only the channel suspension", () => {
      const { adapter, s: first } = create();
      let s = first;
      const a = atBoundary(s); ok(msg(s, "p", "c1", "p"));
      ok(s.beginChannelSuspend("c1")); ok(s.checkpointTurn(a));
      ok(s.beginSuspend()); ok(s.completeSuspend());
      const resumed = ok(s.resumeChannel("c1"));
      expect(resumed.channel.lifecycle).toBe("open");
      expect(resumed.turn).toBeUndefined(); // starts no work
      expect(stateOf(s, a)).toBe("suspended"); // the checkpoint now sits under the session suspension
      refused(s.beginTurn("c1"), "not_running"); refused(msg(s, "x", "c1"), "not_running");
      refused(s.deleteChannel("c1"), "channel_busy");
      s = reopen(adapter, s); // a clean session suspension keeps it
      expect(stateOf(s, a)).toBe("suspended");
      const back = ok(s.resume());
      expect(back.turns.map(turn => turn.turnId)).toEqual([a]);
      expect(ok(s.takePending(a)).items.map(item => item.itemId)).toEqual(["p"]);
      // Suspending the channel again while the session is suspended keeps the checkpoint.
      ok(s.beginSuspend()); ok(s.checkpointTurn(a)); ok(s.completeSuspend());
      expect(lifecycleOf(s, "c1")).toBe("open");
      expect(ok(s.beginChannelSuspend("c1")).lifecycle).toBe("suspended");
      expect(ok(s.resume()).turns).toEqual([]);
      expect(stateOf(s, a)).toBe("suspended");
    });

    test("stop and crash keep committed channel suspensions and interrupt everything else", () => {
      for (const crash of [false, true]) {
        const { adapter, s: first } = create();
        let s = first;
        const a = atBoundary(s, "c1"), b = atBoundary(s, "c2"), c = atBoundary(s, "c3"), d = atBoundary(s, "c4");
        ok(msg(s, "p", "c1", "p")); ok(msg(s, "r", "c3", "r"));
        ok(s.beginChannelSuspend("c1")); ok(s.checkpointTurn(a)); // committed individually
        ok(s.beginChannelSuspend("c3")); // still suspending: its suspension never commits
        ok(s.beginSuspend()); ok(s.checkpointTurn(b)); // c2's checkpoint belongs to the unfinished session suspension
        call(s, d, "open-call"); // c4 is mid-iteration
        let ended: number[];
        if (crash) { s = reopen(adapter, s); ended = snap(s).turns.filter(t => t.state.status === "interrupted").map(t => t.turnId); }
        else ended = ok(s.interruptActive("stop")).map(t => t.turnId);
        expect(ended.sort()).toEqual([b, c, d]);
        const view = snap(s);
        expect(view.session.lifecycle).toBe("running");
        expect(stateOf(s, a)).toBe("suspended");
        expect(lifecycleOf(s, "c1")).toBe("suspended");
        expect(lifecycleOf(s, "c3")).toBe("open"); // back to open, its turn interrupted
        expect(view.turns.find(t => t.turnId === d)!.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["open-call"] });
        expect(view.items.find(item => item.itemId === "r")!.milestone).toBe("received"); // backlog preserved
        // The interrupted channel accepts new work; the suspended one still waits for its resume.
        ok(msg(s, "again", "c3", "again")); expect(begin(s, "c3").items.map(item => item.itemId)).toEqual(["r", "again"]);
        refused(msg(s, "x", "c1"), "channel_suspended");
        expect(ok(s.resumeChannel("c1")).turn).toMatchObject({ turnId: a });
      }
    });

    test("a crash during a channel suspension, before it commits, interrupts the turn and keeps the backlog", () => {
      const { adapter, s: first } = create();
      const t = atBoundary(first); call(first, t, "inflight"); ok(msg(first, "p", "c1", "p"));
      ok(first.beginChannelSuspend("c1"));
      const s = reopen(adapter, first);
      expect(lifecycleOf(s, "c1")).toBe("open");
      expect(snap(s).turns[0]!.state).toMatchObject({ status: "interrupted", uncertainCallIds: ["inflight"] });
      expect(snap(s).items.find(item => item.itemId === "p")!.milestone).toBe("received");
      ok(msg(s, "new", "c1", "n"));
      expect(begin(s).items.map(item => item.itemId)).toEqual(["p", "n"]);
    });

    test("export of a running session needs no checkpoint and no suspending channel", () => {
      const { s } = create();
      const t = atBoundary(s); say(s, t, "done");
      ok(s.beginChannelSuspend("c1"));
      refused(s.exportArchive(), "busy"); // suspending
      ok(s.finishTurn(t, { status: "completed" }));
      expect(ok(s.exportArchive()).snapshot.channels[0]!.lifecycle).toBe("suspended"); // no checkpoint, no backlog
      ok(s.resumeChannel("c1"));
      const u = atBoundary(s, "c2"); ok(s.beginChannelSuspend("c2")); ok(s.checkpointTurn(u));
      refused(s.exportArchive(), "busy"); // a checkpoint on a suspended channel
      ok(s.beginSuspend()); ok(s.completeSuspend());
      expect(ok(s.exportArchive()).snapshot.turns.some(turn => turn.state.status === "suspended")).toBe(true);
    });

    /** A suspended-session archive carrying every new record kind. */
    function richArchive() {
      const { s } = create();
      ok(s.createChannel({ channelId: "named", displayName: "Named" }));
      const a = atBoundary(s, "c1"); ok(msg(s, "p", "c1", "p"));
      ok(msg(s, "w", "c2", "w")); ok(s.withdrawItem("c2", "w"));
      ok(s.beginChannelSuspend("c1")); ok(s.checkpointTurn(a));
      ok(msg(s, "gone", "c3", "g")); ok(s.withdrawItem("c3", "g")); ok(s.deleteChannel("c3"));
      ok(s.beginSuspend()); ok(s.completeSuspend());
      return { s, a, archive: JSON.parse(JSON.stringify(ok(s.exportArchive()))) };
    }

    test("an archive round-trips channel state, names, withdrawn items, retired IDs and checkpoints", () => {
      const { s, a, archive } = richArchive();
      expect(archive.archiveVersion).toBe(3);
      const home = location();
      ok(home.importArchive(archive, { sessionId: "copy" }));
      const copy = ok(home.open({ mode: "open", identity: { sessionId: "copy", compatibilityKey: "k1" } }));
      expect(snap(copy)).toEqual({ ...snap(s), session: { ...snap(s).session, sessionId: "copy" } });
      expect(snap(copy).channels.map(c => [c.channelId, c.lifecycle, c.displayName])).toEqual(
        [["named", "open", "Named"], ["c1", "suspended", undefined], ["c2", "open", undefined], ["c3", "retired", undefined]]);
      expect(ok(msg(copy, "w", "c2", "w"))).toMatchObject({ duplicate: true, item: { milestone: "withdrawn" } });
      refused(msg(copy, "x", "c3"), "channel_retired");
      // The imported individual suspension survives a session resume and ends only by its own resume.
      expect(ok(copy.resume()).turns).toEqual([]);
      expect(ok(copy.resumeChannel("c1")).turn).toMatchObject({ turnId: a });
    });

    test("import rejects archives that open would interrupt or that would run a retired channel", () => {
      const { archive } = richArchive();
      const broken: [string, (archive: any) => void][] = [
        ["suspending channel", a => { a.snapshot.channels[1].lifecycle = "suspending"; }],
        ["retired channel holds a checkpoint", a => { a.snapshot.channels[1].lifecycle = "retired"; }],
        ["unknown channel state", a => { a.snapshot.channels[0].lifecycle = "paused"; }],
        ["bad name", a => { a.snapshot.channels[0].displayName = ""; }],
        ["withdrawn with a turn link", a => { const w = a.snapshot.items.find((i: any) => i.milestone === "withdrawn"); w.turnId = 1; w.entrySeq = 1; }],
        ["withdrawn without a time", a => { delete a.snapshot.items.find((i: any) => i.milestone === "withdrawn").withdrawnAt; }],
        ["withdrawal time on a pending item", a => { a.snapshot.items.find((i: any) => i.milestone === "received").withdrawnAt = "t"; }],
        ["pending item on a retired channel", a => { const item = a.snapshot.items.find((i: any) => i.milestone === "received");
          a.snapshot.channels.find((c: any) => c.channelId === item.channelId).lifecycle = "retired"; }],
        ["checkpoint nothing holds", a => { a.snapshot.channels[1].lifecycle = "open"; a.snapshot.session.lifecycle = "running"; }],
      ];
      for (const [label, damage] of broken) {
        const copy = JSON.parse(JSON.stringify(archive)); damage(copy);
        const home = location();
        expect([label, home.importArchive(copy).ok ? "ok" : "rejected"]).toEqual([label, "rejected"]);
        refused(home.open({ mode: "open", identity: id() }), "not_found");
      }
      // A running turn on a retired channel is rejected in a running session as well.
      const idle = JSON.parse(JSON.stringify(archive));
      idle.snapshot.session.lifecycle = "running";
      for (const channel of idle.snapshot.channels) channel.lifecycle = "open";
      idle.snapshot.items = idle.snapshot.items.filter((i: any) => i.milestone !== "received");
      idle.snapshot.turns[0].state = { status: "running" };
      idle.snapshot.channels[1].lifecycle = "retired";
      refused(location().importArchive(idle), "invalid_archive");
    });

    test("archive version 1 from the persistence revision imports with every channel open", () => {
      const { s } = create();
      const t = atBoundary(s); ok(msg(s, "p", "c1", "p"));
      ok(s.beginSuspend()); ok(s.checkpointTurn(t)); ok(s.completeSuspend());
      const v1 = JSON.parse(JSON.stringify(ok(s.exportArchive())));
      v1.archiveVersion = 1; v1.snapshot.session.formatVersion = 2;
      for (const item of v1.snapshot.items) { item.signature = legacyItemSignature(item); delete item.policy; delete item.explicitPolicy; }
      for (const channel of v1.snapshot.channels) { delete channel.lifecycle; delete channel.displayName; }
      const home = location();
      ok(home.importArchive(JSON.parse(JSON.stringify(v1))));
      const copy = ok(home.open({ mode: "open", identity: id() }));
      expect(snap(copy).session.formatVersion).toBe(4);
      expect(snap(copy).channels).toEqual([{ channelId: "c1", lifecycle: "open", participantIds: ["ana"] }]);
      expect(ok(copy.resume()).turns.map(turn => turn.turnId)).toEqual([t]); // session-wide resume, as before
      expect(ok(copy.takePending(t)).items.map(item => item.itemId)).toEqual(["p"]);
      // Version 1 cannot carry withdrawn items or newer channel fields it never had.
      const bad = JSON.parse(JSON.stringify(v1)); bad.snapshot.items[0].milestone = "withdrawn"; bad.snapshot.items[0].withdrawnAt = "t";
      refused(location().importArchive(bad), "invalid_archive");
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
        a => { a.archiveVersion = 4; },
        a => { a.snapshot.session.formatVersion = 5; },
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
