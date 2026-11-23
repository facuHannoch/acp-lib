import { expect, test } from "bun:test";
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

for (const action of ["interrupt", "stop", "close"] as const) {
  test(`native ${action} leaves an accepted input in the harness`, async () => {
    const rig = await nativeRig();
    try {
      rig.script([hold("active"), reply("Kept.")]);
      const agent = await rig.open();
      const conversation = await agent.conversations.create();
      const host = agent.nativeHarness!;
      const events = rig.watch(conversation);
      const tool = Promise.withResolvers<void>();
      const interrupted = conversation.prompt("first", { onActivity: event => { if (event.kind === "tool") tool.resolve(); } });
      void interrupted.catch(() => undefined);
      await tool.promise;
      const accepted = Promise.withResolvers<void>();
      const push = host.push.bind(host);
      host.push = async input => { const receipt = await push(input); accepted.resolve(); return receipt; };
      const queued = conversation.prompt({ text: "left with the harness", delivery: "steer" });
      const queuedResult = queued.catch(error => error);
      await accepted.promise;

      if (action === "interrupt") {
        conversation.interrupt({ clearQueue: true });
        expect(await queuedResult).toMatchObject({ status: "completed", text: "Kept." });
      } else {
        if (action === "stop") await conversation.stop();
        else await agent.close();
        expect(await queuedResult).toMatchObject({ message: "the conversation stopped observing this native input" });
        const current = action === "stop" ? host : (await rig.open()).nativeHarness!;
        await current.ensureStarted();
        const { items } = await current.reconcileChannel({ channel: conversation.id, itemIds: [queued.id] });
        expect(items).toHaveLength(1);
        expect(items[0]?.milestone).not.toBe("withdrawn");
      }
      expect(events.filter(event => event.kind === "message_withdrawn" && event.id === queued.id)).toEqual([]);
    } finally {
      rig.release("active");
      await rig.clean();
    }
  }, 30_000);
}

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
