import type { DelegationPolicy } from "./contracts.ts";
import type { PermissionSettings } from "../permissions/matcher.ts";
import { PersistenceCapabilityError } from "../persistence/backend.ts";
import type { PersistenceBackend, RecordCaptureLevel } from "../persistence/backend.ts";

const defaultDelegationToolNames = { delegate: "delegate", check: "check", list: "list", stop: "stop" } as const;
type DelegationToolNames = Readonly<Record<keyof typeof defaultDelegationToolNames, string>>;
export type WorkerApprovalMode = "consumer" | "model" | "both";

export interface OrchestratorConfig {
  /** Model-facing names for ACP-client's native worker tools. Unspecified names keep their defaults. */
  readonly toolNames?: Partial<DelegationToolNames & { answer: string }>;
  readonly workerApprovals?: WorkerApprovalMode;
  /** Each entry corresponds to a configured native harness policy name. */
  readonly policies?: Readonly<Record<string, {
    readonly delegation: DelegationPolicy;
    readonly workerPermissions?: PermissionSettings;
    /** Scope of model answers and the read paths safe to include in shared notices. */
    readonly modelApproval?: {
      readonly rules: NonNullable<PermissionSettings["rules"]>;
      readonly shareReadPaths?: readonly string[];
    };
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

export function resolveDelegationToolNames(input: OrchestratorConfig["toolNames"], mode: WorkerApprovalMode = "consumer"): DelegationToolNames & { answer?: string } {
  if (input === undefined) return mode === "consumer" ? defaultDelegationToolNames : { ...defaultDelegationToolNames, answer: "worker_answer" };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("orchestrator.toolNames must be a map of worker operations to tool names");
  }
  const names: Record<keyof DelegationToolNames, string> & { answer?: string } = { ...defaultDelegationToolNames };
  if (mode !== "consumer") names.answer = "worker_answer";
  for (const [operation, name] of Object.entries(input)) {
    if (operation !== "answer" && !Object.hasOwn(defaultDelegationToolNames, operation)) {
      throw new Error(`unknown orchestrator tool operation: ${operation}`);
    }
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new Error(`invalid orchestrator tool name for ${operation}`);
    }
    if (operation !== "answer" || mode !== "consumer") names[operation as keyof DelegationToolNames | "answer"] = name;
  }
  const resolved = Object.values(names);
  if (new Set(resolved).size !== resolved.length) throw new Error("orchestrator tool names must be distinct");
  return names;
}

export function validateOrchestrator(
  config: OrchestratorConfig, persistence: PersistenceBackend, messageCapture: RecordCaptureLevel,
): void {
  if (config.workerApprovals !== undefined && !["consumer", "model", "both"].includes(config.workerApprovals)) {
    throw new Error("invalid orchestrator.workerApprovals mode");
  }
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
