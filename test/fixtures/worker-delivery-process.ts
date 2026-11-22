import { Agent } from "../../src/index.ts";

const [path, mode, assignmentId] = process.argv.slice(2) as [string, string, string];
const recovering = mode === "recover";
const writeBarrier = (value: object) => console.log(JSON.stringify(value));
const agent = await Agent.open({
  persistence: { kind: "sqlite", path },
  adapters: { worker: { command: recovering ? ["no-provider-dispatch-permitted"] :
    [process.execPath, new URL("./worker-delivery-peer.ts", import.meta.url).pathname, path, mode] } },
  defaultAdapterId: "worker",
  capture: { message: "content" },
  checkpointing: { enabled: false },
});
const repository = agent.persistence.workerDelivery!;
if (recovering) {
  try {
    writeBarrier({ binding: await repository.readBinding(assignmentId), staged: await repository.stage(assignmentId) });
  } finally { await agent.close(); }
} else {
  const worker = await agent.conversations.create({ title: "Worker" });
  const prompt = {
    text: "assignment result",
    async beforeDispatch(messageId: string) {
      const reservation = await repository.reserve({
        assignmentId, workerConversationId: worker.id, messageId, destination: "owner-channel",
        originatingPolicyNames: ["guest"], contributingPolicyNames: [],
      });
      if (reservation !== "reserved") throw new Error(`Assignment reservation returned ${reservation}`);
    },
    ...(mode === "partial" ? { handlers: { onResponseChunk() { writeBarrier({ partial: true }); } } } : mode === "interrupt" ? { handlers: { onResponseChunk() { worker.interrupt(); } } } : {}),
  };
  if (mode === "fail") {
    try {
      await worker.prompt(prompt);
      throw new Error("Expected ACP worker failure");
    } catch (error) {
      const staged = await repository.readStaged(assignmentId);
      if (staged?.outcome.kind !== "failed") throw error;
      writeBarrier({ staged, repeated: await repository.stage(assignmentId) });
    } finally { await agent.close(); }
    process.exit(0);
  }
  await worker.prompt(prompt);
  if (mode === "interrupt") {
    writeBarrier({ staged: await repository.readStaged(assignmentId), repeated: await repository.stage(assignmentId) });
    await agent.close();
    process.exit(0);
  }
  writeBarrier({ finalized: true });
  setInterval(() => {}, 1000);
}
