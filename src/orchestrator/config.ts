import type { DelegationPolicy } from "./contracts.ts";
import type { PermissionSettings } from "../permissions/matcher.ts";
import { PersistenceCapabilityError } from "../persistence/backend.ts";
import type { PersistenceBackend, RecordCaptureLevel } from "../persistence/backend.ts";

export interface OrchestratorConfig {
  /** Each entry corresponds to a configured native harness policy name. */
  readonly policies?: Readonly<Record<string, {
    readonly delegation: DelegationPolicy;
    readonly workerPermissions?: PermissionSettings;
  }>>;
  /** Forwarded requests retain owner options only when every contributing name is listed here. */
  readonly ownerPolicies?: readonly string[];
  readonly defaults?: {
    readonly delegation?: DelegationPolicy;
    /** Worker policy for consumer work and callbacks with no contributing policies. */
    readonly workerPermissions?: PermissionSettings;
  };
  readonly workers: {
    readonly adapterId?: string;
    readonly cwd?: string;
    readonly limit: number;
    /** Time idle before stopping the provider process. Defaults to ten minutes. */
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
  const idle = config.workers.idleStopMs;
  if (idle !== undefined && idle !== false && (!Number.isInteger(idle) || idle < 0 || idle > 2_147_483_647)) {
    throw new RangeError("orchestrator worker idleStopMs must be a non-negative timer delay or false");
  }
}
