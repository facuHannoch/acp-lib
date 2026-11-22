/**
 * The native controller by itself, against a stand-in host: what it holds, reports and settles for one
 * channel (acp-client integration plan, Gate 2). The real process is exercised in `checkpoint.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { NativeController, NativeTurnError } from "../../src/native/controller.ts";
import type { ChannelPort, ChannelView, NativeHarnessHost } from "../../src/native/host.ts";
import { createMemoryHostRecords } from "../../src/native/records.ts";
import { UnsupportedError } from "../../src/errors.ts";
import type { ChannelEvent } from "../../src/native-harness/src/client.ts";
import { restartConversation } from "../../src/conversation-controller/index.ts";
import type { TurnEvent } from "../../src/conversation-controller/index.ts";
import type { PermissionOutcome, PromptHandlers } from "../../src/types.ts";

function standIn() {
  const records = createMemoryHostRecords();
  const calls: string[] = [];
  let port: ChannelPort | undefined;
  /** Each push waits here until the test accepts it. */
  const pushes: Array<{ id: string; accept(): void; refuse(error: Error): void }> = [];
  const host = {
    sessionId: "agent-1", state: "running", records,
    attach(_channel: string, attached: ChannelPort) { port = attached; return () => { port = undefined; }; },
    async observeAttachment() {},
    subscribeState: () => () => undefined,
    push(input: { id: string; channel: string; sender: string; text: string }) {
      // What the real host does first: the id and payload are saved before anything is sent.
      records.saveSubmission({ ...input, state: "saved" });
      calls.push(`push:${input.id}`);
      return new Promise((resolve, reject) => pushes.push({ id: input.id,
        accept: () => { records.markAccepted(input.id); resolve({ id: input.id }); }, refuse: reject }));
    },
    settle(ids: Iterable<string>) { for (const id of ids) { records.settleSubmission(id); calls.push(`settle:${id}`); } },
    async interrupt(channel: string, turn: string) { calls.push(`interrupt:${channel}:${turn}`); return true; },
    async respondApproval(requestId: string, decision: string) { calls.push(`approval:${requestId}:${decision}`); return true; },
    async readMessage(messageId: string) { calls.push(`read:${messageId}`); return `full text of ${messageId}`; },
  };
  const controller = new NativeController({ host: host as unknown as NativeHarnessHost, channelId: "c1" });
  const turns: TurnEvent[] = [];
  controller.subscribeTurns((event) => turns.push(event));
  const emit = (event: ChannelEvent["event"], revision?: number) => port!.event({ channel: "c1", ...(revision === undefined ? {} : { revision }), event });
  return { controller, host, records, calls, pushes, turns, emit, reconcile: (view: Partial<ChannelView>) => port!.reconcile({ revision: 10, status: undefined, turns: [], items: [], messages: [], ...view }) };
}
function recorder(extra: Partial<PromptHandlers> = {}) {
  const chunks: Array<{ text: string; messageId?: string; startsMessage: boolean }> = [];
  const activity: any[] = [];
  const handlers: PromptHandlers = { onResponseChunk: (chunk) => { chunks.push(chunk); }, onActivity: (event) => { activity.push(event); }, ...extra };
  return { chunks, activity, handlers };
}
const completed = (turnId: string, messageId: string, text: string): ChannelEvent["event"] => ({ type: "message_completed", turnId, messageId, parts: [{ type: "text", text }] });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a turn's early output is held until the prepared prompt attaches", () => {
  test("output and outcome that arrive before prepareTurn are replayed once, in order, and the prompt settles once", async () => {
    const { controller, emit, turns, calls } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "7", items: ["item-x"] });
    emit(completed("7", "model:1", "First."));
    emit({ type: "tool_call", turnId: "7", id: "t1", name: "echo", status: "started", input: "{\"a\":1}" });
    emit({ type: "tool_call", turnId: "7", id: "t1", name: "echo", status: "completed", output: "ok" });
    emit(completed("7", "model:2", "Second."));
    emit({ type: "turn_ended", turnId: "7", outcome: "completed" });
    expect(turns).toEqual([{ kind: "turn_started", turnId: "native-turn-7", cause: { items: [{ id: "item-x" }] }, sentBySession: false }]);

    const seen = recorder(), signals: string[] = [];
    const prepared = controller.prepareTurn("native-turn-7", { handlers: seen.handlers });
    prepared.subscribeOutput((output) => signals.push(output.kind));
    // Preparing started nothing and replayed nothing.
    expect(seen.chunks).toEqual([]);
    expect(prepared.live).toBe(false); // it had already ended: this is a replay
    const result = await prepared.prompt();
    expect(result).toMatchObject({ status: "completed", stopReason: "end_turn", text: "First.\n\nSecond.",
      messages: [{ messageId: "model:1", text: "First." }, { messageId: "model:2", text: "Second." }] });
    expect(seen.chunks).toEqual([{ text: "First.", messageId: "model:1", startsMessage: true }, { text: "Second.", messageId: "model:2", startsMessage: true }]);
    expect(seen.activity).toEqual([
      { kind: "tool", toolCallId: "t1", title: "echo", toolKind: "other", status: "in_progress", rawInput: { a: 1 } },
      { kind: "tool_update", toolCallId: "t1", status: "completed", rawOutput: "ok" }]);
    expect(signals.filter((kind) => kind === "update").length).toBeGreaterThanOrEqual(4);
    expect(calls).toContain("settle:item-x");
    // A second end, or a reconciled view of the same turn, changes nothing afterwards.
    emit({ type: "turn_ended", turnId: "7", outcome: "failed", error: "late" });
    expect(seen.chunks).toHaveLength(2);
  });

  test("a turn still running when prepared is live; its output streams and the harness's turn_ended settles it", async () => {
    const { controller, emit } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    const seen = recorder();
    const prepared = controller.prepareTurn("native-turn-1", { handlers: seen.handlers });
    expect(prepared.live).toBe(true);
    let settled = false;
    const running = prepared.prompt().then((result) => { settled = true; return result; });
    emit({ type: "text_delta", turnId: "1", messageId: "m1", text: "Hel" });
    emit({ type: "text_delta", turnId: "1", messageId: "m1", text: "lo" });
    await tick();
    expect(settled).toBe(false);
    // The committed reply replaces the draft with the same id: only what was not streamed is sent on.
    emit(completed("1", "m1", "Hello there"));
    emit({ type: "turn_ended", turnId: "1", outcome: "completed" });
    expect((await running).messages).toEqual([{ messageId: "m1", text: "Hello there" }]);
    expect(seen.chunks).toEqual([
      { text: "Hel", messageId: "m1", startsMessage: true }, { text: "lo", messageId: "m1", startsMessage: false },
      { text: " there", messageId: "m1", startsMessage: false }]);
  });

  test("a reply larger than one frame is read by reference, in order with the events around it", async () => {
    const { controller, emit, calls } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    emit({ type: "message_completed", turnId: "1", messageId: "big", reference: true });
    emit(completed("1", "after", "Then this."));
    emit({ type: "turn_ended", turnId: "1", outcome: "completed" });
    const result = await controller.prepareTurn("native-turn-1", { handlers: {} }).prompt();
    expect(result.messages.map((message) => message.text)).toEqual(["full text of big", "Then this."]);
    expect(calls).toContain("read:big");
  });

  test("failed and interrupted turns reject with the outcome and the uncertain calls; an interrupt this conversation asked for is a cancel", async () => {
    const { controller, emit, calls } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    emit({ type: "turn_ended", turnId: "1", outcome: "interrupted", error: "process stopped", uncertainCalls: ["call-9"] });
    const error = await controller.prepareTurn("native-turn-1", { handlers: {} }).prompt().catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeTurnError);
    expect(error).toMatchObject({ outcome: "interrupted", uncertainCalls: ["call-9"] });

    emit({ type: "turn_started", turnId: "2", items: [] });
    emit(completed("2", "m", "Partial work."));
    const prepared = controller.prepareTurn("native-turn-2", { handlers: {} });
    const running = prepared.prompt();
    prepared.cancel();
    expect(calls).toContain("interrupt:c1:2"); // targeted: this channel, this turn
    emit({ type: "turn_ended", turnId: "2", outcome: "interrupted", error: "interrupted by the conversation" });
    expect(await running).toMatchObject({ status: "cancelled", stopReason: "cancelled", text: "Partial work." });
    // Once ended, cancel does nothing.
    prepared.cancel();
    expect(calls.filter((call) => call.startsWith("interrupt:"))).toHaveLength(1);
  });
});

