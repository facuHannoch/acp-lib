import { afterEach, expect, test } from "bun:test";
import { NativeUsageLedger } from "../../src/metering/native/ledger.ts";
import { HarnessClient, createInProcessTransport, type ModelUsage } from "../../src/native-harness/src/client.ts";
import { createScriptedServer } from "../../src/native-harness/src/testing.ts";
import { spawnHarness } from "../../src/native-harness/test/helpers/stdio.ts";
import { hold, nativeRig, record, reply, type NativeRig } from "./support.ts";

const rigs: NativeRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.clean(); });
async function rigForUsage() {
  const rig = await nativeRig();
  rigs.push(rig);
  return rig;
}
const captureUsage = { meteringPersistence: { meteringRecords: "all" } } as const;
const totals = (inputTokens: number, outputTokens: number, totalTokens: number): ModelUsage =>
  ({ inputTokens, outputTokens, totalTokens });

test("native metering matches the scripted attempts and the paged stdio ledger", async () => {
  const rig = await rigForUsage();
  let pricingCalls = 0;
  const agent = await rig.open({ ...captureUsage, conversationDefaults: { metering: { pricing() { pricingCalls++; return null; } } } });
  const host = agent.nativeHarness!;
  const alpha = await agent.conversations.create(), beta = await agent.conversations.create();
  const values = [totals(101, 7, 108), totals(55, 1, 56), totals(207, 13, 220), totals(311, 19, 330)];
  const betaUsage = totals(41, 3, 44);
  rig.script([
    { ...hold("metered-tool"), channelId: alpha.id, usage: values[0] },
    { failure: { kind: "transient", message: "retry fixture" }, channelId: alpha.id, usage: values[1] },
    { ...record("metered second tool"), channelId: alpha.id, usage: values[2] },
    { ...reply("metered reply"), channelId: alpha.id, usage: values[3] },
    { ...reply("other channel"), channelId: beta.id, usage: betaUsage },
  ]);
  const entered = Promise.withResolvers<void>();
  const pending = alpha.prompt("use tools", { onActivity(event) { if (event.kind === "tool") entered.resolve(); } });
  let other;
  try {
    await entered.promise;
    other = await beta.prompt("interleave");
  } finally { rig.release("metered-tool"); }
  const result = await pending;
  expect(result.usage).toBeNull();
  const [persisted] = (await agent.persistence.metering.list(alpha.id)).records;
  expect(persisted ?? null).toEqual(result.metering);
  expect(persisted).toMatchObject({
    outcome: "completed", internalSessionId: `${agent.id}/${alpha.id}`,
    nextState: { operationCount: 1, totals: { total: { knownTokens: 714 } } },
    provider: { adapterId: "main", providerId: null, model: null },
    usage: { status: "metered", reportedCumulative: totals(674, 40, 714), attributable: { totalTokens: 714 } },
    pricingStatus: "pricing_unavailable", pricingFailureReason: "native model-call records do not identify the provider or model",
    provenance: { source: "native_ledger", attribution: "partial", routing: "unknown" },
  });
  expect(persisted?.provenance.certificationId).toBeUndefined();
  expect(pricingCalls).toBe(0);
  expect(persisted?.nativeUsage?.status).toBe("observed");
  const evidence = persisted!.nativeUsage!;
  if (evidence.status !== "observed") throw new Error("no native evidence");
  expect(evidence.unmeasured).toBe(0);
  expect(evidence.channel).toBe(alpha.id);
  expect(persisted?.operationId).toBe(`native-turn-${evidence.turnId}`);
  expect(evidence.calls).toHaveLength(3);
  expect(evidence.calls.flatMap(call => call.attempts.map(attempt => attempt.usage))).toEqual(values);
  expect(evidence.calls.flatMap(call => call.attempts.map(attempt => attempt.outcome)))
    .toEqual(["succeeded", "transient_failure", "succeeded", "succeeded"]);

  const ledger = [];
  let after: string | undefined;
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const page = await host.modelCalls({ after, limit: 1 });
    expect(page.calls).toHaveLength(1);
    ledger.push(...page.calls);
    after = page.next;
    if (after === undefined) break;
  }
  expect(after).toBeUndefined();
  expect(ledger.map(call => call.channel)).toEqual([alpha.id, beta.id, alpha.id, alpha.id]);
  expect(evidence.calls).toEqual(ledger.filter(call => call.turnId === evidence.turnId && call.channel === alpha.id)
    .map(({ callId, channel, turnId, outcome, attempts }) => ({
      callId, channel, turnId, outcome, attempts: attempts.map(({ attemptId, ordinal, outcome, usage }) => ({
        attemptId, ordinal, outcome, usage,
      })),
    })));
  expect(other.metering?.usage).toMatchObject({ status: "metered", reportedCumulative: betaUsage });
}, 20_000);

