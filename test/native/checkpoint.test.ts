/**
 * The first end-to-end checkpoint of the acp-client integration spec: acp-client's public conversation
 * interface (`Agent`, `agent.conversations`, `conversation.prompt`) driving a real scripted harness child
 * process over stdio, with a durable SQLite session in a home that survives restarts. No credentials.
 *
 * Deterministic barriers: the `hold` tool keeps a turn in its tool until the test releases it; an `ask`
 * policy keeps a turn waiting for the consumer's approval; `HARNESS_TEST_FAULT=<storage point>:<n>`
 * kills the harness process, without unwinding, right after that commit.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restartConversation } from "../../src/conversation-controller/index.ts";
import { HarnessClientError, type ChannelChangeResult, type ChannelEvent, type HarnessClient } from "../../src/native-harness/src/client.ts";
import { spawnHarness } from "../../src/native-harness/test/helpers/stdio.ts";
import type { NativeApprovalResponder } from "../../src/native/host.ts";
import type { Agent } from "../../src/agent.ts";
import { createAgentConversationId } from "../../src/agent-ids.ts";
import type { AgentSession } from "../../src/agent-session.ts";
import type { AgentConversationOwnerLifecycle } from "../../src/agent-conversation-owner.ts";
import { UnsupportedError } from "../../src/errors.ts";
import { NativeTurnError } from "../../src/native/controller.ts";
import { createFileHostRecords } from "../../src/native/records.ts";
import type { PermissionOutcome, PermissionRequest } from "../../src/types.ts";
import { hold, nativeRig, record, reply, until, type NativeRig, type Seen } from "./support.ts";

const rigs: NativeRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.clean(); });
async function rigWith(...args: Parameters<typeof nativeRig>) {
  const rig = await nativeRig(...args);
  rigs.push(rig);
  return rig;
}
const two = async (agent: Agent) => [await agent.conversations.create({ title: "Alice" }), await agent.conversations.create({ title: "Bob" })] as unknown as [AgentSession, AgentSession];
const lifecycleOf = (session: AgentSession) => (session as unknown as { ownerLifecycle: AgentConversationOwnerLifecycle }).ownerLifecycle;
const kinds = (events: Seen[], prefix = "turn_") => events.filter((event) => event.kind.startsWith(prefix)).map((event) => `${event.kind}:${event.turnId}`);
const track = <T>(promise: Promise<T>) => {
  const state: { settled: boolean; value?: T; error?: any } = { settled: false };
  promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  return state;
};
/** Assistant message texts acp-client recorded for a conversation, in order. */
async function recordedReplies(agent: Agent, conversation: AgentSession): Promise<string[]> {
  const { records } = await agent.persistence.records.list(conversation.id, { limit: 1000 });
  // A message is written as snapshots of one logical message: the last one is its text.
  const latest = new Map<string, string>();
  for (const entry of records as unknown as Array<Record<string, any>>) {
    if (entry.kind !== "message" || entry.role !== "assistant") continue;
    latest.set(entry.logicalMessageId, entry.content);
  }
  return [...latest.values()];
}

