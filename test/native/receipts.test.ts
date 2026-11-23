import { expect, test } from "bun:test";
import { NativeController } from "../../src/native/controller.ts";
import { hold, nativeRig, reply } from "./support.ts";

test("stdio reports native item receipts to the owning conversation", async () => {
  const rig = await nativeRig();
  try {
    rig.script([hold("receipts"), reply("Done.")]);
    const agent = await rig.open();
    const alice = await agent.conversations.create();
    const bob = await agent.conversations.create();
    const host = agent.nativeHarness!;
    const aliceEvents = rig.watch(alice), bobEvents = rig.watch(bob);
    const tool = Promise.withResolvers<void>();
    const original = alice.prompt("original", { onActivity(event) { if (event.kind === "tool") tool.resolve(); } });
    void original.catch(() => undefined);
    await tool.promise;
    const accepted = Promise.withResolvers<void>();
    const push = host.push.bind(host);
    host.push = async input => { const result = await push(input); accepted.resolve(); return result; };
    const steered = alice.prompt({ text: "steered", delivery: "steer" });
    void steered.catch(() => undefined);
    await accepted.promise;
    rig.release("receipts");
    const [first, second] = await Promise.all([original, steered]);
    expect(second.operationId).toBe(first.operationId);
    expect(second.status).toBe("completed");
    expect(aliceEvents.filter(event => event.kind === "items_receipt")).toEqual([
      { kind: "items_receipt", turnId: first.operationId, itemIds: [original.id], milestone: "delivered" },
      { kind: "items_receipt", turnId: first.operationId, itemIds: [original.id], milestone: "seen" },
      { kind: "items_receipt", turnId: first.operationId, itemIds: [steered.id], milestone: "delivered" },
      { kind: "items_receipt", turnId: first.operationId, itemIds: [steered.id], milestone: "seen" },
    ]);
    expect(aliceEvents.filter(event => event.kind === "turn_completed")).toHaveLength(1);
    expect(bobEvents.filter(event => event.kind === "items_receipt")).toEqual([]);
    expect((alice.connection as NativeController).receiptOf(steered.id)).toBe("seen");
  } finally {
    rig.release("receipts");
    await rig.clean();
  }
}, 30_000);
