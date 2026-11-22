import { Agent } from "../../src/index.ts";
import { join } from "node:path";

const [mode, directory, key] = process.argv.slice(2) as [string, string, string?];
const provenance = { assignmentId: "assignment-42", destination: "owner-channel", policyNames: ["guest"] };
const producing = mode === "produce" || mode === "partial";
const agent = await Agent.open({
  persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
  adapters: { worker: { command: producing ? ["bun", new URL(mode === "partial" ? "./stalling-prompt-agent.ts" : "./echo-prompt-agent.ts", import.meta.url).pathname] : ["no-provider-dispatch-permitted"] } },
  defaultAdapterId: "worker",
  capture: { message: "content" },
  checkpointing: { enabled: false },
});

if (producing) {
  const worker = await agent.conversations.create({ title: "Worker" });
  await worker.prompt({ text: "assignment result", consumerMetadata: provenance,
    ...(mode === "partial" ? { handlers: { onResponseChunk() { console.log(JSON.stringify({ partialWorkerOutputSeen: true })); } } } : {}) });
  // No assignment result or notice is saved by this producer. Stop before
  // any graceful close so the supervising test can kill the real process.
  console.log(JSON.stringify({ finalWorkerRecordCommitted: true }));
  setInterval(() => {}, 1000);
} else {
  try {
    const workers = (await agent.persistence.conversations.list()).conversations;
    const matches = [];
    for (const worker of workers) {
      const { records } = await agent.persistence.records.list(worker.agentConversationId, { limit: 100 });
      for (const record of records) {
        if (record.kind !== "message" || record.role !== "user" || !record.operationId) continue;
        const metadata = record.consumerMetadata as typeof provenance | undefined;
        if (metadata?.assignmentId !== key) continue;
        const operation = await agent.persistence.metering.get(worker.agentConversationId, record.operationId);
        const output = records.filter(value => value.kind === "message" && value.role === "assistant" &&
          value.status === "completed" && value.operationId === record.operationId);
        matches.push({ provenance: metadata, operationId: record.operationId, outcome: operation?.outcome,
          output: output.map(reply => ({ id: reply.recordId, content: "content" in reply ? reply.content : undefined })),
          recordKinds: records.map(value => value.kind) });
      }
    }
    console.log(JSON.stringify(matches));
  } finally { await agent.close(); }
}