describe("the first end-to-end checkpoint", () => {
  test("native asks use the default and override callback without ACP rules", async () => {
    const rig = await rigWith({ defaultPolicy: "ask", policies: { ask: { fallback: "allow", tools: { record: "ask" } } } });
    rig.script([record("ran"), reply("Done.")]);
    const agent = await rig.open({ permissions: { default: "allow", rules: { "kind:execute": "deny" } } });
    const approved = await agent.conversations.create();
    let handlers = 0;
    const handler = () => { handlers++; return { outcome: "selected", optionId: "deny" } as const; };
    await approved.prompt("run", { onPermissionRequest: handler });
    expect(rig.effects()).toEqual(["ran"]);
    let tool: string | undefined;
    const refused = await agent.conversations.create({ permissionRule(request) { tool = request.tool?.name; return "deny"; } });
    await refused.prompt("refuse", { onPermissionRequest: handler });
    expect(tool).toBe("record");
    expect(handlers).toBe(0);
    expect(rig.effects()).toEqual(["ran"]);
  }, 30_000);

  test("1-3: two conversations share one process and one durable session; input sent while a turn works is accepted and taken by that turn; one approval dispatches one call", async () => {
    const rig = await rigWith({ defaultPolicy: "ask", policies: { ask: { fallback: "allow", tools: { record: "ask" } } } });
    rig.script([record("approved", "rec-1"), reply("Done."), reply("Later.")]);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    const completed = spyOn(lifecycleOf(alice), "afterPrompt");
    const hookIds: string[] = [];
    const beforeDispatch = async (messageId: string) => { hookIds.push(messageId); };
    const aliceEvents = rig.watch(alice), bobEvents = rig.watch(bob);
    // Creating and showing conversations launched nothing.
    expect(host.state).toBe("stopped");
    expect(rig.launches).toEqual([]);
    expect(alice.conversationCapabilities).toMatchObject({ nativeSteering: true, freshContext: false });

    const asked: Array<{ who: string; request: PermissionRequest }> = [];
    let allowAlice!: (outcome: PermissionOutcome) => void;
    // Concurrent first sends.
    const a1 = alice.prompt({ text: "a1", beforeDispatch, handlers: {
      onPermissionRequest: (request) => { asked.push({ who: "alice", request }); return new Promise((resolve) => { allowAlice = resolve; }); },
    } });
    const b1 = bob.prompt("b1", { onPermissionRequest: (request) => { asked.push({ who: "bob", request }); return { outcome: "selected", optionId: "allow_once" }; } });

    // Bob finishes on his own while Alice's turn is still waiting for her approval.
    const bobResult = await b1;
    expect(bobResult).toMatchObject({ status: "completed", text: "Recording.\n\nDone." });
    await until(() => asked.some((entry) => entry.who === "alice"), "alice's approval request");
    expect(alice.state.operation).not.toBeNull();
    expect(rig.effects()).toEqual(["approved"]); // Bob's call ran once; Alice's has not run

    // One process, one session, one channel per conversation.
    expect(host.launches).toBe(1);
    expect(rig.launches.map((launch) => launch.kind)).toEqual(["native-harness"]);
    expect(rig.launches[0]!.target).toContain("--stdio");
    let status = await host.status();
    expect(status.sessionId).toBe(agent.id);
    expect(status.channels.map((channel) => channel.channel).sort()).toEqual([alice.id, bob.id].sort());
    expect(status.channels.find((channel) => channel.channel === alice.id)).toMatchObject({ displayName: "Alice", activeTurn: { state: "running" } });
    expect(status.channels.find((channel) => channel.channel === bob.id)).toMatchObject({ displayName: "Bob", pending: [] });
    expect(alice.internalSessionId).toBe(agent.id);
    expect(bob.internalSessionId).toBe(agent.id);

    // Input sent while Alice's turn works: accepted durably, not yet taken.
    const a2 = alice.prompt({ text: "a2", delivery: "steer", beforeDispatch });
    await until(async () => (await host.status()).channels.find((channel) => channel.channel === alice.id)!.pending.includes(a2.id), "a2 to be accepted");
    const a2State = track(a2);
    expect(a2State.settled).toBe(false);

    // The exact pending call reached the consumer; approving it dispatches it once.
    const request = asked.find((entry) => entry.who === "alice")!.request;
    expect(request).toMatchObject({ toolCallId: "rec-1", title: "record" });
    expect(request.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);
    allowAlice({ outcome: "selected", optionId: "allow_once" });
    const [first, second] = await Promise.all([a1, a2]);
    expect(rig.effects()).toEqual(["approved", "approved"]);
    // The steered input was taken by the turn that was running: both settle with that turn.
    expect(first).toMatchObject({ status: "completed", text: "Recording.\n\nDone." });
    expect(second.operationId).toBe(first.operationId);
    expect(first.operationId).not.toBe(a1.id);
    expect(hookIds).toEqual([a1.id, a2.id]);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ operationId: first.operationId, messageIds: hookIds }));
    expect(kinds(aliceEvents)).toEqual([`turn_started:${first.operationId}`, `turn_completed:${first.operationId}`]);
    expect(aliceEvents.find((event) => event.kind === "turn_started")!.cause.messageIds).toEqual([a1.id]);
    expect(kinds(bobEvents)).toEqual([`turn_started:${bobResult.operationId}`, `turn_completed:${bobResult.operationId}`]);
    status = await host.status();
    expect(status.execution).toBe("idle");
    expect(asked).toHaveLength(2);
    expect(host.launches).toBe(1);
    expect(await recordedReplies(agent, alice)).toEqual(["Recording.", "Done."]);
  }, 30_000);

  test("a rejected native dispatch hook rejects the message without a push or a turn", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice] = await two(agent);
    const events = rig.watch(alice);
    const push = spyOn(host, "push");
    const failed = spyOn(lifecycleOf(alice), "promptFailed");
    const error = new Error("native hook failed");
    const hookIds: string[] = [];
    const prompt = alice.prompt({ text: "do not send", async beforeDispatch(messageId) {
      hookIds.push(messageId);
      throw error;
    } });
    await expect(prompt).rejects.toBe(error);
    expect(hookIds).toEqual([prompt.id]);
    expect(push).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(kinds(events)).toEqual([]);
    expect(await alice.prompt("after rejection")).toMatchObject({ status: "completed", text: "reply 1" });
  }, 30_000);

  test("an interrupted native turn finalizes with the input's message ID", async () => {
    const rig = await rigWith();
    rig.script([hold("interrupted-hook"), reply("Later.")]);
    const agent = await rig.open();
    const [alice] = await two(agent);
    const completed = spyOn(lifecycleOf(alice), "afterPrompt");
    const toolStarted = barrier();
    const hookIds: string[] = [];
    const input = alice.prompt({
      text: "interrupt this",
      async beforeDispatch(messageId) { hookIds.push(messageId); },
      handlers: { onActivity(event) { if (event.kind === "tool") toolStarted.open(); } },
    });
    await toolStarted.waiting;
    alice.interrupt();
    const result = await input;
    expect(result.status).toBe("cancelled");
    expect(hookIds).toEqual([input.id]);
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      operationId: result.operationId, messageIds: hookIds, result,
    }));
  }, 30_000);

  test("4: a conversation-level forceStop interrupts only its own turn; the other channel and the shared process keep running; the interrupted channel takes fresh input", async () => {
    const rig = await rigWith();
    rig.script([hold("k"), reply("Finished."), reply("Next.")]);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    const aliceEvents = rig.watch(alice);
    const failed = spyOn(lifecycleOf(alice), "promptFailed");
    const alicePrompt = alice.prompt("a1");
    const a1 = track(alicePrompt), b1 = bob.prompt("b1");
    await until(() => rig.effects().filter((line) => line === "start:k").length === 2, "both tools to start");
    await until(() => alice.state.operation?.stage === "tool_running" && bob.state.operation?.stage === "tool_running", "both turns to be supervised");

    await alice.connection.forceStop();
    await until(() => a1.settled, "alice's prompt to settle");
    expect(String(a1.error)).toContain("forced stop");
    const failure = aliceEvents.find((event) => event.kind === "turn_failed");
    expect(failure).toBeDefined();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      operationId: failure!.turnId, messageIds: [alicePrompt.id],
    }));
    // The harness interrupted exactly that turn. Bob's is untouched, in the same process.
    await until(async () => (await host.status()).channels.find((channel) => channel.channel === alice.id)!.activeTurn === undefined, "alice's turn to end in the harness");
    const status = await host.status();
    expect(status.channels.find((channel) => channel.channel === alice.id)).toMatchObject({ lifecycle: "open", unresolved: { state: "interrupted", reason: "interrupted by the conversation" } });
    expect(status.channels.find((channel) => channel.channel === bob.id)).toMatchObject({ activeTurn: { state: "running" } });
    expect(host.state).toBe("running");
    expect(host.launches).toBe(1);
    expect(alice.connection.isConnected).toBe(true);
    expect(bob.state.operation?.stage).toBe("tool_running");

    rig.release("k");
    expect(await b1).toMatchObject({ status: "completed", text: "Working.\n\nFinished." });
    // Only Bob's tool finished; Alice's was cancelled and is not run again.
    expect(rig.effects()).toEqual(["start:k", "start:k", "done:k"]);
    // Fresh input on the interrupted channel.
    expect(await alice.prompt("a2")).toMatchObject({ status: "completed", text: "Finished." });
    expect(host.launches).toBe(1);
  }, 30_000);

  test("5: the process dies after a reply commits; a suspension recorded while it is down holds that channel's recovered input; the missed reply is restored once and nothing is duplicated", async () => {
    const rig = await rigWith();
    rig.script([hold("k"), reply("Finished."), reply("Next.")]);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    // The second reply commit of the first process kills it, right after the commit and before its event.
    rig.env.HARNESS_TEST_FAULT = "commitResponse:2";

    // Bob: a turn in its tool, his reply seen live, and a second input accepted but not taken.
    const b1 = track(bob.prompt("b1"));
    await until(() => rig.launches.length === 1, "the first launch");
    delete rig.env.HARNESS_TEST_FAULT; // later processes start without the fault
    await until(() => rig.effects().includes("start:k") && bob.state.operation?.stage === "tool_running", "bob's tool");
    const b2 = bob.prompt({ text: "b2", delivery: "steer" });
    const b2State = track(b2);
    await until(async () => (await host.status()).channels.find((channel) => channel.channel === bob.id)!.pending.includes(b2.id), "b2 to be accepted");
    expect(await recordedReplies(agent, bob)).toEqual(["Working."]);

    // While the process is down, and before the host reopens, the consumer suspends Bob's channel.
    let recordedWhileDown: unknown;
    host.subscribeState(() => {
      if (host.state === "stopped" && recordedWhileDown === undefined) recordedWhileDown = host.changeChannel(bob.id, { lifecycle: "suspended" });
    });

    // Alice's reply is the second commit: the process dies holding a reply the host never received.
    const a1 = track(alice.prompt("a1"));
    await until(() => host.launches === 2 && host.state === "running", "the reopen after the crash");
    expect(await recordedWhileDown).toEqual({ state: "pending" });
    await until(() => a1.settled && b1.settled, "the interrupted turns to settle from the reopened view");

    // Alice: interrupted by the crash; the committed reply is restored by its id, once.
    // The conversation rejects with its own operation error; its cause is the harness's outcome.
    expect(a1.error.cause).toBeInstanceOf(NativeTurnError);
    expect(a1.error.cause).toMatchObject({ outcome: "interrupted" });
    expect(await recordedReplies(agent, alice)).toEqual(["Working."]);
    // Bob: interrupted too, with the tool call whose outcome is unknown reported and never replayed.
    expect(b1.error.cause).toMatchObject({ outcome: "interrupted", uncertainCalls: ["hold-k"] });
    expect(await recordedReplies(agent, bob)).toEqual(["Working."]); // seen live before the loss: not written twice

    // The suspension was applied by the open, before Bob's recovered input could run.
    const status = await host.status();
    expect(status.sessionId).toBe(agent.id);
    const bobChannel = status.channels.find((channel) => channel.channel === bob.id)!;
    expect(bobChannel).toMatchObject({ lifecycle: "suspended", waitingForResume: true, pending: [b2.id] });
    expect(bobChannel.activeTurn).toBeUndefined();
    expect(await host.pendingChannelChanges()).toEqual([]); // confirmed by the open
    await Bun.sleep(100);
    expect((await host.status()).channels.find((channel) => channel.channel === bob.id)).toMatchObject({ lifecycle: "suspended", pending: [b2.id] });
    expect(b2State.settled).toBe(false);
    expect(host.records.submissions().map((submission) => [submission.id, submission.state])).toEqual([[b2.id, "accepted"]]);

    // The same session goes on. Alice takes fresh input; Bob's input runs once, after a live resume.
    expect(await alice.prompt("a2")).toMatchObject({ status: "completed", text: "Finished." });
    expect(await host.changeChannel(bob.id, { lifecycle: "open" })).toEqual({ state: "applied" });
    expect(await b2).toMatchObject({ status: "completed", text: "Finished." });
    expect(await recordedReplies(agent, alice)).toEqual(["Working.", "Finished."]);
    expect(await recordedReplies(agent, bob)).toEqual(["Working.", "Finished."]);
    // The interrupted tool was not run again, and no input or turn was duplicated.
    expect(rig.effects()).toEqual(["start:k"]);
    expect(host.records.submissions()).toEqual([]);
    expect(host.launches).toBe(2);
    expect((await host.status()).execution).toBe("idle");
  }, 60_000);

  test("6a: a push response lost after the harness committed the input: the reopen finds it by its saved id and it is accepted and run exactly once", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice] = await two(agent);
    const events = rig.watch(alice);
    rig.env.HARNESS_TEST_FAULT = "acceptItem:1"; // dies right after the inbox commit, before the acknowledgment
    const a1 = alice.prompt("a1");
    await until(() => rig.launches.length === 1, "the first launch");
    delete rig.env.HARNESS_TEST_FAULT;
    const result = await a1;
    expect(result).toMatchObject({ status: "completed", text: "reply 1" });
    expect(host.launches).toBe(2);
    expect(kinds(events)).toEqual([`turn_started:${result.operationId}`, `turn_completed:${result.operationId}`]);
    expect(events.find((event) => event.kind === "turn_started")!.cause.messageIds).toEqual([a1.id]);
    // One input, one turn: the same id was never accepted twice. The next reply is the script's second step.
    expect(host.records.submissions()).toEqual([]);
    expect(await alice.prompt("a2")).toMatchObject({ text: "reply 2" });
    expect(await recordedReplies(agent, alice)).toEqual(["reply 1", "reply 2"]);
  }, 30_000);

  test("6b: an open response lost after its channel changes committed: retrying the open confirms them and duplicates nothing", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    expect(await host.changeChannel(bob.id, { lifecycle: "suspended" })).toEqual({ state: "pending" });
    const before = (await host.pendingChannelChanges()).find((change) => change.channel === bob.id)!;
    expect(before.desire).toEqual({ displayName: "Bob", lifecycle: "suspended" });
    rig.env.HARNESS_TEST_FAULT = "beginChannelSuspend:1"; // dies inside the open, after the suspension commits
    const failed = await alice.prompt("a1").catch((error) => error);
    expect(failed).toBeInstanceOf(Error);
    delete rig.env.HARNESS_TEST_FAULT;
    expect(host.state).toBe("stopped");
    // Unconfirmed, so still the host's pending state, unchanged.
    expect((await host.pendingChannelChanges()).find((change) => change.channel === bob.id)).toEqual(before);
    // The prompt that failed was never handed over, so it must not run later.
    expect(host.records.submissions()).toEqual([]);

    const result = await alice.prompt("a2");
    expect(result).toMatchObject({ status: "completed", text: "reply 1" });
    expect(host.launches).toBe(2);
    expect(await host.pendingChannelChanges()).toEqual([]);
    const status = await host.status();
    expect(status.channels.map((channel) => [channel.channel, channel.lifecycle, channel.displayName]).sort()).toEqual(
      [[alice.id, "open", "Alice"], [bob.id, "suspended", "Bob"]].sort());
    await expect(bob.prompt("b1")).rejects.toMatchObject({ code: "channel_suspended" });
    expect(await host.changeChannel(bob.id, { lifecycle: "open" })).toEqual({ state: "applied" });
    expect(await bob.prompt("b2")).toMatchObject({ status: "completed", text: "reply 1" });
  }, 30_000);
});

