import { expect, test } from "bun:test";
import { NativeInputStoppedError } from "../../src/index.ts";
import { spawnHarness } from "../../src/native-harness/test/helpers/stdio.ts";
import { hold, nativeRig, reply } from "./support.ts";

test("native withdrawal confirms an inbox item, and a taken prompt follows its turn", async () => {
  const rig = await nativeRig();
  try {
    rig.script([hold("boundary"), reply("Done.")]);
    const agent = await rig.open();
    const conversation = await agent.conversations.create();
    const host = agent.nativeHarness!;
    const events = rig.watch(conversation);
    const tool = Promise.withResolvers<void>();
    const running = conversation.prompt("first", { onActivity: event => { if (event.kind === "tool") tool.resolve(); } });
    void running.catch(() => undefined);
    await tool.promise;
    expect(await running.withdrawAsync()).toBe(false);

    const accepted = Promise.withResolvers<void>();
    const push = host.push.bind(host);
    host.push = async (input) => {
      const receipt = await push(input);
      accepted.resolve();
      return receipt;
    };
    const queued = conversation.prompt({ text: "withdraw me", delivery: "steer" });
    void queued.catch(() => undefined);
    await accepted.promise;
    expect(queued.withdraw()).toBe(false);
    expect(await queued.withdrawAsync()).toBe(true);
    expect(await queued).toMatchObject({ status: "cancelled" });
    expect(await queued.withdrawAsync()).toBe(false);
    rig.release("boundary");
    expect(await running).toMatchObject({ status: "completed", text: "Working.\n\nDone." });
    expect(events.filter(event => event.kind === "message_withdrawn")).toEqual([{ kind: "message_withdrawn", id: queued.id }]);
    expect((await host.status()).channels[0]?.pending).toEqual([]);
  } finally {
    await rig.clean();
  }
}, 30_000);

test("withdrawal while a native dispatch hook waits cannot send the input", async () => {
  const rig = await nativeRig();
  const release = Promise.withResolvers<void>();
  try {
    const agent = await rig.open();
    const conversation = await agent.conversations.create();
    const entered = Promise.withResolvers<void>();
    const waiting = conversation.prompt({ text: "not sent", beforeDispatch: async () => { entered.resolve(); await release.promise; } });
    void waiting.catch(() => undefined);
    await entered.promise;
    expect(waiting.withdraw()).toBe(true);
    release.resolve();
    expect(await waiting).toMatchObject({ status: "cancelled" });
    expect(await conversation.prompt("next")).toMatchObject({ status: "completed", text: "reply 1" });
  } finally {
    release.resolve();
    await rig.clean();
  }
}, 30_000);

async function heldPair(rig: Awaited<ReturnType<typeof nativeRig>>, script = [hold("active"), reply("Kept.")]) {
  rig.script(script);
  const agent = await rig.open();
  const conversation = await agent.conversations.create();
  const host = agent.nativeHarness!;
  const tool = Promise.withResolvers<void>();
  const taken = Promise.withResolvers<void>();
  const running = conversation.prompt("first", { onActivity(event) {
    if (event.kind === "tool" && event.toolCallId === "hold-active") tool.resolve();
    if (event.kind === "tool" && event.toolCallId === "hold-taken") taken.resolve();
  } });
  void running.catch(() => undefined);
  await tool.promise;
  const receipt = Promise.withResolvers<void>();
  const push = host.push.bind(host);
  host.push = async input => {
    const result = await push(input);
    receipt.resolve();
    return result;
  };
  const queued = conversation.prompt({ text: "submitted", delivery: "steer" });
  const result = queued.catch(error => error);
  await receipt.promise;
  const { items } = await host.reconcileChannel({ channel: conversation.id, itemIds: [queued.id] });
  expect(items[0]?.milestone).toBe("received");
  return { agent, conversation, host, running, queued, result, taken: taken.promise };
}

test("native interrupt retains an accepted input that has not been taken", async () => {
  const rig = await nativeRig();
  try {
    const { conversation, result, queued } = await heldPair(rig);
    const events = rig.watch(conversation);
    conversation.interrupt({ clearQueue: true });
    expect(await result).toMatchObject({ status: "completed", text: "Kept." });
    expect(events.some(event => event.kind === "message_withdrawn" && event.id === queued.id)).toBe(false);
  } finally {
    rig.release("active");
    await rig.clean();
  }
}, 30_000);

