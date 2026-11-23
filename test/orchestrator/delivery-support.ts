import type { AgentConfig } from "../../src/agent/config.ts";
import type { AgentConversationId } from "../../src/agent-ids.ts";
import type { WorkerConversationActor } from "../../src/orchestrator/contracts.ts";

const echoPeer = new URL("../fixtures/echo-prompt-agent.ts", import.meta.url).pathname;
const workerPeer = new URL("../fixtures/worker-delivery-peer.ts", import.meta.url).pathname;

export const assignmentId = "assignment-42";

export function actor(conversationId: AgentConversationId, invocationId = assignmentId, policyNames = ["guest"]): WorkerConversationActor {
  return {
    kind: "conversation", conversationId, invocationId, sender: "sender", policyNames, workerPermissions: [],
    policy: { use: true, scope: "all", redirect: true },
  };
}

export function config(path: string, workerCommand: string[] = ["no-work-dispatched"]): AgentConfig {
  return {
    persistence: { kind: "sqlite", path },
    adapters: { giver: { command: [process.execPath, echoPeer] }, worker: { command: workerCommand } },
    defaultAdapterId: "giver",
    capture: { message: "content" }, checkpointing: { enabled: false },
    orchestrator: { workers: { adapterId: "worker", limit: 1, idleStopMs: false } },
  };
}

export function peer(path: string, mode: string, target: AgentConversationId): string[] {
  return [process.execPath, workerPeer, path, mode, assignmentId, target];
}

export async function waitFor<T>(promise: Promise<T>, what: string, limit = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), limit);
    })]);
  } finally { clearTimeout(timer); }
}