describe("the native conversation at the Agent", () => {
  test("queued and steered prompts with file parts are refused before push, and text still runs", async () => {
    const rig = await rigWith();
    rig.script([hold("media-guard"), reply("Finished."), reply("Next.")]);
    const agent = await rig.open();
    const session = await agent.conversations.create() as AgentSession;
    const host = agent.nativeHarness!;
    const push = spyOn(host, "push");
    const first = session.prompt("hold the first turn");
    const firstOutcome = track(first);
    try {
      await until(() => session.state.operation?.stage === "tool_running", "the first turn's held tool");
      const media = {
        text: "read the attached file",
        parts: [{ kind: "file" as const, data: new TextEncoder().encode("fixture file") }],
      };
      const queued = session.prompt({ ...media, delivery: "queue" });
      const queuedOutcome = track(queued);
      const steered = session.prompt({ ...media, delivery: "steer" });
      const steeredOutcome = track(steered);
      await until(() => steeredOutcome.settled || push.mock.calls.length > 1, "steer refusal before a host push");
      expect(steeredOutcome.error).toBeInstanceOf(UnsupportedError);
      expect(firstOutcome.settled).toBe(false);
      expect(queuedOutcome.settled).toBe(false);
      expect(push.mock.calls.map(([input]) => input.id)).toEqual([first.id]);

      const next = session.prompt({ text: "text after the refused queue entry", delivery: "queue" });
      const nextOutcome = track(next);
      rig.release("media-guard");
      await until(() => firstOutcome.settled && queuedOutcome.settled && nextOutcome.settled, "the queue to drain");
      expect(firstOutcome.value).toMatchObject({ status: "completed", text: "Working.\n\nFinished." });
      expect(queuedOutcome.error).toBeInstanceOf(UnsupportedError);
      expect(nextOutcome.value).toMatchObject({ status: "completed", text: "Next." });
      expect(push.mock.calls.map(([input]) => input.id)).toEqual([first.id, next.id]);
    } finally {
      rig.release("media-guard");
      push.mockRestore();
    }
  }, 45_000);

  test("a native adapter needs AgentConfig.harness; ACP adapters in the same Agent are unaffected by it", async () => {
    const rig = await rigWith();
    await expect(rig.open({ harness: undefined })).rejects.toThrow("requires AgentConfig.harness");
    const agent = await rig.open({ adapters: { main: { kind: "native", defaultPolicy: "open", displayName: "Main" }, other: { command: ["some-acp-agent"] } } });
    expect(agent.adapters.native("main")).toEqual({ kind: "native", defaultPolicy: "open", displayName: "Main" });
    expect(agent.adapters.native("other")).toBeNull();
    expect(agent.adapters.require("other")).toEqual({ command: ["some-acp-agent"] });
    expect(agent.adapters.require("main")).toMatchObject({ command: ["native-harness"], displayName: "Main" });
    const conversation = await agent.conversations.create() as AgentSession;
    // The adapter's default policy and the conversation are stored for the channel without starting anything.
    expect(agent.nativeHarness!.state).toBe("stopped");
    expect((await agent.nativeHarness!.pendingChannelChanges()).find((change) => change.channel === conversation.id)?.desire).toEqual({ policy: "open" });
    expect(conversation.harnessConnection()).toBeNull();
  }, 30_000);

  test("startFresh is unsupported: restarting on a fresh context is refused before anything is torn down, and the timeline is intact", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice] = await two(agent);
    expect(await alice.prompt("a1")).toMatchObject({ text: "reply 1" });
    const before = await host.status();
    await expect(alice.restartProviderFresh()).rejects.toBeInstanceOf(UnsupportedError);
    await expect(alice.connection.startFresh()).rejects.toBeInstanceOf(UnsupportedError);
    expect(await host.status()).toEqual(before); // same revision: no channel, session or timeline change
    expect(host.launches).toBe(1);
    expect(alice.connection.isConnected).toBe(true);
    // The script continues from where the channel was: its context was not reset.
    expect(await alice.prompt("a2")).toMatchObject({ text: "reply 2" });
  }, 30_000);

  test("a same-adapter native handoff rejects before events or records, and the next prompt runs", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const session = await agent.conversations.create() as AgentSession;
    expect(await session.prompt("before handoff")).toMatchObject({ text: "reply 1" });
    const events = rig.watch(session);
    const actions = () => agent.persistence.records.list(session.id, { kinds: ["native_action"] });
    const before = (await actions()).records;

    await expect(session.handoff({ continuation: { kind: "none" } })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(session.handoff({ target: { adapterId: session.adapterId } })).rejects.toBeInstanceOf(UnsupportedError);
    expect(events.filter((event) => event.kind.startsWith("handoff_"))).toEqual([]);
    expect((await actions()).records).toEqual(before);
    expect(await session.prompt("after handoff")).toMatchObject({ status: "completed", text: "reply 2" });
  }, 30_000);

  test("deleting a conversation while the harness is stopped retires its channel at the next open, without starting a process", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    expect(await alice.prompt("a1")).toMatchObject({ status: "completed" });
    expect(await bob.prompt("b1")).toMatchObject({ status: "completed" });
    await host.stop();
    await agent.conversations.delete(bob.id);
    expect(host.state).toBe("stopped");
    expect(host.launches).toBe(1);
    const retirement = await agent.persistence.channels!.pendingChange(bob.id);
    expect(retirement?.desire).toMatchObject({ lifecycle: "retired" });
    const laterEdits = await Promise.all([
      host.changeChannel(bob.id, { lifecycle: "suspended" }),
      host.changeChannel(bob.id, { lifecycle: "open" }),
    ]);
    expect(laterEdits).toEqual([
      { state: "blocked", reason: "channel_retired" },
      { state: "blocked", reason: "channel_retired" },
    ]);
    expect(await agent.persistence.channels!.pendingChange(bob.id)).toEqual(retirement);
    expect(await alice.prompt("a2")).toMatchObject({ status: "completed" });
    expect(await host.pendingChannelChanges()).toEqual([]);
    expect((await host.status()).channels.find((channel) => channel.channel === bob.id)).toMatchObject({ lifecycle: "retired" });
  }, 30_000);

  test("SQLite ignores pending file intents once and still uses explicit records for submissions", async () => {
    const rig = await rigWith();
    const path = join(rig.directory, "host-records.json");
    const original = createFileHostRecords(path);
    const ignored = original.desire("file-only", { lifecycle: "suspended" });
    rig.harness.records = createFileHostRecords(path);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    expect(await host.pendingChannelChanges()).toEqual([]);
    expect(() => host.records.pendingChanges()).toThrow("pendingChannelChanges");
    expect(() => host.records.pendingChange("file-only")).toThrow("pendingChannelChanges");
    expect(() => host.records.desire("file-only", { lifecycle: "open" })).toThrow("use persistence");
    expect(() => host.records.confirmChange("file-only", ignored.version)).toThrow("use persistence");

    const conversation = await agent.conversations.create({ title: "Repository channel" });
    expect(await host.pendingChannelChanges()).toMatchObject([{ channel: conversation.id, desire: { displayName: "Repository channel" } }]);
    const saved = { id: "file-submission", channel: conversation.id, sender: "ana", text: "saved in file", state: "saved" } as const;
    host.records.saveSubmission(saved);
    expect(createFileHostRecords(path).submission(saved.id)).toEqual(saved);
    expect(host.records.submission(saved.id)).toEqual(saved);
    host.records.settleSubmission(saved.id);

    for (let open = 0; open < 2; open++) {
      await host.ensureStarted();
      expect((await host.status()).channels.map(({ channel }) => channel)).toEqual([conversation.id]);
      await host.stop();
    }
    expect(createFileHostRecords(path).pendingChanges()).toEqual([ignored]);
    expect(rig.logs.filter(([level, event]) => level === "warn" && event === "native_file_channel_changes_ignored")).toHaveLength(1);
  }, 30_000);

  test("the conversation delete caller propagates a durable channel write failure", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const conversation = await agent.conversations.create({ title: "Keep this conversation" });
    expect(await conversation.prompt("first")).toMatchObject({ status: "completed" });
    await host.stop();

    const error = new Error("could not store retirement");
    const transaction = agent.persistence.transaction.bind(agent.persistence);
    const write = spyOn(agent.persistence, "transaction").mockImplementationOnce((work) => transaction(async (scope) => {
      const desire = scope.channels!.desire.bind(scope.channels);
      scope.channels!.desire = async (channel, change) => {
        expect(channel).toBe(conversation.id);
        expect(change).toEqual({ lifecycle: "retired" });
        await desire(channel, change);
        throw error;
      };
      return work(scope);
    }));
    await expect(agent.conversations.delete(conversation.id)).rejects.toBe(error);
    write.mockRestore();
    const persisted = await agent.persistence.conversations.get(conversation.id);
    expect(persisted?.title).toBe("Keep this conversation");
    expect(persisted?.deletedAt).toBeUndefined();
    expect(await host.pendingChannelChanges()).toEqual([]);
    const { conversation: reopened } = await agent.conversations.open(conversation.id);
    expect(await reopened.prompt("after the failure")).toMatchObject({ status: "completed", text: "reply 2" });
  }, 30_000);

  test("a failed conversation delete rolls back retirement for an unused native channel", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const conversation = await agent.conversations.create({ title: "Unused native channel" });
    const initial = await agent.persistence.channels!.pendingChange(conversation.id);
    expect(initial?.desire).toEqual({ displayName: "Unused native channel" });

    await expect(agent.conversations.delete(conversation.id, { deletedAt: "invalid" })).rejects.toThrow("deletedAt");
    const persisted = await agent.persistence.conversations.get(conversation.id);
    expect(persisted?.title).toBe("Unused native channel");
    expect(persisted?.deletedAt).toBeUndefined();
    expect(await agent.persistence.channels!.pendingChange(conversation.id)).toEqual(initial);
    expect(host.launches).toBe(0);
  }, 30_000);

  test("a running harness receives one retirement after its transaction commits", async () => {
    const rig = await rigWith();
    const trace = traceStdio(rig);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const conversation = await agent.conversations.create({ title: "Retire after commit" });
    const initial = (await agent.persistence.channels!.pendingChange(conversation.id))!;
    await host.ensureStarted();
    expect(await host.pendingChannelChanges()).toEqual([]);

    const staged = barrier(), commit = barrier();
    const transaction = agent.persistence.transaction.bind(agent.persistence);
    const write = spyOn(agent.persistence, "transaction").mockImplementationOnce((work) => transaction(async (scope) => {
      const result = await work(scope);
      expect((await scope.conversations.get(conversation.id))?.deletedAt).toEqual(expect.any(String));
      expect(await scope.channels!.pendingChange(conversation.id)).toMatchObject({
        version: initial.version + 1, desire: { lifecycle: "retired" },
      });
      staged.open();
      await commit.waiting;
      return result;
    }));
    trace.intercept.deleteChannel = async (real) => {
      expect((await agent.persistence.conversations.get(conversation.id))?.deletedAt).toEqual(expect.any(String));
      expect(await agent.persistence.channels!.pendingChange(conversation.id)).toMatchObject({
        version: initial.version + 1, desire: { lifecycle: "retired" },
      });
      return real();
    };

    const deleting = agent.conversations.delete(conversation.id);
    const finished = deleting.then(() => { throw new Error("delete completed before the transaction barrier"); });
    let pushed: ReturnType<typeof host.push> | undefined;
    try {
      await Promise.race([staged.waiting, finished]);
      expect(trace.methods).not.toContain("deleteChannel");
      pushed = host.push({ id: "too-late", channel: conversation.id, sender: "user", text: "pending retirement" });
      void pushed.catch(() => undefined);
    } finally {
      commit.open();
    }
    await deleting;
    await expect(pushed).rejects.toMatchObject({ code: "channel_retired" });
    write.mockRestore();
    expect(trace.methods.filter((method) => method === "deleteChannel")).toEqual(["deleteChannel"]);
    expect(trace.methods.indexOf("deleteChannel")).toBeLessThan(trace.methods.indexOf("push"));
    expect(await host.pendingChannelChanges()).toEqual([]);
    expect((await host.status()).channels).toMatchObject([{ channel: conversation.id, lifecycle: "retired" }]);
  }, 30_000);

  test("initial channel settings and conversation creation roll back together", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const id = createAgentConversationId();
    const error = new Error("could not store initial channel settings");
    const transaction = agent.persistence.transaction.bind(agent.persistence);
    const write = spyOn(agent.persistence, "transaction").mockImplementationOnce((work) => transaction(async (scope) => {
      const desire = scope.channels!.desire.bind(scope.channels);
      scope.channels!.desire = async (channel, change) => {
        expect((await scope.conversations.get(id))?.title).toBe("Initial title");
        expect([channel, change]).toEqual([id, { displayName: "Initial title" }]);
        await desire(channel, change);
        throw error;
      };
      return work(scope);
    }));
    await expect(agent.conversations.create({ id, title: "Initial title" })).rejects.toBe(error);
    write.mockRestore();
    expect(await agent.persistence.conversations.get(id)).toBeNull();
    expect(await agent.persistence.channels!.pendingChange(id)).toBeUndefined();
    expect(agent.nativeHarness!.launches).toBe(0);
  });

  test("a new Agent process over the same persistence and harness home reopens the conversation on the same session and channel", async () => {
    const rig = await rigWith();
    const first = await rig.open();
    const [alice] = await two(first);
    expect(await alice.prompt("a1")).toMatchObject({ text: "reply 1" });
    const id = alice.id, agentId = first.id;
    await first.close();
    const second = await rig.open();
    expect(second.id).toBe(agentId);
    const reopened = (await second.conversations.open(id)).conversation as unknown as AgentSession;
    expect(second.nativeHarness!.state).toBe("stopped"); // opening it started nothing
    // The channel's context continued: the script's next step, on the same durable session.
    expect(await reopened.prompt("a2")).toMatchObject({ status: "completed", text: "reply 2" });
    const status = await second.nativeHarness!.status();
    expect(status.sessionId).toBe(agentId);
    // The same two channels as before (the second conversation's was created with its title): none was added.
    expect(status.channels.map((channel) => channel.channel)).toContain(id);
    expect(status.channels).toHaveLength(2);
  }, 30_000);

  for (const state of ["an acknowledged intent", "a pending intent", "no initial settings"] as const) {
    test(`a native row with ${state} survives restart with enough identity to retire`, async () => {
      const rig = await rigWith();
      const first = await rig.open();
      const conversation = await first.conversations.create(state === "no initial settings" ? {} : { title: "Unused" });
      const intent = await first.persistence.channels!.pendingChange(conversation.id);
      if (state === "no initial settings") expect(intent).toBeUndefined();
      else expect(intent?.desire).toEqual({ displayName: "Unused" });
      if (state === "an acknowledged intent") {
        // Simulate the open acknowledgement without starting a stdio harness.
        expect(await first.persistence.channels!.confirmChange(conversation.id, intent!.version)).toBe(true);
      }
      expect(await first.persistence.providerSessions.active(conversation.id)).toBeNull();
      await first.close();

      const second = await rig.open();
      expect((await second.persistence.conversations.get(conversation.id))?.controllerKind).toBe("native");
      await second.conversations.delete(conversation.id);
      expect((await second.persistence.conversations.get(conversation.id))?.deletedAt).toEqual(expect.any(String));
      const retirement = await second.persistence.channels!.pendingChange(conversation.id);
      expect(retirement?.desire.lifecycle).toBe("retired");
      if (intent) expect(retirement!.version).toBeGreaterThan(intent.version);
      expect(rig.launches).toEqual([]);
    }, 30_000);
  }

  test("a legacy row with an active native descriptor still retires after restart", async () => {
    const rig = await rigWith();
    const first = await rig.open();
    const id = createAgentConversationId();
    await first.persistence.conversations.create({ agentConversationId: id, agentSessionId: first.id });
    await first.persistence.providerSessions.append({
      providerSessionRecordId: crypto.randomUUID(), agentConversationId: id,
      internalSessionId: first.id, adapterId: "main", mode: "normal", activatedAt: new Date().toISOString(),
    });
    await first.close();

    const second = await rig.open();
    expect((await second.persistence.conversations.get(id))?.controllerKind).toBeUndefined();
    await second.conversations.delete(id);
    expect((await second.persistence.conversations.get(id))?.deletedAt).toEqual(expect.any(String));
    expect((await second.persistence.channels!.pendingChange(id))?.desire.lifecycle).toBe("retired");
    expect(rig.launches).toEqual([]);
  }, 30_000);

  test("switch and handoff across controller kinds refuse before records or transition events", async () => {
    const rig = await rigWith();
    const command = ["bun", new URL("../fixtures/echo-prompt-agent.ts", import.meta.url).pathname];
    const agent = await rig.open({ adapters: { main: { kind: "native" }, external: { command } } });
    const native = await agent.conversations.create() as AgentSession;
    const acp = await agent.conversations.create({ adapterId: "external" }) as AgentSession;
    expect((await agent.persistence.conversations.get(acp.id))?.controllerKind).toBe("acp");
    for (const [conversation, target] of [[native, "external"], [acp, "main"]] as const) {
      const events = rig.watch(conversation);
      const records = () => agent.persistence.records.list(conversation.id);
      const before = await records();
      await expect(conversation.switch(target)).rejects.toBeInstanceOf(UnsupportedError);
      await expect(conversation.handoff({ target: { adapterId: target } })).rejects.toBeInstanceOf(UnsupportedError);
      expect(await records()).toEqual(before);
      expect(events.filter(({ kind }) => kind.startsWith("handoff_") || kind.startsWith("switch_"))).toEqual([]);
    }
    expect(agent.nativeHarness!.launches).toBe(0);
  }, 30_000);

  test("closing the Agent stops the shared process", async () => {
    const rig = await rigWith();
    const agent = await rig.open();
    const [alice] = await two(agent);
    await alice.prompt("a1");
    expect(agent.nativeHarness!.state).toBe("running");
    await agent.close();
    expect(agent.nativeHarness!.state).toBe("stopped");
  }, 30_000);
});

