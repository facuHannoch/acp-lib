import { resolve } from "node:path";
import {
  resolveConversationRecordCapture,
  type ProtocolRecordCapture,
  type ResolvedProtocolRecordCapturePolicy,
  type RecordCaptureLevel,
} from "../persistence/backend.ts";
import { DEFAULT_PERSISTENCE_LIMITS } from "../persistence/config.ts";
import { sha256CanonicalJson } from "../persistence/integrity.ts";

export interface AgentAuditCaptureConfig {
  readonly message?: RecordCaptureLevel;
  readonly tool_call?: "none" | "metadata" | "input" | "content" | "raw";
  readonly permission?: "none" | "metadata" | "decision" | "content" | "raw";
  readonly configuration?:
    | "none" | "metadata" | "selections" | "definitions" | "content" | "raw";
  readonly protocol?: ProtocolRecordCapture;
  readonly native_action?: RecordCaptureLevel;
  readonly agent_action?: RecordCaptureLevel;
  readonly thinking?: RecordCaptureLevel;
  readonly activity?: RecordCaptureLevel;
  readonly metering?: "none" | "metadata" | "summary" | "raw";
  readonly agent_lifecycle?: RecordCaptureLevel;
  readonly identity?: RecordCaptureLevel;
  readonly internal_inference?: RecordCaptureLevel;
}

export interface AuditRotationConfig {
  readonly maxBytes?: number | false;
  readonly maxAgeMs?: number | false;
}

export interface AuditRetryConfig {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface AgentAuditLogConfig {
  readonly directory: string;
  readonly filePrefix?: string;
  readonly capture?: AgentAuditCaptureConfig;
  readonly rotation?: AuditRotationConfig;
  readonly retry?: AuditRetryConfig;
  readonly shutdownGraceMs?: number;
}

export interface ResolvedAgentAuditCapturePolicy {
  readonly message: RecordCaptureLevel;
  readonly tool_call: "none" | "metadata" | "input" | "content" | "raw";
  readonly permission: "none" | "metadata" | "decision" | "content" | "raw";
  readonly configuration: "none" | "metadata" | "selections" | "definitions" | "content" | "raw";
  readonly protocol: ResolvedProtocolRecordCapturePolicy;
  readonly native_action: RecordCaptureLevel;
  readonly agent_action: RecordCaptureLevel;
  readonly thinking: RecordCaptureLevel;
  readonly activity: RecordCaptureLevel;
  readonly metering: "none" | "metadata" | "summary" | "raw";
  readonly agent_lifecycle: RecordCaptureLevel;
  readonly identity: RecordCaptureLevel;
  readonly internal_inference: RecordCaptureLevel;
}

export interface ResolvedAgentAuditLogConfig {
  readonly directory: string;
  readonly filePrefix: string;
  readonly capture: ResolvedAgentAuditCapturePolicy;
  readonly captureFingerprint: string;
  readonly rotation: { readonly maxBytes: number | false; readonly maxAgeMs: number | false };
  readonly retry: { readonly initialDelayMs: number; readonly maxDelayMs: number };
  readonly shutdownGraceMs: number;
}

export const DEFAULT_AGENT_AUDIT_CAPTURE: ResolvedAgentAuditCapturePolicy = Object.freeze({
  message: "none",
  tool_call: "metadata",
  permission: "decision",
  configuration: "selections",
  protocol: Object.freeze({ level: "none", includeMethods: Object.freeze([]), excludeMethods: Object.freeze([]) }),
  native_action: "metadata",
  agent_action: "metadata",
  thinking: "none",
  activity: "metadata",
  metering: "summary",
  agent_lifecycle: "metadata",
  identity: "metadata",
  internal_inference: "metadata",
});

export const DEFAULT_AUDIT_ROTATION = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxAgeMs: 24 * 60 * 60 * 1_000,
});
export const DEFAULT_AUDIT_RETRY = Object.freeze({ initialDelayMs: 1_000, maxDelayMs: 5 * 60 * 1_000 });
export const DEFAULT_AUDIT_SHUTDOWN_GRACE_MS = 2_000;

const CAPTURE_KEYS = new Set(Object.keys(DEFAULT_AGENT_AUDIT_CAPTURE));
const GENERAL_LEVELS = ["none", "metadata", "content", "raw"] as const;