test("native metering closes an already-ended backend turn with the held wire identity", async () => {
  const rig = await rigForUsage();
  const raw = Promise.withResolvers<HarnessClient>();
  rig.harness.connect = async () => {
    const child = spawnHarness({ home: rig.home });
    raw.resolve(child.client);
    return { client: child.client, closed: child.child.exited.then(() => undefined), kill: () => child.close() };
  };
  rig.script([{ ...reply("first"), usage: totals(4, 1, 5) }, { ...reply("held"), usage: totals(11, 3, 14) }]);
  const agent = await rig.open(captureUsage), host = agent.nativeHarness!;
  const conversation = await agent.conversations.create();
  await host.start();
  const client = await raw.promise;
  const firstRead = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const modelCalls = client.modelCalls.bind(client);
  let reads = 0;
  client.modelCalls = async (...args) => {
    if (++reads === 1) {
      firstRead.resolve();
      await release.promise;
    }
    return modelCalls(...args);
  };
  const first = conversation.prompt("first");
  const heldEnded = Promise.withResolvers<string>(), settled = Promise.withResolvers<void>();
  await firstRead.promise;
  const offWire = client.onChannelEvent(({ channel, event }) => {
    if (channel === conversation.id && event.type === "turn_ended") heldEnded.resolve(event.turnId);
  });
  const offConversation = conversation.subscribe(({ event }) => {
    if (event.kind === "turn_completed") {
      void heldEnded.promise.then(id => { if (event.turnId === `native-turn-${id}`) settled.resolve(); });
    }
  });
  try {
    await client.push({ channel: conversation.id, item: { id: "operator-input", kind: "user_message", sender: "operator",
      content: [{ type: "text", text: "held backend" }] } });
    await heldEnded.promise;
  } finally { release.resolve(); }
  try {
    await first;
    await settled.promise;
    const id = await heldEnded.promise;
    const { records } = await agent.persistence.metering.list(conversation.id);
    expect(records).toHaveLength(2);
    expect(records.find(record => record.operationId === `native-turn-${id}`)).toMatchObject({
      nativeUsage: { status: "observed", turnId: id, channel: conversation.id },
      usage: { status: "metered", reportedCumulative: totals(11, 3, 14) },
    });
    const transcript = await agent.persistence.records.list(conversation.id);
    expect(transcript.records.filter(record => record.operationId === `native-turn-${id}` && record.kind === "message" && record.role === "user")).toEqual([]);
  } finally { offWire(); offConversation(); }
}, 18_000);

test("native metering uses the exact reconciled terminal turn after stdio restart", async () => {
  const rig = await rigForUsage();
  rig.script([{ ...reply("committed before crash"), usage: totals(20, 9, 29) }]);
  rig.env.HARNESS_TEST_FAULT = "finishTurn:1";
  const agent = await rig.open(captureUsage), host = agent.nativeHarness!;
  const conversation = await agent.conversations.create();
  await host.start();
  delete rig.env.HARNESS_TEST_FAULT;
  const result = await conversation.prompt("recovered");
  expect(host.launches).toBe(2);
  expect(result.text).toBe("committed before crash");
  const [persisted] = (await agent.persistence.metering.list(conversation.id)).records;
  expect(persisted).toMatchObject({
    operationId: result.operationId,
    nativeUsage: { status: "observed", turnId: result.operationId.replace("native-turn-", ""), channel: conversation.id },
    usage: { status: "metered", reportedCumulative: totals(20, 9, 29) },
  });
}, 18_000);