/** Run the normal host with a traced real stdio transport. A barrier can
 * delay one host read without pausing the child or its notifications. */
function traceStdio(rig: NativeRig) {
  const children: ReturnType<typeof spawnHarness>[] = [];
  const methods: string[] = [];
  const intercept: Partial<Record<string, (real: () => Promise<unknown>, args: unknown[]) => Promise<unknown>>> = {};
  rig.harness.connect = async () => {
    const child = spawnHarness({ home: rig.home, effects: rig.effectsPath, fault: rig.env.HARNESS_TEST_FAULT, snapshotLog: rig.env.HARNESS_TEST_SNAPSHOT_LOG, stallChannel: rig.env.HARNESS_TEST_STALL_CHANNEL, modelTimeoutMs: Number(rig.env.HARNESS_TEST_MODEL_TIMEOUT_MS) || undefined });
    children.push(child);
    const client = new Proxy(child.client, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function" || typeof key !== "string") return value;
      if (key.startsWith("on")) return value.bind(target);
      return (...args: unknown[]) => {
        methods.push(key);
        const real = () => value.apply(target, args) as Promise<unknown>;
        return intercept[key]?.(real, args) ?? real();
      };
    } }) as HarnessClient;
    return { client, closed: child.child.exited.then(() => undefined), kill: () => child.close() };
  };
  return { children, methods, intercept };
}

