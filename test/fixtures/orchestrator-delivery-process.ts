import { Agent, createAgentConversationId } from "../../src/index.ts";
import { dirname, join } from "node:path";
import { actor, assignmentId, config, peer } from "../orchestrator/delivery-support.ts";

const [path, boundary] = process.argv.slice(2) as [string, "final" | "append" | "partial"];
const target = createAgentConversationId();
const worker = boundary === "partial"
  ? [process.execPath, new URL("./lifecycle-agent.ts", import.meta.url).pathname]
  : peer(path, "final", target);
const agent = await Agent.open({ ...config(path, worker), conversationDefaults: {
  env: { LIFECYCLE_TOOL_GATE_FILE: join(dirname(path), "held-tool") },
} });
await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: target, controllerKind: "acp" });
const repo = agent.persistence.workerDelivery!;
const hold = async (): Promise<never> => {
  console.log(JSON.stringify({ target, boundary }));
  return new Promise(() => setInterval(() => {}, 1000));
};
const stage = repo.stage.bind(repo), transition = repo.transitionDelivery.bind(repo);
if (boundary === "final") repo.stage = async id => id === assignmentId ? hold() : stage(id);
if (boundary === "append") repo.transitionDelivery = async (id, change) => id === `worker-result:${assignmentId}` ? hold() : transition(id, change);
const tool = Promise.withResolvers<void>();
if (boundary === "partial") agent.events.subscribe(({ event }) => {
  if (event.record.kind === "tool_call" && event.record.state === "announced") tool.resolve();
});

const result = await agent.orchestrator!.open(actor(target), { text: boundary === "partial" ? "[lifecycle:tool]" : "assignment result" });
if (result.status !== "sent") throw new Error("Worker prompt was not queued");
setTimeout(() => { throw new Error("Orchestrator delivery crash barrier was not reached"); }, 15_000);
if (boundary === "partial") {
  await tool.promise;
  await hold();
}