test("native metering keeps observed usage for cancelled and failed turns", async () => {
  const rig = await rigForUsage();
  rig.script([
    { ...hold("cancel-meter"), usage: totals(22, 4, 26) },
    { failure: { kind: "provider", message: "fixture failure" }, usage: totals(13, 1, 14) },
  ]);
  const agent = await rig.open(captureUsage);
  const conversation = await agent.conversations.create();
  const entered = Promise.withResolvers<void>();
  const pending = conversation.prompt("cancel once running", { onActivity(event) { if (event.kind === "tool") entered.resolve(); } });
  await entered.promise;
  conversation.interrupt();
  expect((await pending).status).toBe("cancelled");
  await expect(conversation.prompt("fail after usage")).rejects.toThrow();
  const { records } = await agent.persistence.metering.list(conversation.id);
  expect(records).toHaveLength(2);
  expect(records.find(record => record.outcome === "cancelled")?.usage).toMatchObject({
    status: "metered", reportedCumulative: totals(22, 4, 26),
  });
  expect(records.find(record => record.outcome === "error")?.usage).toMatchObject({
    status: "metered", reportedCumulative: totals(13, 1, 14),
  });
}, 18_000);

test("native metering records host loss at close without reopening to read", async () => {
  const rig = await rigForUsage();
  rig.script([{ ...hold("before-loss"), usage: totals(7, 5, 12) }, { ...reply("committed"), usage: totals(10, 5, 15) }]);
  rig.env.HARNESS_TEST_FAULT = "finishTurn:1";
  rig.harness.restart = { limit: 0, windowMs: 60_000 };
  const agent = await rig.open(captureUsage), host = agent.nativeHarness!;
  const conversation = await agent.conversations.create();
  const entered = Promise.withResolvers<void>();
  const pending = conversation.prompt("host lost", { onActivity(event) { if (event.kind === "tool") entered.resolve(); } }).catch(error => error);
  await entered.promise;
  rig.release("before-loss");
  expect(await pending).toBeInstanceOf(Error);
  expect(host.launches).toBe(1);
  const [persisted] = (await agent.persistence.metering.list(conversation.id)).records;
  expect(persisted).toMatchObject({
    outcome: "error",
    nativeUsage: { status: "unavailable", channel: conversation.id, turnId: "1",
      reason: expect.stringContaining("native harness is not running") },
    usage: { status: "usage_unavailable" },
  });
  expect(persisted?.operationId).toBe(`native-turn-${persisted?.nativeUsage?.turnId}`);
}, 18_000);

test("a slow model-call read through the real host client is cancellable while another channel reads", async () => {
  const rig = await rigForUsage();
  const { server } = createScriptedServer({ home: rig.home });
  const transport = createInProcessTransport(server);
  const requestEntered = Promise.withResolvers<void>();
  let raw: ReturnType<HarnessClient["modelCalls"]> | undefined;
  let dropPage = true;
  const client = new HarnessClient({ ...transport, send(request) {
    if (request.method === "session/model-calls" && dropPage) {
      dropPage = false;
      requestEntered.resolve();
      return;
    }
    transport.send(request);
  } });
  const closed = Promise.withResolvers<void>();
  rig.harness.connect = async () => ({
    client, closed: closed.promise,
    async kill() { client.close(); server.dispose(); closed.resolve(); },
  });
  const original = client.modelCalls.bind(client);
  client.modelCalls = (...args) => {
    const page = original(...args);
    raw ??= page;
    return page;
  };
  const agent = await rig.open(), host = agent.nativeHarness!;
  await host.start();
  const cancelled = new AbortController();
  const pending = host.usageLedger.readTurn("alpha", "t1", { signal: cancelled.signal }).catch(error => error);
  await requestEntered.promise;
  try {
    expect(await host.usageLedger.readTurn("beta", "t2")).toMatchObject({ calls: [] });
  } finally { cancelled.abort(); }
  expect((await pending).message).toContain("read cancelled");
  const clientError = await raw!.catch(error => error);
  expect(clientError).toMatchObject({ code: "cancelled", message: "Request cancelled: session/model-calls" });

  raw = undefined;
  dropPage = true;
  const short = new NativeUsageLedger(() => (query, signal) => host.modelCalls(query, signal), { timeoutMs: 20, maxPages: 2 });
  const timeout = await short.readTurn("alpha", "t1").catch(error => error);
  expect(timeout).toBeInstanceOf(Error);
  expect(timeout.message).toContain("read timed out");
  expect(await raw!.catch(error => error)).toMatchObject({ code: "cancelled" });
  expect(await host.modelCalls()).toEqual({ calls: [] });
}, 12_000);