function barrier() {
  let open!: () => void;
  const waiting = new Promise<void>(resolve => { open = resolve; });
  return { open, waiting };
}

function waitForChannelEvent(client: HarnessClient, matches: (event: ChannelEvent) => boolean, description: string) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const unsubscribe = client.onChannelEvent((event) => { if (matches(event)) resolve(); });
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10_000);
  return promise.finally(() => { clearTimeout(timer); unsubscribe(); });
}

describe("durable retirement across an Agent restart", () => {
  async function expectRetired(agent: Agent, id: string) {
    const host = agent.nativeHarness!;
    expect(await agent.persistence.channels!.pendingChange(id)).toBeUndefined();
    const status = (await host.status()).channels.find(({ channel }) => channel === id);
    expect(status).toMatchObject({ lifecycle: "retired", pending: [] });
    expect(status?.activeTurn).toBeUndefined();
    const history = await host.conversationMessages({ channel: id });
    await expect(host.push({ id: "after-delete", channel: id, sender: "operator", text: "must not run" }))
      .rejects.toMatchObject({ code: "channel_retired" });
    expect((await host.conversationMessages({ channel: id })).messages).toEqual(history.messages);
  }

  test("a delete while the harness is stopped survives reopening the Agent", async () => {
    const rig = await rigWith();
    const first = await rig.open();
    const conversation = await first.conversations.create({ title: "Had a turn" });
    await conversation.prompt("before deletion");
    const host = first.nativeHarness!;
    await host.stop();
    await first.conversations.delete(conversation.id);
    const pending = await first.persistence.channels!.pendingChange(conversation.id);
    expect(pending?.desire.lifecycle).toBe("retired");
    expect(host.launches).toBe(1);
    await first.close();

    const second = await rig.open();
    expect(await second.persistence.channels!.pendingChange(conversation.id)).toEqual(pending);
    await second.nativeHarness!.ensureStarted();
    await expectRetired(second, conversation.id);
  }, 30_000);

  test("the same retirement version is acknowledged after the harness dies before its response", async () => {
    const rig = await rigWith();
    const trace = traceStdio(rig);
    const first = await rig.open();
    const conversation = await first.conversations.create({ title: "Committed retirement" });
    await conversation.prompt("before deletion");
    const host = first.nativeHarness!;
    await host.stop();
    await first.conversations.delete(conversation.id);
    const pending = (await first.persistence.channels!.pendingChange(conversation.id))!;

    // The scripted storage fault kills the child after deleteChannel succeeds and before its reply.
    rig.env.HARNESS_TEST_FAULT = "deleteChannel:1";
    await expect(host.ensureStarted()).rejects.toBeInstanceOf(HarnessClientError);
    delete rig.env.HARNESS_TEST_FAULT;
    expect(trace.children[1]!.child.signalCode).toBe("SIGKILL");
    expect(await first.persistence.channels!.pendingChange(conversation.id)).toEqual(pending);
    await first.close();

    const second = await rig.open();
    const results: ChannelChangeResult[] = [];
    trace.intercept.openSession = async (real, [params]) => {
      expect(params).toMatchObject({ channelChanges: [{
        channel: conversation.id, changeId: String(pending.version), lifecycle: "retired",
      }] });
      const opened = await real() as Awaited<ReturnType<HarnessClient["openSession"]>>;
      results.push(...(opened.channelChanges ?? []));
      return opened;
    };
    await second.nativeHarness!.ensureStarted();
    expect(results).toEqual([{ channel: conversation.id, changeId: String(pending.version), outcome: "applied" }]);
    await expectRetired(second, conversation.id);
    expect((await second.nativeHarness!.conversationMessages({ channel: conversation.id })).messages
      .filter(({ actor }) => actor.kind === "agent")).toHaveLength(1);
  }, 30_000);

  test("queued input blocks a retirement across restart and operator resume is refused", async () => {
    const rig = await rigWith();
    const trace = traceStdio(rig);
    const reported: ChannelChangeResult[] = [];
    rig.harness.onChannelChangeBlocked = (result: ChannelChangeResult) => reported.push(result);
    rig.script([hold("retirement"), reply("Must not run while suspended.")]);
    const first = await rig.open();
    const conversation = await first.conversations.create({ title: "Busy" });
    const id = conversation.id, host = first.nativeHarness!;
    await conversation.stop();
    await host.ensureStarted();
    const client = trace.children[0]!.client;
    const toolStarted = waitForChannelEvent(client, ({ channel, event }) =>
      channel === id && event.type === "tool_call" && event.status === "started", "the held tool");
    await host.push({ id: "busy-first", channel: id, sender: "operator", text: "hold the turn" });
    await toolStarted;
    await host.push({ id: "busy-queued", channel: id, sender: "operator", text: "queue behind the turn" });
    const suspending = waitForChannelEvent(client, ({ channel, event }) =>
      channel === id && event.type === "channel_state" && event.lifecycle === "suspending", "the suspension barrier");
    const suspend = host.suspendChannel(id);
    try {
      await suspending;
    } finally {
      rig.release("retirement");
    }
    await suspend;
    const before = (await host.conversationMessages({ channel: id })).messages;
    expect((await host.status()).channels.find(({ channel }) => channel === id)?.pending).toContain("busy-queued");
    await first.close();

    const second = await rig.open();
    const reopened = second.nativeHarness!;
    await second.conversations.delete(id);
    const pending = (await second.persistence.channels!.pendingChange(id))!;
    await reopened.ensureStarted();
    expect(reported).toEqual([{ channel: id, changeId: String(pending.version), outcome: "blocked", reason: "channel_busy" }]);
    expect(await second.persistence.channels!.pendingChange(id)).toEqual(pending);
    await expect(reopened.resumeChannel(id)).rejects.toMatchObject({ code: "channel_retired" });
    expect(trace.methods).not.toContain("resumeChannel");
    expect((await reopened.status()).channels.find(({ channel }) => channel === id)).toMatchObject({
      lifecycle: "suspended", pending: ["busy-queued"],
    });
    expect((await reopened.conversationMessages({ channel: id })).messages).toEqual(before);
  }, 30_000);

  test("an unused channel realized by another conversation's open cannot run after deletion", async () => {
    const rig = await rigWith();
    const first = await rig.open();
    const [active, unused] = await two(first);
    await active.prompt("realize both channels");
    expect((await first.nativeHarness!.status()).channels.find(({ channel }) => channel === unused.id)?.lifecycle).toBe("open");
    expect(await first.persistence.channels!.pendingChange(unused.id)).toBeUndefined();
    expect(await first.persistence.providerSessions.active(unused.id)).toBeNull();
    await first.close();

    const second = await rig.open();
    await second.conversations.delete(unused.id);
    await second.nativeHarness!.ensureStarted();
    await expectRetired(second, unused.id);
    expect((await second.nativeHarness!.conversationMessages({ channel: unused.id })).messages).toEqual([]);
  }, 30_000);

  test("deletion before the first harness open leaves only a retired tombstone", async () => {
    const rig = await rigWith();
    const trace = traceStdio(rig);
    const first = await rig.open();
    const conversation = await first.conversations.create({ title: "Never opened" });
    const id = conversation.id;
    expect((await first.persistence.channels!.pendingChange(id))?.desire).toEqual({ displayName: "Never opened" });
    await first.close();
    expect(trace.children).toHaveLength(0);

    const second = await rig.open();
    await second.conversations.delete(id);
    expect(trace.children).toHaveLength(0);
    const retirement = (await second.persistence.channels!.pendingChange(id))!;
    expect(retirement.desire.lifecycle).toBe("retired");
    trace.intercept.createSession = async (real, [params]) => {
      expect(params).toMatchObject({ channelChanges: [{
        channel: id, changeId: String(retirement.version), lifecycle: "retired",
      }] });
      const result = await real() as Awaited<ReturnType<HarnessClient["createSession"]>>;
      expect(result.channelChanges).toEqual([{ channel: id, changeId: String(retirement.version), outcome: "applied" }]);
      return result;
    };
    const host = second.nativeHarness!;
    await host.ensureStarted();
    await expectRetired(second, id);
    expect((await host.status()).channels).toMatchObject([{ channel: id, lifecycle: "retired" }]);
    expect((await host.timeline()).events).toEqual([]);
    expect(trace.children[0]!.wire.filter((message) =>
      "method" in message && message.params.channel === id && message.params.event.type === "turn_started")).toEqual([]);
  }, 30_000);

  test("a native conversation with no title or policy is retired across restart", async () => {
    const rig = await rigWith();
    const first = await rig.open();
    const conversation = await first.conversations.create();
    const other = await first.conversations.create({ title: "Other" });
    await other.prompt("open the existing session");
    expect(await first.persistence.channels!.pendingChange(conversation.id)).toBeUndefined();
    expect((await first.nativeHarness!.status()).channels.map(({ channel }) => channel)).not.toContain(conversation.id);
    await first.close();

    const second = await rig.open();
    await second.conversations.delete(conversation.id);
    await second.nativeHarness!.ensureStarted();
    await expectRetired(second, conversation.id);
  }, 30_000);
});

