import { ForcedStopError, OperationStalledError } from "../operations/errors.ts";
import type { PromptEndedBy } from "../steering/contracts.ts";
import type { WorkerAssignmentFailure } from "./worker-delivery-contract.ts";

const reasons = {
  failed: ["worker failed", "worker stalled", "worker produced no saved result"],
  interrupted: ["worker interrupted", "worker forcibly stopped", "worker interrupted by request", "worker interrupted by steering"],
} as const;

export function normalizeWorkerFailure(failure: WorkerAssignmentFailure): WorkerAssignmentFailure {
  const allowed: readonly string[] = reasons[failure.kind];
  return { ...failure, reason: allowed.includes(failure.reason) ? failure.reason : allowed[0]! };
}

export function workerTerminalFailure(cancelled: boolean, error?: unknown, endedBy?: PromptEndedBy): WorkerAssignmentFailure {
  const forced = error instanceof ForcedStopError;
  return {
    kind: cancelled || forced ? "interrupted" : "failed",
    reason: forced ? reasons.interrupted[1] : cancelled
      ? endedBy === "interrupt" ? reasons.interrupted[2] : endedBy === "steer" ? reasons.interrupted[3] : reasons.interrupted[0]
      : error instanceof OperationStalledError ? reasons.failed[1] : reasons.failed[0],
    possiblePartialEffects: true,
  };
}