export function resolveAgentAuditLogConfig(
  config: AgentAuditLogConfig,
  cwd = process.cwd(),
): ResolvedAgentAuditLogConfig {
  if (!config.directory.trim()) throw new Error("audit log directory cannot be blank");
  const filePrefix = config.filePrefix ?? "audit";
  if (
    filePrefix === "." || filePrefix === ".."
    || !/^[A-Za-z0-9._-]+$/.test(filePrefix)
    || Buffer.byteLength(filePrefix, "utf8") > 128
  ) throw new Error("audit log filePrefix must be a safe filename component of at most 128 bytes");

  const capture = resolveAgentAuditCapture(config.capture);
  const maxBytes = resolveOptionalPositive(config.rotation?.maxBytes, DEFAULT_AUDIT_ROTATION.maxBytes, "maxBytes");
  const maxAgeMs = resolveOptionalPositive(config.rotation?.maxAgeMs, DEFAULT_AUDIT_ROTATION.maxAgeMs, "maxAgeMs");
  if (maxBytes === false && maxAgeMs === false) {
    throw new Error("audit rotation requires at least one enabled trigger");
  }
  const initialDelayMs = safeInteger(config.retry?.initialDelayMs ?? DEFAULT_AUDIT_RETRY.initialDelayMs, 1, "initialDelayMs");
  const maxDelayMs = safeInteger(config.retry?.maxDelayMs ?? DEFAULT_AUDIT_RETRY.maxDelayMs, initialDelayMs, "maxDelayMs");
  const shutdownGraceMs = safeInteger(
    config.shutdownGraceMs ?? DEFAULT_AUDIT_SHUTDOWN_GRACE_MS,
    0,
    "shutdownGraceMs",
  );
  const captureFingerprint = sha256CanonicalJson({
    projectionSchemaVersion: 1,
    capture,
    limits: DEFAULT_PERSISTENCE_LIMITS,
  });
  return Object.freeze({
    directory: resolve(cwd, config.directory),
    filePrefix,
    capture,
    captureFingerprint,
    rotation: Object.freeze({ maxBytes, maxAgeMs }),
    retry: Object.freeze({ initialDelayMs, maxDelayMs }),
    shutdownGraceMs,
  });
}

export function resolveAgentAuditCapture(
  config: AgentAuditCaptureConfig = {},
): ResolvedAgentAuditCapturePolicy {
  for (const key of Object.keys(config)) {
    if (!CAPTURE_KEYS.has(key)) throw new Error(`unknown audit capture kind: ${key}`);
  }
  const general = (key: keyof AgentAuditCaptureConfig) => {
    const value = config[key] ?? DEFAULT_AGENT_AUDIT_CAPTURE[key];
    if (!GENERAL_LEVELS.includes(value as typeof GENERAL_LEVELS[number])) {
      throw new Error(`invalid audit capture level for ${key}: ${String(value)}`);
    }
    return value as RecordCaptureLevel;
  };
  const specialized = <T extends string>(key: keyof AgentAuditCaptureConfig, allowed: readonly T[]): T => {
    const value = config[key] ?? DEFAULT_AGENT_AUDIT_CAPTURE[key];
    if (!allowed.includes(value as T)) throw new Error(`invalid audit capture level for ${key}: ${String(value)}`);
    return value as T;
  };
  const protocol = resolveConversationRecordCapture({ protocol: config.protocol ?? "none" }).protocol;
  return Object.freeze({
    message: general("message"),
    tool_call: specialized("tool_call", ["none", "metadata", "input", "content", "raw"]),
    permission: specialized("permission", ["none", "metadata", "decision", "content", "raw"]),
    configuration: specialized("configuration", ["none", "metadata", "selections", "definitions", "content", "raw"]),
    protocol,
    native_action: general("native_action"),
    agent_action: general("agent_action"),
    thinking: general("thinking"),
    activity: general("activity"),
    metering: specialized("metering", ["none", "metadata", "summary", "raw"]),
    agent_lifecycle: general("agent_lifecycle"),
    identity: general("identity"),
    internal_inference: general("internal_inference"),
  });
}

function resolveOptionalPositive(value: number | false | undefined, fallback: number, label: string): number | false {
  if (value === false) return false;
  return safeInteger(value ?? fallback, 1, label);
}

function safeInteger(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`audit ${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}
