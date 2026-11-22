import type { WorkerSummary } from "./contracts.ts";
import type { Orchestrator } from "./orchestrator.ts";

export interface WorkerConsumerApi {
  list(): Promise<readonly WorkerSummary[]>;
  check(handle: string): Promise<WorkerSummary>;
  stop(handle: string): Promise<void>;
  delete(handle: string): Promise<void>;
}

export function workerConsumerApi(orchestrator: Orchestrator): WorkerConsumerApi {
  const consumer = { kind: "consumer" } as const;
  return Object.freeze({
    list: () => orchestrator.list(consumer),
    check: (handle: string) => orchestrator.check(consumer, handle),
    stop: (handle: string) => orchestrator.stop(consumer, handle),
    delete: (handle: string) => orchestrator.drop(consumer, handle),
  });
}
