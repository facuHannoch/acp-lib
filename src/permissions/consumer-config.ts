export interface PermissionConsumerConfig {
  /** Wait for answerPermission on asks that have no prompt handler. Defaults to false. */
  readonly answersPermissions?: boolean;
  /** Time from request ingress for a consumer to answer. Defaults to five minutes. */
  readonly permissionTimeoutMs?: number;
}

export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

export function validatePermissionConsumerConfig(config: PermissionConsumerConfig | undefined): void {
  const answers = config?.answersPermissions;
  if (answers !== undefined && typeof answers !== "boolean") {
    throw new TypeError("answersPermissions must be a boolean");
  }
  const timeout = config?.permissionTimeoutMs;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout >= 600_000)) {
    throw new RangeError("permissionTimeoutMs must be a positive integer below 600000");
  }
}