describe("inputs and the turns that take them", () => {
  test("send saves each message before pushing it, in order, and resolves on acceptance, promising no turn", async () => {
    const { controller, pushes, records, turns } = standIn();
    await controller.start();
    let accepted = false;
    const sending = controller.send({ turnId: "ignored", messageIds: ["m1", "m2"], operationKind: "prompt",
      messages: [{ id: "m1", text: "one", participantId: "ana" }, { id: "m2", text: "two" }] }).then(() => { accepted = true; });
    await tick();
    expect(records.submissions()).toEqual([{ id: "m1", channel: "c1", sender: "ana", text: "one", state: "saved" }]);
    pushes[0]!.accept();
    await tick();
    expect(pushes.map((push) => push.id)).toEqual(["m1", "m2"]);
    expect(records.submission("m2")).toMatchObject({ sender: "user", text: "two" });
    expect(accepted).toBe(false);
    pushes[1]!.accept();
    await sending;
    expect(turns).toEqual([]);
    await expect(controller.send({ messageIds: ["x", "x"], operationKind: "prompt", messages: [{ id: "x", text: "a" }, { id: "x", text: "a" }] })).rejects.toThrow("repeats");
  });

  test("a take reported before the push is acknowledged still names the message; turn_took extends the turn", async () => {
    const { controller, pushes, emit, turns } = standIn();
    await controller.start();
    const sending = controller.send({ messageIds: ["m1"], operationKind: "prompt", messages: [{ id: "m1", text: "one" }] });
    await tick();
    // The harness took the input and started a turn; the push response has not arrived yet.
    emit({ type: "turn_started", turnId: "3", items: ["m1", "notice-1"] });
    expect(turns[0]).toEqual({ kind: "turn_started", turnId: "native-turn-3", cause: { messageIds: ["m1"], items: [{ id: "notice-1" }] }, sentBySession: false });
    pushes[0]!.accept();
    await sending;
    const second = controller.send({ messageIds: ["m2"], operationKind: "prompt", messages: [{ id: "m2", text: "two" }] });
    await tick();
    emit({ type: "turn_took", turnId: "3", items: ["m2"] });
    expect(turns[1]).toEqual({ kind: "turn_took", turnId: "native-turn-3", cause: { messageIds: ["m2"] } });
    pushes[1]!.accept();
    await second;
    emit({ type: "items_receipt", turnId: "3", items: ["m1"], milestone: "delivered" });
    emit({ type: "items_receipt", turnId: "3", items: ["m1", "m2"], milestone: "seen" });
    expect(controller.receiptOf("m1")).toBe("seen");
  });

  test("a refused push rejects send with the harness's error", async () => {
    const { controller, pushes } = standIn();
    await controller.start();
    const sending = controller.send({ messageIds: ["m1"], operationKind: "prompt", messages: [{ id: "m1", text: "one" }] });
    await tick();
    pushes[0]!.refuse(Object.assign(new Error("Channel c1 is suspended"), { code: "channel_suspended" }));
    await expect(sending).rejects.toMatchObject({ code: "channel_suspended" });
  });
});