describe("operator controls over real stdio", () => {
  test("reattachment merges completion during a targeted read while another channel stays live", async () => {
    const rig = await rigWith();
    const trace = traceStdio(rig);
    rig.script([hold("attach"), reply("First reply"), reply("Later reply")]);
    const agent = await rig.open(), host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    const handle = await alice.attachObservation();
    const pending = alice.prompt("first");
    await until(() => rig.effects().includes("start:attach"), "Alice's tool");
    handle.dispose();
    expect(alice.connection.attachmentConnected).toBe(false);
    expect(await host.operatorStatus()).toMatchObject({ process: "running", workingChannels: 1, stale: false });
    const entered = barrier(), read = barrier();
    trace.intercept.reconcileChannel = async (real, [params]) => {
      if ((params as { channel: string }).channel === alice.id) { entered.open(); await read.waiting; }
      return real();
    };
    const attaching = alice.attachObservation();
    await entered.waiting;
    const bobWork = bob.prompt("Bob remains attached");
    try {
      await until(async () => (await host.operatorStatus()).workingChannels === 2, "two working channels");
      rig.release("attach");
      const independent = await bobWork;
      expect(independent.text).toContain("First reply");
      await until(async () => (await host.status()).channels.find(channel => channel.channel === alice.id)?.activeTurn === undefined, "Alice's commit");
    } finally { read.open(); }
    const attached = await attaching;
    expect(await alice.attachObservation()).toBe(attached);
    const newest = await host.conversationMessages({ channel: alice.id });
    expect(newest.messages.filter(message => message.actor.kind === "agent")).toHaveLength(2);
    expect((await pending).text).toContain("First reply");
    expect(await recordedReplies(agent, alice)).toEqual(["Working.", "First reply"]);
    await host.suspendChannel(alice.id);
    expect(alice.connection.attachmentConnected).toBe(true);
    expect((await host.status()).channels.find(channel => channel.channel === alice.id)?.lifecycle).toBe("suspended");
    expect(await host.operatorStatus()).toMatchObject({ process: "running", workingChannels: 0 });
    await host.resumeChannel(alice.id);
    expect((await alice.prompt("new")).text).toBe("Later reply");
  }, 30_000);

  test("an unattached approval is recovered by ID, and Restart refuses to start after connection loss", async () => {
    type Answer = Parameters<NativeApprovalResponder>[1];
    const requests = new Map<string, Answer>();
    const rig = await rigWith({ defaultPolicy: "ask", policies: { ask: { fallback: "allow", tools: { record: "ask" } } } });
    const trace = traceStdio(rig);
    rig.harness.approvalResponder = ((request, answer) => { requests.set(request.requestId, answer); }) satisfies NativeApprovalResponder;
    rig.script([record("operator-approval"), reply("Answered"), hold("restart"), reply("Not reached")]);
    const agent = await rig.open(), host = agent.nativeHarness!;
    const [alice] = await two(agent);
    (await alice.attachObservation()).dispose();
    await host.push({ id: "operator-input", channel: alice.id, sender: "operator", text: "approval" });
    await until(() => requests.size === 1, "detached approval");
    const [id, answer] = [...requests][0]!;
    const view = await alice.attachObservation();
    expect((await host.status()).channels.find(channel => channel.channel === alice.id)?.activeTurn?.phase?.id).toBe(id);
    expect(await host.respondApproval(id, "allow_once")).toBe(false);
    view.dispose();
    expect(await answer("allow_once")).toBe(true);
    expect(await answer("allow_once")).toBe(false);
    await until(() => rig.effects().includes("operator-approval"), "approved effect");
    expect(requests.size).toBe(1);
    await until(async () => (await host.status()).execution === "idle", "approved turn to finish");

    await alice.attachObservation();
    const active = track(alice.prompt("restart must stop here"));
    await until(() => rig.effects().includes("start:restart"), "restart tool");
    let starts = 0;
    trace.intercept.interruptTurn = async real => {
      const { child } = trace.children.at(-1)!;
      child.kill("SIGKILL");
      await child.exited;
      return real();
    };
    await expect(restartConversation({ stop: () => alice.connection.stop(), start: () => { starts++; return alice.connection.start(); } })).rejects.toThrow();
    expect(starts).toBe(0);
    expect(active.value?.text).not.toBe("Not reached");
  }, 30_000);
});

