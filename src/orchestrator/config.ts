import { PersistenceCapabilityError } from "../persistence/backend.ts";
import type { PersistenceBackend, RecordCaptureLevel } from "../persistence/backend.ts";

export interface OrchestratorConfig {
  readonly workers: {
    readonly adapterId?: string;
    readonly cwd?: string;
    readonly limit: number;
    readonly idleStopMs?: number | false;
  };
}

export function validateOrchestrator(
  config: OrchestratorConfig, persistence: PersistenceBackend, messageCapture: RecordCaptureLevel,
): void {
  if (!persistence.capabilities.workers || !persistence.workers) throw new PersistenceCapabilityError("workers");
  if (!persistence.capabilities.workerDelivery || !persistence.workerDelivery) throw new PersistenceCapabilityError("workerDelivery");
  if (messageCapture !== "content") throw new Error('orchestrator requires message capture "content"');
  if (!Number.isSafeInteger(config.workers.limit) || config.workers.limit < 1) {
    throw new RangeError("orchestrator worker limit must be a positive integer");
  }
}