describe("approvals", () => {
  const request = (turnId: string, requestId: string): ChannelEvent["event"] =>
    ({ type: "approval_requested", requestId, channel: "c1", turnId, toolCallId: "call-1", tool: "record", arguments: "{\"text\":\"x\"}" });

  test("the pending call goes to the turn's permission handler and is answered once, by request id", async () => {
    const { controller, emit, calls } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    const asked: any[] = [], signals: string[] = [];
    let answer!: (outcome: PermissionOutcome) => void;
    const prepared = controller.prepareTurn("native-turn-1", { handlers: { onPermissionRequest: (permission) => { asked.push(permission); return new Promise((resolve) => { answer = resolve; }); } } });
    prepared.subscribeOutput((output) => signals.push(output.kind));
    const running = prepared.prompt();
    emit(request("1", "req-1"));
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ toolCallId: "call-1", title: "record", options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] });
    expect(signals).toContain("permission_started");
    answer({ outcome: "selected", optionId: "allow_once" });
    await tick();
    expect(calls.filter((call) => call.startsWith("approval:"))).toEqual(["approval:req-1:allow_once"]);
    expect(signals).toContain("permission_ended");
    emit({ type: "turn_ended", turnId: "1", outcome: "completed" });
    await running;
  });

  test("without a handler the call stays unapproved and is answered at once; a cancelled or rejecting handler denies", async () => {
    const { controller, emit, calls } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    const first = controller.prepareTurn("native-turn-1", { handlers: {} }).prompt();
    emit(request("1", "req-1"));
    await tick();
    expect(calls).toContain("approval:req-1:deny");
    emit({ type: "turn_ended", turnId: "1", outcome: "completed" });
    await first;
    emit({ type: "turn_started", turnId: "2", items: [] });
    const second = controller.prepareTurn("native-turn-2", { handlers: { onPermissionRequest: () => ({ outcome: "cancelled" }) } }).prompt();
    emit(request("2", "req-2"));
    await tick();
    expect(calls).toContain("approval:req-2:deny");
    emit({ type: "turn_ended", turnId: "2", outcome: "completed" });
    await second;
  });

  test("a turn that ends while the consumer is deciding does not wait for the answer, and the late answer is not sent", async () => {
    const { controller, emit, calls } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    let answer!: (outcome: PermissionOutcome) => void, aborted = false;
    const running = controller.prepareTurn("native-turn-1", { handlers: { onPermissionRequest: (_request, signal) => {
      signal?.addEventListener("abort", () => { aborted = true; });
      return new Promise((resolve) => { answer = resolve; });
    } } }).prompt();
    emit(request("1", "req-1"));
    await tick();
    emit({ type: "turn_ended", turnId: "1", outcome: "failed", error: "approval_timeout" });
    await expect(running).rejects.toBeInstanceOf(NativeTurnError);
    expect(aborted).toBe(true);
    answer({ outcome: "selected", optionId: "allow_once" });
    await tick();
    expect(calls.filter((call) => call.startsWith("approval:"))).toEqual([]);
  });
});

