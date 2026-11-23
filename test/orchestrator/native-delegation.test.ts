import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, createAgentConversationId } from "../../src/index.ts";
import { createInProcessHarness } from "../../src/native-harness/src/testing.ts";
import type { ItemStatus } from "../../src/native-harness/src/client.ts";
import { modelScenario } from "../../src/native-harness/test/helpers/scenario.ts";
import { createNativeFunctionHost } from "../../src/native/functions.ts";
import type { NativeFunctionContext } from "../../src/native/functions.ts";
import type { OrchestratorConfig } from "../../src/orchestrator/config.ts";
import { takenSender } from "../../src/native/delegation-sender.ts";
import { withDelegationTools } from "../../src/orchestrator/native-delegation.ts";
import { matchWorkerPermissionLevel } from "../../src/orchestrator/policy.ts";
import { nativeRig } from "../native/support.ts";

const allowed = { use: true, scope: "all", redirect: true } as const;
const call = (name: string, args: Record<string, unknown>, id = name) =>
  ({ content: null, calls: [{ id, name, arguments: args }] });

async function waitFor<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("native tools route an in-process two-policy turn with taken-input attribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-native-delegation-"));
  const script = join(directory, "model.jsonl");
  const workerText = "[lifecycle:tool]";
  await writeFile(script, modelScenario([
    call("pause", {}), call("delegate", { text: workerText, about: "Investigate" }),
    call("check", { worker: "w1" }), call("list", {}), call("stop", { worker: "w1" }),
    call("stop", { worker: "w1" }, "stop-idle"), { content: "Done." },
  ]));
  const config: OrchestratorConfig = {
    workers: { limit: 1, idleStopMs: false },
    policies: {
      owner: { delegation: allowed, workerPermissions: { default: "allow" } },
      guest: { delegation: { use: true, scope: "none", redirect: false, maxOpen: 1 }, workerPermissions: { default: "ask" } },
    },
  };
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { fixture: { command: ["bun", resolve(import.meta.dir, "../fixtures/lifecycle-agent.ts")] } },
    capture: { message: "content" }, checkpointing: { enabled: false },
    conversationDefaults: { env: { LIFECYCLE_TOOL_GATE_FILE: join(directory, "worker-tool-gate") } },
    orchestrator: config,
  });
  const harness = createInProcessHarness({ home: join(directory, "harness") });
  const { client } = harness;
  const paused = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), ended = Promise.withResolvers<void>();
  const channel = createAgentConversationId();
  const open = spyOn(agent.orchestrator!, "open");
  const outputs = new Map<string, unknown>();
  const stopResults: unknown[] = [];
  let delegateInvocationId: string | undefined;
  const functions = createNativeFunctionHost(withDelegationTools({
    tools: { pause: { description: "Wait for the next input", parameters: { type: "object" }, async handler() {
      paused.resolve();
      await waitFor(release.promise, "release of the consumer tool");
      return "ready";
    } } },
  }, config, () => agent.orchestrator!, () => agent.conversations));
  client.serveFunctions(async (call, signal) => {
    // Stand in for the NativeHost callback until the delivery branch is merged.
    const result = await functions.call(call, signal, () => takenSender(client, call.channel, call.turnId, signal));
    outputs.set(call.tool, result.output);
    if (call.tool === "delegate") delegateInvocationId = call.invocationId;
    if (call.tool === "stop") stopResults.push(result.output);
    return result;
  }, read => functions.read(read));
  client.onChannelEvent(event => {
    if (event.channel === channel && event.event.type === "turn_ended") ended.resolve();
  });
  try {
    await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: channel, controllerKind: "native" });
    await client.initialize({
      protocolVersion: 1, host: { name: "delegation-test", version: "1" },
      callbacks: ["functions/call"], functions: functions.handlers(), subscription: { text: "final", tools: "full" },
    });
    await client.createSession({
      sessionId: "delegation", participants: [], channels: {}, tools: functions.catalog(),
      config: { version: 1, system: "Delegate.", model: { protocol: "scripted", script }, defaultPolicy: "owner",
        policies: { owner: { fallback: "allow", tools: {} }, guest: { fallback: "allow", tools: {} } } },
    });
    expect((await client.tools()).tools).toEqual(expect.arrayContaining(
      ["delegate", "check", "list", "stop", "pause"].map(name => ({ name, handler: name, group: "fixed", available: true })),
    ));
    await client.createChannel({ channel });
    await client.push({ channel, item: { id: "first", kind: "user_message", sender: "alice", content: [{ type: "text", text: "start" }] } });
    await waitFor(paused.promise, "the first call to reach the host");
    await client.notify({ channel, notice: { id: "second", source: "guest-label", text: "second input", policyNames: ["guest"] } });
    release.resolve();
    await waitFor(ended.promise, "the giving turn to end");
    expect(outputs.get("delegate")).toEqual({ status: "sent", handle: "w1" });
    expect(outputs.get("check")).toMatchObject({ state: "busy", sender: "alice" });
    expect(outputs.get("list")).toMatchObject([{ handle: "w1", state: "busy" }]);
    expect(stopResults).toEqual([{ status: "stopped" }, { status: "idle" }]);
    expect(open).toHaveBeenCalledTimes(1);
    const [actor] = open.mock.calls[0]!;
    expect(actor).toMatchObject({
      kind: "conversation", conversationId: channel, sender: "alice", invocationId: delegateInvocationId,
      policyNames: ["guest", "owner"], policy: { use: true, scope: "none", redirect: false, maxOpen: 1 },
      isOwner: false,
    });
    expect(actor.kind === "conversation" && matchWorkerPermissionLevel({}, actor.workerPermissions)).toBe("ask");
  } finally {
    release.resolve();
    try { await harness.close(); }
    finally {
      try { await agent.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}, 30_000);

test("taken-item attribution keeps notice labels distinct from participant IDs", async () => {
  const read = (kind: ItemStatus["kind"], sender: string) => takenSender({
    async reconcileChannel({ turnIds }) {
      return {
        revision: 1, unknownItemIds: [], unknownTurnIds: [], replies: [],
        turns: turnIds ? [{ channel: "giver", turnId: "1", state: "running", items: ["first"] }] : [],
        items: turnIds ? [] : [{ channel: "giver", turnId: "1", id: "first", kind, sender, milestone: "taken" }],
      };
    },
  }, "giver", "1", new AbortController().signal);
  await expect(read("external_notice", "alice")).resolves.toBe("notice:alice");
  await expect(read("external_notice", "host")).resolves.toBe("notice:host");
  await expect(read("channel_notice", "other-channel")).resolves.toBe("notice:other-channel");
  await expect(read("participant_message", "alice")).resolves.toBe("alice");
  await expect(read("participant_message", "notice:alice")).resolves.toBe("participant:notice:alice");
  await expect(read("participant_message", "participant:notice:alice")).resolves.toBe("participant:participant:notice:alice");
});

test.each([
  ["plain sender", "alice", "alice"],
  ["leading space", " notice:w1", "participant:notice:w1"],
  ["leading NBSP", "\u00a0notice:w1", "participant:notice:w1"],
  ["leading tab", "\tparticipant:w1", "participant:participant:w1"],
  ["zero-width space only", "\u200b \u200b", null],
])("the production host resolves delegation attribution during open (%s)", async (_case, sender, attribution) => {
  const rig = await nativeRig();
  try {
    rig.script([call("delegate", { text: "Work on this" }), { content: "Delegated." }]);
    let channel: string;
    const result = Promise.withResolvers<unknown>();
    rig.harness.connect = async () => {
      const harness = createInProcessHarness({ home: rig.home });
      const { client } = harness;
      const closed = Promise.withResolvers<void>();
      client.onChannelEvent(({ channel: eventChannel, event }) => {
        if (eventChannel === channel && event.type === "tool_call" && event.output !== undefined) {
          result.resolve(JSON.parse(event.output));
        }
      });
      const create = client.createSession.bind(client);
      client.createSession = async params => {
        const opened = await create(params);
        await client.push({ channel, item: { id: "during-open", kind: "user_message", sender,
          content: [{ type: "text", text: "Delegate this while opening" }] } });
        // Keep the production host in #open until the real harness records the callback result.
        await waitFor(result.promise, "the delegation callback during host open");
        return opened;
      };
      return { client, closed: closed.promise, async kill() { harness.close(); closed.resolve(); } };
    };
    const agent = await rig.open({
      adapters: { main: { kind: "native" }, worker: { command: ["bun", resolve(import.meta.dir, "../fixtures/lifecycle-agent.ts")] } },
      orchestrator: { workers: { adapterId: "worker", limit: 1 }, policies: { open: { delegation: allowed } } },
    });
    const open = spyOn(agent.orchestrator!, "open");
    channel = (await agent.conversations.create({ title: "Giver" })).id;
    await agent.nativeHarness!.start();
    if (attribution === null) {
      expect(await result.promise).toMatchObject({ ok: false, code: "delegation_sender_unavailable" });
      expect(open).not.toHaveBeenCalled();
      return;
    }
    expect(await result.promise).toMatchObject({ ok: true, output: { status: "sent", handle: "w1" } });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({ kind: "conversation", sender: attribution,
      conversationId: channel, invocationId: "1:delegate", policyNames: ["open"] });
  } finally {
    await rig.clean();
  }
}, 30_000);

test("native delegation declines unknown or absent policies, and uses explicit empty-list defaults", async () => {
  const channel = createAgentConversationId();
  const config: OrchestratorConfig = {
    workers: { limit: 1 },
    policies: { owner: { delegation: allowed } },
    defaults: { delegation: allowed, workerPermissions: { default: "allow" } },
  };
  const received: unknown[] = [];
  const getOrchestrator = () => ({
    list(actor: unknown) { received.push(actor); return Promise.resolve([]); },
  }) as unknown as NonNullable<Agent["orchestrator"]>;
  const getConversations = () => ({
    async get() { return { controllerKind: "native" }; },
  }) as Pick<Agent["conversations"], "get">;
  const functions = withDelegationTools(undefined, config, getOrchestrator, getConversations);
  const context: NativeFunctionContext = {
    tool: "list", channel, turnId: "1", invocationId: "list-1", signal: new AbortController().signal,
    policyNames: [], takenSender: async () => "notice-label",
  };
  const list = functions.tools.list!;
  await expect(list.handler({}, { ...context, policyNames: undefined } as unknown as NativeFunctionContext)).rejects.toMatchObject({ code: "delegation_policy_unknown" });
  await expect(list.handler({}, { ...context, policyNames: ["unconfigured"] })).rejects.toMatchObject({ code: "delegation_policy_unknown" });
  await expect(list.handler({}, { ...context, takenSender: undefined })).rejects.toMatchObject({ code: "delegation_sender_unavailable" });
  expect(received).toHaveLength(0);
  await expect(list.handler({}, context)).resolves.toEqual([]);
  await expect(list.handler({}, { ...context, policyNames: ["owner"] })).resolves.toEqual([]);
  expect(received).toMatchObject([
    { sender: "notice-label", policy: allowed, policyNames: [], workerPermissions: [{ default: "allow" }], isOwner: false },
    { sender: "notice-label", policy: allowed, policyNames: ["owner"], workerPermissions: [{ default: "ask" }], isOwner: true },
  ]);
  expect(() => withDelegationTools({ tools: { list } }, config, getOrchestrator, getConversations)).toThrow("native delegation tool name is already registered: list");
});