/** A deterministic mixed workload. Use the published schema created by the
 * real child, then close the fixture writer before reopening through stdio. */
function seedOperatorHistory(path: string, alice: string, bob: string) {
  const db = new Database(path);
  const projected = [];
  try {
    db.transaction(() => {
      const addTurn = db.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?)");
      const addEntry = db.prepare("INSERT INTO entries (seq, at, channel_id, turn_id, sender, kind, source_channel_id, item_id, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const reason = "Interrupted fixture with durable outcome ".repeat(5);
      const timestamp = new Date(0).toISOString();
      const key = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='compatibilityKey'").get()!.value;
      for (let turn = 1; turn <= 5_000; turn++) {
        const channel = turn % 2 === 0 ? alice : bob, start = turn * 4;
        const state = { status: "interrupted", reason, uncertainCallIds: [] };
        projected.push({ channel, turnId: String(turn), items: [], state: state.status, reason });
        addTurn.run(turn, channel, start, timestamp, key, state.status, JSON.stringify(state));
        const calls = [{ id: `effect-${turn}`, name: "echo", input: "{}" }];
        const assistant = { role: "assistant", content: `fixture reply ${turn}`, calls };
        const result = { role: "tool", callId: calls[0]!.id, content: turn === 5_000 ? "x".repeat(1_100_000) : "fixture result" };
        addEntry.run(start + 1, timestamp, channel, turn, "assistant", null, null, null, JSON.stringify(assistant));
        addEntry.run(start + 2, timestamp, channel, turn, "tool", null, null, null, JSON.stringify(result));
      }
      db.run("UPDATE meta SET value='20002' WHERE key='revision'");
      db.run("UPDATE meta SET value='5001' WHERE key='nextTurnId'");
      addTurn.finalize();
      addEntry.finalize();
    })();
    expect(Buffer.byteLength(JSON.stringify({ turns: projected }))).toBeGreaterThan(1_048_576);
  } finally { db.close(); }
}

test("operator stdio reads stay bounded on 10,000 records, catch-up retries from the committed position", async () => {
  const rig = await rigWith();
  const trace = traceStdio(rig);
  rig.script([reply("Ready"), reply("Fresh")]);
  const agent = await rig.open(), host = agent.nativeHarness!;
  const [alice, bob] = await two(agent);
  await host.start();
  await host.stop();
  const dbPath = join(rig.home, agent.id, "session.sqlite");
  seedOperatorHistory(dbPath, alice.id, bob.id);
  trace.methods.length = 0;
  // Model context assembly can read a snapshot. Opening and observing must
  // leave the count unchanged, including while that inference is held.
  const log = join(rig.directory, "snapshots.log");
  rig.env.HARNESS_TEST_SNAPSHOT_LOG = log;
  const snapshots = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  rig.env.HARNESS_TEST_STALL_CHANNEL = alice.id;
  rig.env.HARNESS_TEST_MODEL_TIMEOUT_MS = "20000";
  await host.start();
  const handle = await alice.attachObservation();
  expect(snapshots()).toBe(0);
  handle.dispose();
  await host.push({ id: "held", channel: alice.id, sender: "operator", text: "hold inference" });
  let last: Awaited<ReturnType<typeof host.status>> | undefined;
  await until(async () => {
    last = await host.status();
    return last.channels.find(channel => channel.channel === alice.id)?.activeTurn?.phase?.kind === "model";
  }, "held inference", 2000).catch(error => { throw new Error(JSON.stringify(last), { cause: error }); });
  const executionReads = snapshots();
  expect(executionReads).toBeGreaterThan(0);
  await alice.attachObservation();
  expect(snapshots()).toBe(executionReads);
  expect(trace.methods).toContain("reconcileChannel");
  expect(trace.methods).not.toContain("channelMessages");
  expect(trace.methods).not.toContain("timeline");
  const status = await host.status();
  const turn = status.channels.find(channel => channel.channel === alice.id)?.activeTurn?.turnId;
  if (!turn) throw new Error("Missing held turn");
  expect(await host.interrupt(alice.id, turn)).toBe(true);

  const newest = await host.conversationMessages({ channel: alice.id, limit: 3 });
  const before = newest.messages[0]!.position;
  expect(newest.messages.every(message => message.channel === alice.id)).toBe(true);
  const ids = newest.messages.map(message => message.messageId);
  const committed: string[] = [];
  const abort = new AbortController();
  trace.intercept.channelMessages = async (real, args) => {
    if ((args[0] as { after?: string }).after) {
      Object.assign(args[0] as object, { limit: 1 });
    }
    return real();
  };
  let saved = before;
  await expect(host.catchUp(alice.id, before, async (messages, next) => {
    committed.push(...messages.map(message => message.messageId));
    saved = next;
    abort.abort();
  }, abort.signal)).rejects.toThrow();
  expect(committed).toHaveLength(1);
  await host.catchUp(alice.id, saved, async (messages, next) => {
    committed.push(...messages.map(message => message.messageId));
    saved = next;
  });
  expect(committed).toEqual(ids.slice(1));
  const older = await host.conversationMessages({ channel: alice.id, cursor: newest.next, limit: 3 });
  expect(older.messages.some(message => ids.includes(message.messageId))).toBe(false);
  expect([...older.messages, ...newest.messages].every(message => message.actor.kind === "agent" || message.actor.id === "operator")).toBe(true);

  const activity = await host.timeline({ limit: 8 });
  const oversized = activity.events.findIndex(event => event.omitted && event.kind === "tool_result");
  expect(oversized).toBeGreaterThan(0);
  expect(oversized).toBeLessThan(activity.events.length - 1);
  expect((await host.timeline({ cursor: activity.next, limit: 8 })).events.every(event =>
    !activity.events.some(previous => previous.position === event.position))).toBe(true);
  expect(await host.operatorStatus()).toMatchObject({ process: "running", stale: false });
}, 30_000);