describe("force stop, abandon and stop are this conversation's only", () => {
  test("forceStop interrupts this channel's active turn by id and rejects its open prompt; a new turn then works", async () => {
    const { controller, emit, calls, host } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    const running = controller.prepareTurn("native-turn-1", { handlers: {} }).prompt();
    const outcome = running.then(() => "settled", (error) => String(error));
    await controller.forceStop();
    expect(await outcome).toContain("forced stop");
    expect(calls).toEqual(["interrupt:c1:1"]);
    expect(host.state).toBe("running"); // the shared process is not this conversation's to stop
    expect(controller.isConnected).toBe(true);
    // The harness's own end for the stopped turn only releases bookkeeping.
    emit({ type: "turn_ended", turnId: "1", outcome: "interrupted", error: "interrupted by the conversation" });
    expect(controller.busy()).toBe(false);
    emit({ type: "turn_started", turnId: "2", items: [] });
    emit({ type: "turn_ended", turnId: "2", outcome: "completed" });
    expect((await controller.prepareTurn("native-turn-2", { handlers: {} }).prompt()).status).toBe("completed");
  });

  test("abandonTurn drops what was held, never interrupts, is idempotent, and leaves an executing turn alone", async () => {
    const { controller, emit, calls } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    emit(completed("1", "m", "held"));
    controller.abandonTurn("native-turn-1", new Error("not run"));
    controller.abandonTurn("native-turn-1", new Error("again"));
    controller.abandonTurn("unknown", new Error("nothing"));
    expect(calls).toEqual([]);
    expect(() => controller.prepareTurn("native-turn-1", { handlers: {} })).toThrow("unknown turn");
    emit({ type: "turn_started", turnId: "2", items: [] });
    const running = controller.prepareTurn("native-turn-2", { handlers: {} }).prompt();
    controller.abandonTurn("native-turn-2", new Error("already executing"));
    emit({ type: "turn_ended", turnId: "2", outcome: "completed" });
    expect((await running).status).toBe("completed");
  });

  test("startFresh is unsupported and changes nothing; the capability says so", async () => {
    const { controller, calls, records } = standIn();
    await controller.start();
    expect(controller.conversationCapabilities).toMatchObject({ nativeSteering: true, freshContext: false, backend: { loadSession: false, listSessions: false } });
    await expect(controller.startFresh()).rejects.toBeInstanceOf(UnsupportedError);
    expect(calls).toEqual([]);
    expect(records.pendingChanges()).toEqual([]);
    expect(controller.isConnected).toBe(true);
    expect(await controller.start()).toEqual({ sessionId: "agent-1", resumed: false });
  });
});

