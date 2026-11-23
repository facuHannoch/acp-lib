import { expect, test } from "bun:test";
import { nativeRig, reply, until } from "./support.ts";

test("native replacement notice retries a lost receipt and keeps ACP work off the wire", async () => {
  const rig = await nativeRig();
  try {
    rig.script([reply("Notice handled")]);
    rig.env.HARNESS_TEST_FAULT = "acceptItem:1";
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const target = await agent.conversations.create();
    await host.changeChannel(target.id, { displayName: "Target" });
    await host.start();
    delete rig.env.HARNESS_TEST_FAULT;

    const repository = agent.persistence.workerDelivery!;
    const previous = {
      assignmentId: "old", workerConversationId: "worker-conversation", workerHandle: "worker-handle",
      messageId: "old-message", destination: { kind: "native" as const, id: target.id },
      originatingPolicyNames: [], contributingPolicyNames: [],
    };
    expect(await repository.reserve(previous)).toBe("reserved");
    const replacement = { ...previous, assignmentId: "new", messageId: "new-message",
      destination: { kind: "acp" as const, id: "acp-conversation" } };
    expect(await repository.replaceAssignment("old", "old-message", replacement))
      .toEqual({ kind: "replaced", reservation: "reserved" });
    await repository.recordFailure(replacement.workerConversationId, "acp-operation", [replacement.messageId],
      { kind: "failed", reason: "worker failed", possiblePartialEffects: true });

    await host.flushWorkerDelivery();
    await until(async () => (await repository.readStaged("old"))?.delivery.state === "delivered", "old notice receipt");
    expect(host.launches).toBeGreaterThan(1);
    expect((await repository.readStaged("new"))?.delivery.state).toBe("pending");
    const staged = await repository.readStaged("old");
    expect(staged?.delivery).toMatchObject({ id: "worker-result:old", source: "worker-handle",
      destination: previous.destination, state: "delivered" });
    expect(await repository.redirect("old", replacement.destination)).toBe(false);
    expect(await repository.readStaged("old")).toEqual(staged);
    const timeline = await host.timeline();
    expect(timeline.events.filter(entry => entry.kind === "external_notice").map(entry => entry.itemId))
      .toEqual(["worker-result:old"]);
  } finally { await rig.clean(); }
}, 30_000);

test("native worker delivery stays pending on suspension and retries after resume", async () => {
  const rig = await nativeRig();
  try {
    rig.script([reply("Handled after resume")]);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const target = await agent.conversations.create();
    await host.changeChannel(target.id, { displayName: "Target" });
    await host.changeChannel(target.id, { lifecycle: "suspended" });
    const repo = agent.persistence.workerDelivery!;
    await repo.reserve({
      assignmentId: "waiting", workerConversationId: "worker", workerHandle: "worker-handle",
      messageId: "message", destination: { kind: "native", id: target.id },
      originatingPolicyNames: [], contributingPolicyNames: [],
    });
    await repo.recordFailure("worker", "operation", ["message"],
      { kind: "failed", reason: "worker failed", possiblePartialEffects: true });
    await host.start();
    await host.flushWorkerDelivery();
    expect((await repo.readStaged("waiting"))?.delivery.state).toBe("pending");
    expect((await host.timeline()).events).toEqual([]);
    await host.resumeChannel(target.id);
    await until(async () => (await repo.readStaged("waiting"))?.delivery.state === "delivered", "resumed delivery");
    expect((await host.timeline()).events.filter(event => event.kind === "external_notice")).toHaveLength(1);
  } finally { await rig.clean(); }
}, 30_000);

test("native worker delivery blocks invalid policy and retains a failed destination outcome", async () => {
  const rig = await nativeRig();
  try {
    rig.script([reply("Unexpected")]);
    const agent = await rig.open();
    const host = agent.nativeHarness!;
    const target = await agent.conversations.create();
    await host.changeChannel(target.id, { displayName: "Target" });
    await host.start();
    const repo = agent.persistence.workerDelivery!;
    for (const [id, destination, policies] of [
      ["bad-policy", target.id, ["undefined-policy"]],
      ["missing-target", "no-such-channel", []],
    ] as const) {
      await repo.reserve({ assignmentId: id, workerConversationId: "worker", workerHandle: "handle",
        messageId: id, destination: { kind: "native", id: destination },
        originatingPolicyNames: policies, contributingPolicyNames: [] });
      await repo.recordFailure("worker", id, [id], { kind: "failed", reason: "worker failed", possiblePartialEffects: true });
    }
    await host.flushWorkerDelivery();
    const blocked = await repo.readStaged("bad-policy");
    const failed = await repo.readStaged("missing-target");
    expect(blocked?.delivery.state).toBe("blocked_policy");
    expect(failed).toMatchObject({ outcome: { kind: "failed" }, delivery: { state: "failed_destination" } });
    await host.flushWorkerDelivery();
    expect(await repo.readStaged("bad-policy")).toEqual(blocked);
    expect(await repo.readStaged("missing-target")).toEqual(failed);
    const id = blocked!.delivery.id;
    expect(await repo.transitionDelivery(id, { from: "blocked_policy", to: "pending", explicitRetry: true })).toBe(true);
    await host.flushWorkerDelivery();
    expect(await repo.readStaged("bad-policy")).toEqual(blocked);
    expect((await host.timeline()).events).toEqual([]);
  } finally { await rig.clean(); }
}, 30_000);