for (const action of ["stop", "close"] as const) {
  test(`native ${action} withdraws unclaimed input without another model call`, async () => {
    const rig = await nativeRig();
    try {
      const { agent, conversation, host, queued, running, result } = await heldPair(rig);
      if (action === "stop") await conversation.stop();
      else await agent.close();
      expect(await running).toMatchObject({ status: "cancelled", text: "Working." });
      expect(await result).toBeInstanceOf(NativeInputStoppedError);
      expect(await result).toMatchObject({ messageId: queued.id });
      const current = action === "stop" ? host : (await rig.open()).nativeHarness!;
      await current.ensureStarted();
      const { items } = await current.reconcileChannel({ channel: conversation.id, itemIds: [queued.id] });
      expect(items[0]?.milestone).toBe("withdrawn");
      expect((await current.modelCalls()).calls).toHaveLength(1);
    } finally {
      rig.release("active");
      await rig.clean();
    }
  }, 30_000);

  test(`native ${action} shares an already pending withdrawal`, async () => {
    const rig = await nativeRig();
    const release = Promise.withResolvers<void>();
    try {
      const { agent, conversation, host, queued, result } = await heldPair(rig);
      const first = Promise.withResolvers<void>();
      const joining = Promise.withResolvers<void>();
      const withdraw = host.withdraw.bind(host);
      let wireRequests = 0, attempts = 0;
      host.withdraw = async (channel, id) => {
        wireRequests++;
        first.resolve();
        await release.promise;
        return withdraw(channel, id);
      };
      const request = host.withdrawSubmission.bind(host);
      host.withdrawSubmission = (channel, id) => {
        if (++attempts === 2) joining.resolve();
        return request(channel, id);
      };
      const pending = queued.withdrawAsync();
      void pending.catch(() => undefined);
      await first.promise;
      const stopped = action === "stop" ? conversation.stop() : agent.close();
      await joining.promise;
      release.resolve();
      await stopped;
      expect(await pending).toBe(true);
      expect(await result).toBeInstanceOf(NativeInputStoppedError);
      expect(wireRequests).toBe(1);
    } finally {
      release.resolve();
      rig.release("active");
      await rig.clean();
    }
  }, 30_000);
}

test("native stop rejects the unclaimed handle with a down host", async () => {
  const rig = await nativeRig();
  try {
    const { conversation, host, queued, result } = await heldPair(rig);
    await host.stop();
    const started = performance.now();
    await conversation.stop();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await result).toBeInstanceOf(NativeInputStoppedError);
    expect(host.records.submission(queued.id)?.withdrawing).toBe(true);
  } finally {
    rig.release("active");
    await rig.clean();
  }
}, 30_000);

test("native stop bounds an unanswered withdrawal", async () => {
  const rig = await nativeRig();
  const release = Promise.withResolvers<void>();
  try {
    const { conversation, host, result } = await heldPair(rig);
    const issued = Promise.withResolvers<void>();
    host.withdraw = async () => {
      issued.resolve();
      await release.promise;
      throw new Error("withdrawal did not answer");
    };
    const stopped = conversation.stop();
    await issued.promise;
    await stopped;
    expect(await result).toBeInstanceOf(NativeInputStoppedError);
  } finally {
    release.resolve();
    rig.release("active");
    await rig.clean();
  }
}, 30_000);