test("operator stdio suspension waits for a callback, preserves checkpoints across replacement, and stop stays responsive", async () => {
  const rig = await rigWith();
  const releases = [barrier(), barrier()];
  let effects = 0;
  rig.harness.functions = { tools: { checkpoint_tool: {
    description: "Controlled checkpoint callback", parameters: { type: "object" },
    async handler() { const release = releases[effects++]; await release!.waiting; return { recorded: true }; },
  } } };
  const tool = (id: string) => ({ content: null, calls: [{ id, name: "checkpoint_tool", arguments: {} }] });
  rig.script([tool("one"), reply("Resumed reply"), tool("two"), reply("Unexpected reply")]);
  const agent = await rig.open(), host = agent.nativeHarness!;
  const [alice, bob] = await two(agent);
  await host.start();
  expect(host.capabilities?.methods).toContain("channel/observe");
  await expect(host.validateConfig({ bogus: true })).rejects.toBeInstanceOf(HarnessClientError);
  const first = track(alice.prompt("first"));
  await until(() => effects === 1, "first callback");
  await host.suspendChannel(bob.id);
  await expect(host.push({ id: "closed-admission", channel: bob.id, sender: "operator", text: "blocked" })).rejects.toBeInstanceOf(HarnessClientError);
  expect((await host.operatorStatus()).workingChannels).toBe(1);
  const pause = host.suspend();
  await until(async () => (await host.status()).lifecycle === "suspending", "session admission closes");
  const blocked = (await host.status()).channels.find(channel => channel.channel === alice.id)?.activeTurn;
  expect(blocked?.phase).toMatchObject({ kind: "tool", id: expect.any(String) });
  expect(first.settled).toBe(false);
  releases[0]!.open();
  expect((await pause).lifecycle).toBe("suspended");
  expect(await host.operatorStatus()).toMatchObject({ process: "running", workingChannels: 0 });
  expect(alice.connection.attachmentConnected).toBe(true);
  expect((await host.status()).channels.find(channel => channel.channel === alice.id)?.lifecycle).toBe("open");
  await host.stop();
  expect(await host.operatorStatus()).toMatchObject({ process: "stopped", stale: true });
  await host.start();
  expect((await host.status()).lifecycle).toBe("suspended");
  expect((await host.status()).channels.find(channel => channel.channel === bob.id)?.lifecycle).toBe("suspended");
  await host.resume();
  await until(async () => (await host.status()).execution === "idle", "resumed checkpoint to finish");
  expect(effects).toBe(1);
  expect((await host.status()).channels.find(channel => channel.channel === bob.id)?.lifecycle).toBe("suspended");

  const second = track(alice.prompt("second"));
  await until(() => effects === 2, "second callback");
  const stoppingPause = track(host.suspend());
  await until(async () => (await host.status()).lifecycle === "suspending", "second suspension");
  await host.stop();
  releases[1]!.open();
  await until(() => stoppingPause.settled && second.settled, "interrupted waiters");
  expect(stoppingPause.error).toBeDefined();
  const launches = host.launches;
  expect(host.state).toBe("stopped");
  expect(host.launches).toBe(launches);
  await host.start();
  expect((await host.status()).channels.find(channel => channel.channel === alice.id)?.unresolved)
    .toMatchObject({ state: "interrupted", uncertainCalls: ["two"] });
  expect(effects).toBe(2);
}, 30_000);

test("operator stdio notify wakes an unattached channel and leaves usage fields unknown", async () => {
  const rig = await rigWith();
  const agent = await rig.open(), host = agent.nativeHarness!;
  const [alice, bob] = await two(agent);
  rig.script([hold("notify"), { content: null, calls: [{ id: "notice", name: "notify_channel", arguments: { channelId: alice.id, text: "wake Alice" } }] },
    reply("Initial reply"), reply("Notice reply"), reply("Later reply")]);
  const detach = await alice.attachObservation();
  const first = alice.prompt("initial");
  await until(() => rig.effects().includes("start:notify"), "initial hold");
  detach.dispose();
  rig.release("notify");
  await until(async () => (await host.status()).execution === "idle", "initial detached turn");
  expect((await bob.prompt("wake Alice")).text).toContain("Initial reply");
  await until(async () => (await host.status()).execution === "idle", "notice reply");
  const history = await host.conversationMessages({ channel: alice.id });
  expect(history.messages.flatMap(message => "parts" in message ? message.parts?.map(part => part.text) ?? [] : []))
    .toContain("Notice reply");
  expect((await host.timeline()).events).toContainEqual(expect.objectContaining({ kind: "channel_notice", sourceChannel: bob.id, channel: alice.id }));
  await alice.attachObservation();
  await first;
  expect((await alice.prompt("later")).text).toBe("Later reply");
  const usage = await host.usage(alice.id);
  expect(usage).toMatchObject({ totals: {}, partial: true });
  expect(usage.missing.inputTokens).toBe(usage.attempts);
  expect((await host.operatorStatus()).workingChannels).toBe(0);
}, 30_000);

test("operator stdio catch-up persists each missed reply once after a lost stream", async () => {
  const rig = await rigWith();
  const trace = traceStdio(rig);
  rig.script([reply("Baseline"), reply("Missed reply"), reply("Live reply")]);
  const agent = await rig.open(), host = agent.nativeHarness!;
  const [alice] = await two(agent);
  await alice.prompt("baseline");
  const head = await host.conversationMessages({ channel: alice.id, limit: 1 });
  const checkpoint = join(rig.directory, "consumer-position.json");
  const readSaved = () => JSON.parse(readFileSync(checkpoint, "utf8")) as { position: string; replies: string[] };
  writeFileSync(checkpoint, JSON.stringify({ position: head.messages[0]!.position, replies: [] }));
  (await alice.attachObservation()).dispose();
  await host.stop();

  rig.env.HARNESS_TEST_FAULT = "commitResponse:1";
  await host.start();
  delete rig.env.HARNESS_TEST_FAULT;
  const lost = trace.children.at(-1)!;
  await lost.client.push({ channel: alice.id, item: { id: "missed", kind: "user_message", sender: "operator", content: [{ type: "text", text: "missed" }] } }).catch(() => undefined);
  expect(await lost.child.exited).toBeGreaterThan(0);
  await until(() => host.state === "stopped", "untracked process loss");
  expect(host.records.submission("missed")).toBeUndefined();
  await host.start();
  await alice.attachObservation();

  const abort = new AbortController();
  const entered = barrier(), release = barrier();
  let holdFirst = true;
  trace.intercept.channelMessages = async (real, [params]) => {
    if ((params as { after?: string }).after) Object.assign(params as object, { limit: 1 });
    if (holdFirst) { holdFirst = false; entered.open(); await release.waiting; }
    return real();
  };
  const commit: Parameters<typeof host.catchUp>[2] = async (messages, position) => {
    const previous = readSaved();
    const replies = messages.flatMap(message => message.actor.kind === "agent" ? [message.messageId] : []);
    writeFileSync(checkpoint + ".draft", JSON.stringify({ position, replies: [...new Set([...previous.replies, ...replies])] }));
    renameSync(checkpoint + ".draft", checkpoint);
  };
  const interrupted = host.catchUp(alice.id, readSaved().position, async (messages, position) => {
    await commit(messages, position);
    abort.abort();
  }, abort.signal);
  const interruption = interrupted.then(() => undefined, (error: unknown) => error);
  await entered.waiting;
  const live = alice.prompt("live during catch-up");
  try {
    await until(async () => (await host.status()).execution === "idle" && host.records.submission(live.id)?.state === "accepted", "live commit during catch-up");
  } finally { release.open(); }
  expect(await interruption).toBeInstanceOf(Error);
  expect((await live).text).toBe("Live reply");
  expect(readSaved().replies).toEqual([]);
  await host.catchUp(alice.id, readSaved().position, commit);
  const persisted = readSaved();
  expect(persisted.replies).toHaveLength(2);
  await host.catchUp(alice.id, persisted.position, commit);
  expect(readSaved()).toEqual(persisted);
  expect((await recordedReplies(agent, alice)).filter(text => text === "Live reply")).toHaveLength(1);
}, 30_000);
