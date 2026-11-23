import { expect, test } from "bun:test";
import { hold, nativeRig } from "./support.ts";

test("stopping a running native turn returns its cancelled partial text", async () => {
  const rig = await nativeRig();
  try {
    rig.script([hold("partial-stop", "Partial reply.")]);
    const agent = await rig.open();
    const conversation = await agent.conversations.create();
    const entered = Promise.withResolvers<void>();
    const running = conversation.prompt("start", { onActivity(event) {
      if (event.kind === "tool" && event.toolCallId === "hold-partial-stop") entered.resolve();
    } });
    void running.catch(entered.reject);
    await entered.promise;
    await conversation.stop();
    expect(await running).toMatchObject({ status: "cancelled", text: "Partial reply." });
  } finally {
    rig.release("partial-stop");
    await rig.clean();
  }
}, 30_000);

test("stopping before native submission keeps local cancellation", async () => {
  const rig = await nativeRig();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const agent = await rig.open();
    const conversation = await agent.conversations.create();
    const pending = conversation.prompt({
      text: "local only",
      async beforeDispatch() {
        entered.resolve();
        await release.promise;
      },
    });
    void pending.catch(entered.reject);
    await entered.promise;
    await conversation.stop();
    expect(await pending).toMatchObject({ status: "cancelled", text: "" });
    expect(agent.nativeHarness?.launches).toBe(0);
  } finally {
    release.resolve();
    await rig.clean();
  }
}, 30_000);
