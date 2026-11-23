import type { DeleteConversationResult } from "../agent/config.ts";
import type { WorkerSummary } from "./contracts.ts";
import type { Orchestrator } from "./orchestrator.ts";

export interface WorkerConsumerApi {
  list(): Promise<readonly WorkerSummary[]>;
  check(handle: string): Promise<WorkerSummary>;
  stop(handle: string): Promise<void>;
  /** Removes the worker locally and reports the provider cleanup outcome. */
  delete(handle: string): Promise<DeleteConversationResult>;
}

export function workerConsumerApi(orchestrator: Orchestrator): WorkerConsumerApi {
  const consumer = { kind: "consumer" } as const;
  return Object.freeze({
    list: () => orchestrator.list(consumer),
    check: (handle: string) => orchestrator.check(consumer, handle),
    async stop(handle: string) { await orchestrator.stop(consumer, handle); },
    delete: (handle: string) => orchestrator.drop(consumer, handle),
  });
}
