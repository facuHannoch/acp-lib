import { Agent } from "../../src/index.ts";

const [path, mode, assignmentId] = process.argv.slice(2) as [string, string, string];
const recovering = mode === "recover" || mode === "stage-and-hold";
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
if (mode === "steer-gap" || mode === "linked-gap" || mode === "replacement-rollback") {
  const binding = { assignmentId, workerConversationId: "worker", workerHandle: "label", messageId: "old-message",
    destination: { kind: "native" as const, id: "original" }, originatingPolicyNames: ["guest"], contributingPolicyNames: [] };
  await repository.reserve(binding);
  await repository.markSteered("worker", ["old-message"]);
  const hold = async () => {
    writeBarrier({ mode });
    await new Promise<void>(() => setInterval(() => {}, 1000));
  };
  if (mode === "replacement-rollback") {
    await agent.persistence.transaction(async scope => {
      const result = await scope.workerDelivery!.replaceAssignment(assignmentId, "old-message",
        { ...binding, assignmentId: "replacement", messageId: "new-message" });
      if (result.kind !== "replaced") throw new Error("Expected a fresh replacement inside the held transaction");
      await hold();
    });
  } else {
    if (mode === "linked-gap" && await repository.continueAssignment(assignmentId, "old-message", "new-message") !== "continued") {
      throw new Error("Expected durable successor");
    }
    await hold();
  }
} else if (recovering) {
  try {
    writeBarrier({ binding: await repository.readBinding(assignmentId), staged: await repository.stage(assignmentId) });
    if (mode === "stage-and-hold") await new Promise<void>(() => setInterval(() => {}, 1000));
  } finally { await agent.close(); }
} else {
  const worker = await agent.conversations.create({ title: "Worker" });
  const prompt = {
    text: "assignment result",
    async beforeDispatch(messageId: string) {
      const reservation = await repository.reserve({
        assignmentId, workerConversationId: worker.id, workerHandle: "worker-handle", messageId, destination: { kind: "native" as const, id: "owner-channel" },
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
