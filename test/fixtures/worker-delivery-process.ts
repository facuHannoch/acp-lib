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
    async beforeDispatch(operationId: string) {
      const reservation = await repository.reserve({
        assignmentId, workerConversationId: worker.id, operationId, destination: "owner-channel",
        originatingPolicyNames: ["guest"], contributingPolicyNames: [],
      });
      if (reservation !== "reserved") throw new Error(`Assignment reservation returned ${reservation}`);
    },
    ...(mode === "partial" ? { handlers: { onResponseChunk() { writeBarrier({ partial: true }); } } } : {}),
  };
  await worker.prompt(prompt);
  writeBarrier({ finalized: true });
  setInterval(() => {}, 1000);
}
