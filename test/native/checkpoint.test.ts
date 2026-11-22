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
import type { Agent } from "../../src/agent.ts";
import type { AgentSession } from "../../src/agent-session.ts";
import { UnsupportedError } from "../../src/errors.ts";
import { NativeTurnError } from "../../src/native/controller.ts";
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
  test("1-3: two conversations share one process and one durable session; input sent while a turn works is accepted and taken by that turn; one approval dispatches one call", async () => {
    const rig = await rigWith({ defaultPolicy: "ask", policies: { ask: { fallback: "allow", tools: { record: "ask" } } } });
    rig.script([record("approved", "rec-1"), reply("Done."), reply("Later.")]);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    const aliceEvents = rig.watch(alice), bobEvents = rig.watch(bob);
    // Creating and showing conversations launched nothing.
    expect(host.state).toBe("stopped");
    expect(rig.launches).toEqual([]);
    expect(alice.conversationCapabilities).toMatchObject({ nativeSteering: true, freshContext: false });

    const asked: Array<{ who: string; request: PermissionRequest }> = [];
    let allowAlice!: (outcome: PermissionOutcome) => void;
    // Concurrent first sends.
    const a1 = alice.prompt("a1", { onPermissionRequest: (request) => { asked.push({ who: "alice", request }); return new Promise((resolve) => { allowAlice = resolve; }); } });
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
    const a2 = alice.prompt({ text: "a2", delivery: "steer" });
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
    expect(kinds(aliceEvents)).toEqual([`turn_started:${first.operationId}`, `turn_completed:${first.operationId}`]);
    expect(aliceEvents.find((event) => event.kind === "turn_started")!.cause.messageIds).toEqual([a1.id]);
    expect(kinds(bobEvents)).toEqual([`turn_started:${bobResult.operationId}`, `turn_completed:${bobResult.operationId}`]);
    status = await host.status();
    expect(status.execution).toBe("idle");
    expect(asked).toHaveLength(2);
    expect(host.launches).toBe(1);
    expect(await recordedReplies(agent, alice)).toEqual(["Recording.", "Done."]);
  }, 30_000);

  test("4: a conversation-level forceStop interrupts only its own turn; the other channel and the shared process keep running; the interrupted channel takes fresh input", async () => {
    const rig = await rigWith();
    rig.script([hold("k"), reply("Finished."), reply("Next.")]);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const [alice, bob] = await two(agent);
    const aliceEvents = rig.watch(alice);
    const a1 = track(alice.prompt("a1")), b1 = bob.prompt("b1");
    await until(() => rig.effects().filter((line) => line === "start:k").length === 2, "both tools to start");
    await until(() => alice.state.operation?.stage === "tool_running" && bob.state.operation?.stage === "tool_running", "both turns to be supervised");

    await alice.connection.forceStop();
    await until(() => a1.settled, "alice's prompt to settle");
    expect(String(a1.error)).toContain("forced stop");
    expect(aliceEvents.some((event) => event.kind === "turn_failed")).toBe(true);
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
    expect(host.records.pendingChanges()).toEqual([]); // confirmed by the open
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
    const before = host.records.pendingChange(bob.id)!;
    expect(before.desire).toEqual({ displayName: "Bob", lifecycle: "suspended" });
    rig.env.HARNESS_TEST_FAULT = "beginChannelSuspend:1"; // dies inside the open, after the suspension commits
    const failed = await alice.prompt("a1").catch((error) => error);
    expect(failed).toBeInstanceOf(Error);
    delete rig.env.HARNESS_TEST_FAULT;
    expect(host.state).toBe("stopped");
    // Unconfirmed, so still the host's pending state, unchanged.
    expect(host.records.pendingChange(bob.id)).toEqual(before);
    // The prompt that failed was never handed over, so it must not run later.
    expect(host.records.submissions()).toEqual([]);

    const result = await alice.prompt("a2");
    expect(result).toMatchObject({ status: "completed", text: "reply 1" });
    expect(host.launches).toBe(2);
    expect(host.records.pendingChanges()).toEqual([]);
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
    expect(agent.nativeHarness!.records.pendingChange(conversation.id)?.desire).toEqual({ policy: "open" });
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
    expect(host.records.pendingChange(bob.id)?.desire).toMatchObject({ lifecycle: "retired" });
    expect(await alice.prompt("a2")).toMatchObject({ status: "completed" });
    expect(host.records.pendingChanges()).toEqual([]);
    expect((await host.status()).channels.find((channel) => channel.channel === bob.id)).toMatchObject({ lifecycle: "retired" });
  }, 30_000);

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
