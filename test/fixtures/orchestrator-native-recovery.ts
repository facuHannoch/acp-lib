import { join } from "node:path";
import { Agent, createAgentConversationId } from "../../src/index.ts";
import type { ConversationPermissionEvent } from "../../src/permissions/conversation.ts";
import { actor, assignmentId, config, peer, waitFor } from "../orchestrator/delivery-support.ts";

const [directory, mode] = process.argv.slice(2) as [string, "final" | "partial" | "staged"];
const path = join(directory, "agent.sqlite");
const target = createAgentConversationId();
const workerCommand = mode === "partial"
  ? [process.execPath, new URL("./lifecycle-agent.ts", import.meta.url).pathname]
  : peer(path, "final", target);
const options = config(path, workerCommand);
const agent = await Agent.open({
  ...options,
  adapters: { ...options.adapters, main: { kind: "native" } },
  defaultAdapterId: "main",
  harness: { home: join(directory, "harness-home"), config: { version: 1, system: "Native integration test",
    model: { protocol: "scripted", script: join(directory, "script.jsonl") },
    defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} }, guest: { fallback: "allow", tools: {} } },
  } },
});
await agent.persistence.conversations.create({ agentSessionId: agent.id, agentConversationId: target,
  controllerKind: "native", title: "Destination" });
await agent.nativeHarness!.changeChannel(target, { displayName: "Destination" });
const { conversation } = await agent.conversations.open(target, { runtime: { answersPermissions: true } });
const idle = Promise.withResolvers<void>();
agent.events.subscribeWorkers(({ event }) => { if (event.kind === "worker_idle") idle.resolve(); });
const request = Promise.withResolvers<Extract<ConversationPermissionEvent, { kind: "permission_requested" }>>();
conversation.subscribe(({ event }) => { if (event.kind === "permission_requested") request.resolve(event); });

const result = await agent.orchestrator!.open({ ...actor(target), destinationKind: "native",
  workerPermissions: [{ default: "ask" }] }, { text: mode === "partial" ? "[lifecycle:permission]" : "assignment result" });
if (result.status !== "sent") throw new Error("The worker prompt was not queued");
let permissionId: string | undefined;
if (mode === "partial") permissionId = (await waitFor(request.promise, "pending forwarded permission")).id;
else await waitFor(idle.promise, "committed final worker record");
if (mode === "staged") await agent.persistence.workerDelivery!.stage(assignmentId);
if (agent.nativeHarness!.launches !== 0) throw new Error("The producer started the harness before the crash");
console.log(JSON.stringify({ target, permissionId }));
setTimeout(() => { throw new Error("Native recovery fixture was not killed at the barrier"); }, 15_000);