test("an ACP worker completes offline and its notice wakes a detached native destination", async () => {
  const rig = await nativeRig();
  try {
    rig.script([reply("Detached reply")]);
    const agent = await rig.open({
      adapters: {
        main: { kind: "native" },
        worker: { command: [process.execPath, new URL("../fixtures/echo-prompt-agent.ts", import.meta.url).pathname] },
      },
    });
    const host = agent.nativeHarness!;
    const target = await agent.conversations.create({ title: "Destination" });
    const worker = await agent.conversations.create({ adapterId: "worker" });
    await host.changeChannel(target.id, { displayName: "Destination" });
    const repo = agent.persistence.workerDelivery!;
    const prompt = {
      text: "worker completion",
      async beforeDispatch(messageId: string) {
        expect(await repo.reserve({
          assignmentId: "offline", workerConversationId: worker.id, workerHandle: "worker-label",
          messageId, destination: { kind: "native", id: target.id },
          originatingPolicyNames: [], contributingPolicyNames: [],
        })).toBe("reserved");
      },
    };
    await worker.prompt(prompt);
    expect(host.launches).toBe(0);
    expect(await repo.readStaged("offline")).toBeUndefined();
    await host.start();
    await until(async () => (await repo.readStaged("offline"))?.delivery.state === "delivered", "offline result receipt");
    await until(async () => (await host.conversationMessages({ channel: target.id })).messages.length === 1,
      "detached notice reply");
    expect(await repo.readStaged("offline")).toMatchObject({
      outcome: { kind: "result", text: '{"prompt":"worker completion"}' },
      delivery: { id: "worker-result:offline", source: "worker-label" },
    });
    expect((await host.timeline()).events).toContainEqual(expect.objectContaining({
      kind: "external_notice", itemId: "worker-result:offline", channel: target.id,
    }));
    expect((await host.conversationMessages({ channel: target.id })).messages).toHaveLength(1);
  } finally { await rig.clean(); }
}, 30_000);

test("combined ACP steers continue one assignment through their durable message keys", async () => {
  const rig = await nativeRig();
  try {
    const agent = await rig.open({
      adapters: { worker: { command: [process.execPath, new URL("../fixtures/steer-agent.ts", import.meta.url).pathname] } },
      defaultAdapterId: "worker",
    });
    const worker = await agent.conversations.create();
    const repo = agent.persistence.workerDelivery!;
    const assignmentId = "steer-chain";
    const steer = (text: string) => worker.prompt({
      text, delivery: "steer",
      async beforeDispatch(successor) {
        const predecessor = (await repo.readBinding(assignmentId))!.messageId;
        expect(await repo.continueAssignment(assignmentId, predecessor, successor)).toBe("continued");
      },
    });
    let successors: Array<ReturnType<typeof steer>> = [];
    const result = await worker.prompt({
      text: "Read a.txt, then b.txt, then c.txt, each with its own tool call, one at a time. Then tell me the three words in order.",
      async beforeDispatch(messageId) {
        expect(await repo.reserve({ assignmentId, workerConversationId: worker.id, workerHandle: "chain-worker",
          messageId, destination: { kind: "native", id: "detached" },
          originatingPolicyNames: [], contributingPolicyNames: [] })).toBe("reserved");
      },
      handlers: { onActivity(event) {
        if (event.kind === "tool" && successors.length === 0) {
          successors = [steer("Also include the length of each word in your final answer."), steer("Keep the final answer concise.")];
        }
      } },
    });
    expect(result.endedBy).toBe("steer");
    expect(successors).toHaveLength(2);
    const [, final] = await Promise.all(successors);
    expect((await repo.readBinding(assignmentId))?.messageId).toBe(successors[1]!.id);
    expect(await repo.readStaged(assignmentId)).toBeUndefined();
    const staged = await repo.stage(assignmentId);
    expect(staged?.outcome).toMatchObject({ kind: "result", text: final!.text });
    expect((await repo.discoverAssignments({ destinationKind: "native", state: "pending" })).assignments).toHaveLength(1);
  } finally { await rig.clean(); }
}, 30_000);
