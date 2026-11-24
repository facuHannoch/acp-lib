import { validatePermissionConsumerConfig, type PermissionConsumerConfig } from "./consumer-config.ts";
import type { PermissionRequest, PromptHandlers } from "../types.ts";
import { matchPermissionLevel, type PermissionLevel, type PermissionSettings } from "./matcher.ts";
import { selectPermissionOutcome, unansweredPermissionOutcome } from "./outcome.ts";

export interface PermissionPolicyConfig {
  /** The whole setting replaces any inherited setting. Defaults to ask. */
  readonly permissions?: PermissionSettings;
  /** ACP and native requests. Native supplies tool.name and the original arguments as string tool.rawInput. */
  readonly permissionRule?: (request: PermissionRequest) => PermissionLevel | undefined;
}

export interface ConversationPermissionConfig extends PermissionPolicyConfig, PermissionConsumerConfig {}

export function validateConversationPermissionConfig(config: ConversationPermissionConfig | undefined): void {
  ownPermissions(config?.permissions);
  validatePermissionConsumerConfig(config);
}

/** Apply policy settings from broadest to most specific without merging the rule maps. */
export function inheritPermissionConfig(
  ...configs: readonly (ConversationPermissionConfig | undefined)[]
): ConversationPermissionConfig {
  let permissions: PermissionSettings | undefined;
  let permissionRule: PermissionPolicyConfig["permissionRule"];
  let answersPermissions: boolean | undefined;
  let permissionTimeoutMs: number | undefined;
  for (const config of configs) {
    permissions = config?.permissions ?? permissions;
    permissionRule = config?.permissionRule ?? permissionRule;
    answersPermissions = config?.answersPermissions ?? answersPermissions;
    permissionTimeoutMs = config?.permissionTimeoutMs ?? permissionTimeoutMs;
  }
  return { permissions, permissionRule, answersPermissions, permissionTimeoutMs };
}

const DEFAULT_PERMISSIONS: PermissionSettings = Object.freeze({ default: "ask" });
const kinds = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);

function isLevel(value: unknown): value is PermissionLevel {
  return value === "deny" || value === "ask" || value === "allow";
}

/** Validate and own the configuration before it can be used for a request. */
export function ownPermissions(settings: PermissionSettings | undefined): PermissionSettings | undefined {
  if (settings === undefined) return undefined;
  if (settings === null || typeof settings !== "object" || !isLevel(settings.default)) {
    throw new Error("permissions.default must be deny, ask, or allow");
  }
  const { rules, unanswered } = settings;
  if (unanswered !== undefined && unanswered !== "reject" && unanswered !== "cancel") {
    throw new Error("permissions.unanswered must be reject or cancel");
  }
  const base = { default: settings.default, ...(unanswered === undefined ? {} : { unanswered }) };
  if (rules === undefined) return Object.freeze(base);
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) throw new Error("permissions.rules must be an object");
  for (const [key, level] of Object.entries(rules)) {
    const command = key.startsWith("command:") ? key.slice(8) : "";
    const valid = key.startsWith("kind:") && kinds.has(key.slice(5))
      || command.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(command);
    if (!valid) throw new Error(`invalid permission rule key: ${key}`);
    if (!isLevel(level)) throw new Error(`invalid permission level for ${key}: ${String(level)}`);
  }
  return Object.freeze({ ...base, rules: Object.freeze({ ...rules }) });
}

export function permissionLevel(request: PermissionRequest, config: PermissionPolicyConfig, native = false): PermissionLevel {
  const override = config.permissionRule?.(request);
  if (override !== undefined && !isLevel(override)) throw new Error("permissionRule must return deny, ask, allow, or undefined");
  const settings = config.permissions ?? DEFAULT_PERMISSIONS;
  return override ?? (native ? settings.default : matchPermissionLevel(request, settings));
}

/** Resolve an ACP request outside a conversation permission coordinator. */
export function answerPermissionLevel(
  level: PermissionLevel,
  request: PermissionRequest,
  handler: (() => ReturnType<NonNullable<PromptHandlers["onPermissionRequest"]>>) | undefined,
  unanswered: PermissionSettings["unanswered"],
) {
  if (level === "ask") return handler ? handler() : unansweredPermissionOutcome(request.options, unanswered);
  return selectPermissionOutcome(level, request.options)!;
}

/** A turn's recording handler already applies policy and must see every request for persistence. */
export const recordingPermissionHandlers = new WeakSet<NonNullable<PromptHandlers["onPermissionRequest"]>>();