test("native shutdown keeps partial text when the withdrawal answer is the only take evidence", async () => {
  const rig = await nativeRig();
  const release = Promise.withResolvers<void>();
  let withheldTakes = 0;
  rig.harness.connect = async () => {
    const child = spawnHarness({ home: rig.home, effects: rig.effectsPath });
    const subscribe = child.client.onChannelEvent.bind(child.client);
    child.client.onChannelEvent = listener => subscribe(event => {
      // The real withdrawal reply now provides the only association of the steered item.
      if (event.event.type === "turn_took") withheldTakes++;
      else listener(event);
    });
    return { client: child.client, closed: child.child.exited.then(() => undefined), kill: () => child.close() };
  };
  try {
    const { conversation, host, result, running, taken } = await heldPair(rig, [hold("active"), hold("taken", "Taken text."), reply("Done.")]);
    const issued = Promise.withResolvers<void>();
    const actual = host.withdraw.bind(host);
    let outcome: string | undefined;
    host.withdraw = async (channel, id) => {
      issued.resolve();
      await release.promise;
      const result = await actual(channel, id);
      outcome = result.outcome;
      return result;
    };
    const stopped = conversation.stop();
    await issued.promise;
    rig.release("active");
    await taken;
    release.resolve();
    await stopped;
    expect(outcome).toBe("taken");
    expect(withheldTakes).toBe(1);
    expect(await result).toMatchObject({ status: "cancelled", text: "Working.\n\nTaken text.", operationId: (await running).operationId });
  } finally {
    release.resolve();
    rig.release("active");
    rig.release("taken");
    await rig.clean();
  }
}, 30_000);

test("native supervision leaves a turn pending past the client stall limits during reopen", async () => {
  const reopening = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rig = await nativeRig({ beforeLaunch: async count => { if (count === 2) { reopening.resolve(); await release.promise; } } });
  try {
    rig.script([hold("crash-at-reply"), reply("Committed.")]);
    rig.env.HARNESS_TEST_FAULT = "commitResponse:2";
    const agent = await rig.open({ operationLifecycle: { turns: { firstOutputMs: 15, nextOutputMs: 15, toolMs: 15 } } });
    const conversation = await agent.conversations.create({ title: "R6 recovery" });
    const tool = Promise.withResolvers<void>();
    const prompt = conversation.prompt("recover me", { onActivity: event => { if (event.kind === "tool") tool.resolve(); } });
    let settlementCount = 0;
    const result = prompt.then(value => { settlementCount++; return value; }, error => { settlementCount++; return error; });
    await tool.promise;
    delete rig.env.HARNESS_TEST_FAULT;
    rig.release("crash-at-reply");
    await reopening.promise;
    // Deliberately measure past the consumer's configured deadlines while launch is gated.
    expect(await Promise.race([result, Bun.sleep(60).then(() => "waiting")])).toBe("waiting");
    release.resolve();
    expect(await result).toMatchObject({ cause: { outcome: "interrupted" } });
    expect(settlementCount).toBe(1);
    expect(agent.nativeHarness?.launches).toBe(2);
  } finally {
    release.resolve();
    await rig.clean();
  }
}, 30_000);

test("a native prompt follows the turn when take wins against an in-flight withdrawal", async () => {
  const rig = await nativeRig();
  const proceed = Promise.withResolvers<void>();
  try {
    rig.script([hold("first"), hold("taken"), reply("Done.")]);
    const agent = await rig.open();
    const conversation = await agent.conversations.create();
    const host = agent.nativeHarness!;
    const first = Promise.withResolvers<void>();
    const taken = Promise.withResolvers<void>();
    const running = conversation.prompt("first", { onActivity(event) {
      if (event.kind === "tool" && event.toolCallId === "hold-first") first.resolve();
      if (event.kind === "tool" && event.toolCallId === "hold-taken") taken.resolve();
    } });
    void running.catch(() => undefined);
    await first.promise;
    const accepted = Promise.withResolvers<void>();
    const push = host.push.bind(host);
    host.push = async input => { const receipt = await push(input); accepted.resolve(); return receipt; };
    const steered = conversation.prompt({ text: "taken", delivery: "steer" });
    void steered.catch(() => undefined);
    await accepted.promise;
    const issuing = Promise.withResolvers<void>();
    const withdraw = host.withdrawSubmission.bind(host);
    host.withdrawSubmission = async (channel, id) => {
      issuing.resolve();
      await proceed.promise;
      return withdraw(channel, id);
    };
    const withdrawing = steered.withdrawAsync();
    void withdrawing.catch(() => undefined);
    await issuing.promise;
    rig.release("first");
    await taken.promise;
    proceed.resolve();
    expect(await withdrawing).toBe(false);
    rig.release("taken");
    const [originalResult, steeredResult] = await Promise.all([running, steered]);
    expect(steeredResult).toMatchObject({ status: "completed", operationId: originalResult.operationId });
  } finally {
    proceed.resolve();
    rig.release("first");
    rig.release("taken");
    await rig.clean();
  }
}, 30_000);
