import { Agent, createAgentConversationId } from "../../src/index.ts";
import { actor, assignmentId, config, peer } from "../orchestrator/delivery-support.ts";

const [path, boundary] = process.argv.slice(2) as [string, "final" | "append"];
const target = createAgentConversationId();
const agent = await Agent.open(config(path, peer(path, "final", target)));
await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: target, controllerKind: "acp" });
const repo = agent.persistence.workerDelivery!;
const hold = async (): Promise<never> => {
  console.log(JSON.stringify({ target, boundary }));
  return new Promise(() => setInterval(() => {}, 1000));
};
const stage = repo.stage.bind(repo), transition = repo.transitionDelivery.bind(repo);
if (boundary === "final") repo.stage = async id => id === assignmentId ? hold() : stage(id);
else repo.transitionDelivery = async (id, change) => id === `worker-result:${assignmentId}` ? hold() : transition(id, change);

const result = await agent.orchestrator!.open(actor(target), { text: "assignment result" });
if (result.status !== "sent") throw new Error("Worker prompt was not queued");
setTimeout(() => { throw new Error("Orchestrator delivery crash barrier was not reached"); }, 15_000);