describe("reconciliation after a reopen", () => {
  test("a followed turn that ended meanwhile gets its outcome and the reply it missed, restored once by message id", async () => {
    const { controller, emit, reconcile } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "4", items: [] });
    emit(completed("4", "model:1", "Seen live."));
    const seen = recorder();
    const running = controller.prepareTurn("native-turn-4", { handlers: seen.handlers }).prompt();
    // The connection was lost; the view after the reopen has a second reply and the turn interrupted.
    reconcile({
      turns: [{ turnId: "4", channel: "c1", items: [], state: "interrupted", reason: "Stopped by the host", uncertainCalls: ["hold-1"] }],
      messages: [
        { messageId: "model:1", channel: "c1", turnId: "4", parts: [{ type: "text", text: "Seen live." }] },
        { messageId: "model:2", channel: "c1", turnId: "4", parts: [{ type: "text", text: "Missed." }] }],
    });
    const error = await running.catch((caught) => caught);
    expect(error).toMatchObject({ outcome: "interrupted", uncertainCalls: ["hold-1"] });
    expect(seen.chunks.map((chunk) => chunk.text)).toEqual(["Seen live.", "Missed."]);
  });

  test("a turn that is still running or checkpointed stays pending; one the harness has no record of fails", async () => {
    const { controller, emit, reconcile } = standIn();
    await controller.start();
    emit({ type: "turn_started", turnId: "1", items: [] });
    emit({ type: "turn_started", turnId: "2", items: [] });
    let firstSettled = false;
    const first = controller.prepareTurn("native-turn-1", { handlers: {} }).prompt().finally(() => { firstSettled = true; });
    const second = controller.prepareTurn("native-turn-2", { handlers: {} }).prompt();
    reconcile({ turns: [{ turnId: "1", channel: "c1", items: [], state: "suspended" }] });
    await expect(second).rejects.toThrow("no record of this turn");
    await tick();
    expect(firstSettled).toBe(false);
    expect(controller.busy()).toBe(true);
    emit({ type: "turn_resumed", turnId: "1" });
    emit({ type: "turn_ended", turnId: "1", outcome: "completed" });
    expect((await first).status).toBe("completed");
  });

  test("an unknown ended turn that took one of this conversation's unsettled inputs is reported, already ended; older turns are not", async () => {
    const { controller, records, reconcile, turns } = standIn();
    await controller.start();
    records.saveSubmission({ id: "m1", channel: "c1", sender: "user", text: "hi", state: "unknown" });
    reconcile({
      turns: [
        { turnId: "1", channel: "c1", items: ["old"], state: "completed" },
        { turnId: "2", channel: "c1", items: ["m1"], state: "completed" }],
      messages: [{ messageId: "model:5", channel: "c1", turnId: "2", parts: [{ type: "text", text: "Answered while away." }] }],
    });
    expect(turns).toEqual([{ kind: "turn_started", turnId: "native-turn-2", cause: { messageIds: ["m1"] }, sentBySession: false }]);
    const prepared = controller.prepareTurn("native-turn-2", { handlers: {} });
    expect(prepared.live).toBe(false);
    expect(await prepared.prompt()).toMatchObject({ status: "completed", text: "Answered while away." });
    expect(records.submission("m1")).toBeUndefined();
  });

  test("a checkpoint from an earlier connection that resumes is reported as a turn with the items the view listed", async () => {
    const { controller, emit, reconcile, turns } = standIn();
    await controller.start();
    reconcile({ turns: [{ turnId: "9", channel: "c1", items: ["earlier"], state: "suspended" }] });
    expect(turns).toEqual([]);
    emit({ type: "turn_resumed", turnId: "9" });
    expect(turns).toEqual([{ kind: "turn_started", turnId: "native-turn-9", cause: { items: [{ id: "earlier" }] }, sentBySession: false }]);
  });
});

test("Restart waits for exact-turn stop confirmation and does not start on loss", async () => {
  const { controller, host, emit, calls } = standIn();
  await controller.start();
  emit({ type: "turn_started", turnId: "1", items: [] });
  let confirm!: (interrupted: boolean) => void;
  host.interrupt = (channel, turn) => {
    calls.push(`interrupt:${channel}:${turn}`);
    return new Promise(resolve => { confirm = resolve; });
  };
  let starts = 0;
  const restart = () => restartConversation({ stop: () => controller.stop(), start: () => { starts++; return controller.start(); } });
  const pending = restart();
  expect(calls).toEqual(["interrupt:c1:1"]);
  expect(starts).toBe(0);
  emit({ type: "turn_ended", turnId: "1", outcome: "completed" });
  emit({ type: "turn_started", turnId: "2", items: [] });
  confirm(false);
  await pending;
  expect(calls).toEqual(["interrupt:c1:1"]);
  expect(starts).toBe(1);

  emit({ type: "turn_started", turnId: "3", items: [] });
  host.interrupt = async () => { throw new Error("connection lost"); };
  await expect(restart()).rejects.toThrow("connection lost");
  expect(starts).toBe(1);
});
