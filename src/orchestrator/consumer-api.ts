import type { WorkerSummary } from "./contracts.ts";
import type { Orchestrator } from "./orchestrator.ts";

export interface WorkerConsumerApi {
  list(): Promise<readonly WorkerSummary[]>;
  check(handle: string): Promise<WorkerSummary>;
  stop(handle: string): Promise<void>;
  delete(handle: string): Promise<void>;
}

export function workerConsumerApi(orchestrator: Orchestrator): WorkerConsumerApi {
  return Object.freeze({
    list: () => orchestrator.list(),
    check: (handle: string) => orchestrator.check(handle),
    stop: (handle: string) => orchestrator.stop(handle),
    delete: (handle: string) => orchestrator.drop(handle),
  });
}
