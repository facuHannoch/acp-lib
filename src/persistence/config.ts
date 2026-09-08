import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type TranscriptPreset = "conversation" | "activity" | "detailed" | "diagnostic";

export interface TranscriptCapturePolicy {
  messages: "none" | "text";
  reasoning: "none" | "text";
  tools: "none" | "metadata" | "input" | "content";
  lifecycle: boolean;
  transitions: "none" | "metadata" | "content";
  permissions: "none" | "decision" | "full";
  usage: boolean;
  configuration: "none" | "selections" | "definitions";
  protocol: "none" | "metadata" | "raw";
}

export interface AuditLogCapturePolicy {
  reasoning: TranscriptCapturePolicy["reasoning"];
  tools: TranscriptCapturePolicy["tools"];
  lifecycle: boolean;
  transitions: "none" | "metadata";
  permissions: TranscriptCapturePolicy["permissions"];
  usage: boolean;
  configuration: TranscriptCapturePolicy["configuration"];
}

export interface TranscriptConfig {
  path?: string;
  preset?: TranscriptPreset;
  capture?: Partial<TranscriptCapturePolicy>;
  includeTruncationDigests?: boolean;
}

export interface AuditLogConfig {
  path?: string;
  capture?: Partial<AuditLogCapturePolicy>;
  includeTruncationDigests?: boolean;
}

export interface SessionConfigurationPersistenceConfig {
  values?: "none" | "typed" | "all";
  include?: readonly string[];
  exclude?: readonly string[];
}

export interface PersistenceLimits {
  maxRecordBytes: number;
  maxCapturedFieldBytes: number;
  maxJsonDepth: number;
  maxCursorBytes: number;
}

export interface AgentSessionPersistenceOptions {
  root?: string;
  transcript?: false | TranscriptConfig;
  auditLog?: false | AuditLogConfig;
  sessionConfiguration?: SessionConfigurationPersistenceConfig;
  limits?: Partial<PersistenceLimits>;
}

export type ManagedSessionPersistenceOptions = Omit<AgentSessionPersistenceOptions, "root">;

export interface SessionPersistenceConstraints {
  transcript?: "optional" | "required" | "forbidden";
  auditLog?: "optional" | "required" | "forbidden";
}

export interface ResolvedTranscriptConfig {
  readonly path?: string;
  readonly preset: TranscriptPreset;
  readonly capture: Readonly<TranscriptCapturePolicy>;
  readonly includeTruncationDigests: boolean;
}

export interface ResolvedAuditLogConfig {
  readonly path?: string;
  readonly capture: Readonly<AuditLogCapturePolicy>;
  readonly includeTruncationDigests: boolean;
}

export interface ResolvedSessionConfigurationPersistence {
  readonly values: "none" | "typed" | "all";
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface ResolvedAgentSessionPersistence {
  readonly root: string;
  readonly transcript: false | ResolvedTranscriptConfig;
  readonly auditLog: false | ResolvedAuditLogConfig;
  readonly sessionConfiguration: ResolvedSessionConfigurationPersistence;
  readonly limits: Readonly<PersistenceLimits>;
}

export class PersistenceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConfigurationError";
  }
}

export const DEFAULT_PERSISTENCE_LIMITS: Readonly<PersistenceLimits> = Object.freeze({
  maxRecordBytes: 1_048_576,
  maxCapturedFieldBytes: 262_144,
  maxJsonDepth: 64,
  maxCursorBytes: 4_096,
});

export const TRANSCRIPT_PRESETS: Readonly<Record<TranscriptPreset, Readonly<TranscriptCapturePolicy>>> =
  Object.freeze({
    conversation: Object.freeze({
      messages: "text",
      reasoning: "none",
      tools: "none",
      lifecycle: false,
      transitions: "metadata",
      permissions: "none",
      usage: false,
      configuration: "none",
      protocol: "none",
    }),
    activity: Object.freeze({
      messages: "text",
      reasoning: "none",
      tools: "metadata",
      lifecycle: true,
      transitions: "metadata",
      permissions: "decision",
      usage: true,
      configuration: "selections",
      protocol: "none",
    }),
    detailed: Object.freeze({
      messages: "text",
      reasoning: "text",
      tools: "content",
      lifecycle: true,
      transitions: "content",
      permissions: "full",
      usage: true,
      configuration: "selections",
      protocol: "none",
    }),
    diagnostic: Object.freeze({
      messages: "text",
      reasoning: "text",
      tools: "content",
      lifecycle: true,
      transitions: "content",
      permissions: "full",
      usage: true,
      configuration: "definitions",
      protocol: "raw",
    }),
  });

export const DEFAULT_AUDIT_LOG_CAPTURE: Readonly<AuditLogCapturePolicy> = Object.freeze({
  reasoning: "none",
  tools: "input",
  lifecycle: true,
  transitions: "metadata",
  permissions: "decision",
  usage: true,
  configuration: "selections",
});

const DEFAULT_SESSION_CONFIGURATION: Readonly<ResolvedSessionConfigurationPersistence> =
  Object.freeze({ values: "typed", include: Object.freeze([]), exclude: Object.freeze([]) });

export interface PersistenceRootEnvironment {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly cwd?: string;
}

/** Resolve only the persistence root. Filesystem-dependent log-path resolution is separate. */
export function resolvePersistenceRoot(
  explicitRoot?: string,
  environment: PersistenceRootEnvironment = {},
): string {
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  const cwd = environment.cwd ?? process.cwd();
  const selected = explicitRoot ?? nonblank(env.ACP_CLIENT_HOME) ?? `${home}/.acp-client`;
  if (!selected.trim()) throw new PersistenceConfigurationError("persistence root cannot be blank");

  const expanded = selected === "~"
    ? home
    : selected.startsWith("~/")
      ? `${home}/${selected.slice(2)}`
      : selected;
  if (expanded.startsWith("~")) {
    throw new PersistenceConfigurationError("persistence root supports only ~ or ~/ expansion");
  }
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Direct sessions remain persistence-free unless this function receives an options object. */
export function resolveDirectPersistence(
  options: false | AgentSessionPersistenceOptions | undefined,
  environment: PersistenceRootEnvironment = {},
): false | ResolvedAgentSessionPersistence {
  if (options === false || options === undefined) return false;
  return resolveLayers(resolvePersistenceRoot(options.root, environment), [options]);
}

export function resolveManagedPersistence(
  root: string | undefined,
  managerDefaults?: ManagedSessionPersistenceOptions,
  sessionOptions?: ManagedSessionPersistenceOptions,
  constraints: SessionPersistenceConstraints = {},
  environment: PersistenceRootEnvironment = {},
): ResolvedAgentSessionPersistence {
  validateManagedLayer(managerDefaults, "sessionDefaults");
  validateManagedLayer(sessionOptions, "session persistence");
  const resolved = resolveLayers(
    resolvePersistenceRoot(root, environment),
    [managerDefaults, sessionOptions],
  );
  enforceConstraint("transcript", resolved.transcript !== false, constraints.transcript);
  enforceConstraint("audit log", resolved.auditLog !== false, constraints.auditLog);
  return resolved;
}

function validateManagedLayer(
  value: ManagedSessionPersistenceOptions | undefined,
  name: string,
): void {
  if (!value) return;
  assertKnownKeys(name, value, ["transcript", "auditLog", "sessionConfiguration", "limits"]);
}

function resolveLayers(
  root: string,
  layers: readonly (ManagedSessionPersistenceOptions | AgentSessionPersistenceOptions | undefined)[],
): ResolvedAgentSessionPersistence {
  let transcript: false | ResolvedTranscriptConfig = defaultTranscript();
  let auditLog: false | ResolvedAuditLogConfig = false;
  let sessionConfiguration = cloneSessionConfiguration(DEFAULT_SESSION_CONFIGURATION);
  let limits: PersistenceLimits = { ...DEFAULT_PERSISTENCE_LIMITS };

  for (const layer of layers) {
    if (!layer) continue;
    assertKnownKeys("persistence", layer, [
      "root",
      "transcript",
      "auditLog",
      "sessionConfiguration",
      "limits",
    ]);
    transcript = mergeTranscript(transcript, layer.transcript);
    auditLog = mergeAuditLog(auditLog, layer.auditLog);
    sessionConfiguration = mergeSessionConfiguration(
      sessionConfiguration,
      layer.sessionConfiguration,
    );
    if (layer.limits) {
      assertKnownKeys("limits", layer.limits, [
        "maxRecordBytes",
        "maxCapturedFieldBytes",
        "maxJsonDepth",
        "maxCursorBytes",
      ]);
      limits = { ...limits, ...layer.limits };
    }
  }

  validateLimits(limits);
  return Object.freeze({
    root,
    transcript: freezeTranscript(transcript),
    auditLog: freezeAuditLog(auditLog),
    sessionConfiguration: Object.freeze({
      ...sessionConfiguration,
      include: Object.freeze([...sessionConfiguration.include]),
      exclude: Object.freeze([...sessionConfiguration.exclude]),
    }),
    limits: Object.freeze(limits),
  });
}

function mergeTranscript(
  current: false | ResolvedTranscriptConfig,
  next: false | TranscriptConfig | undefined,
): false | ResolvedTranscriptConfig {
  if (next === undefined) return current;
  if (next === false) return false;
  assertKnownKeys("transcript", next, [
    "path",
    "preset",
    "capture",
    "includeTruncationDigests",
  ]);
  validateOptionalPath(next.path, "transcript.path");
  validateOptionalBoolean(next.includeTruncationDigests, "transcript.includeTruncationDigests");
  if (next.capture) {
    assertKnownKeys("transcript.capture", next.capture, [
      "messages",
      "reasoning",
      "tools",
      "lifecycle",
      "transitions",
      "permissions",
      "usage",
      "configuration",
      "protocol",
    ]);
  }

  const inherited = current === false ? defaultTranscript() : current;
  const preset = next.preset ?? inherited.preset;
  const captureBase = next.preset ? presetCapture(next.preset) : inherited.capture;
  const capture = { ...captureBase, ...next.capture };
  validateTranscriptCapture(capture);
  return {
    ...(next.path !== undefined
      ? { path: next.path }
      : inherited.path !== undefined
        ? { path: inherited.path }
        : {}),
    preset,
    capture,
    includeTruncationDigests:
      next.includeTruncationDigests ?? inherited.includeTruncationDigests,
  };
}

function mergeAuditLog(
  current: false | ResolvedAuditLogConfig,
  next: false | AuditLogConfig | undefined,
): false | ResolvedAuditLogConfig {
  if (next === undefined) return current;
  if (next === false) return false;
  assertKnownKeys("auditLog", next, ["path", "capture", "includeTruncationDigests"]);
  validateOptionalPath(next.path, "auditLog.path");
  validateOptionalBoolean(next.includeTruncationDigests, "auditLog.includeTruncationDigests");
  if (next.capture) {
    assertKnownKeys("auditLog.capture", next.capture, [
      "reasoning",
      "tools",
      "lifecycle",
      "transitions",
      "permissions",
      "usage",
      "configuration",
    ]);
  }

  const inherited = current === false ? defaultAuditLog() : current;
  const capture = { ...inherited.capture, ...next.capture };
  validateAuditCapture(capture);
  return {
    ...(next.path !== undefined
      ? { path: next.path }
      : inherited.path !== undefined
        ? { path: inherited.path }
        : {}),
    capture,
    includeTruncationDigests:
      next.includeTruncationDigests ?? inherited.includeTruncationDigests,
  };
}

function mergeSessionConfiguration(
  current: ResolvedSessionConfigurationPersistence,
  next: SessionConfigurationPersistenceConfig | undefined,
): ResolvedSessionConfigurationPersistence {
  if (!next) return current;
  assertKnownKeys("sessionConfiguration", next, ["values", "include", "exclude"]);
  if (next.values !== undefined && !["none", "typed", "all"].includes(next.values)) {
    throw new PersistenceConfigurationError("sessionConfiguration.values is invalid");
  }
  const include = next.include === undefined ? current.include : validateIds(next.include, "include");
  const exclude = next.exclude === undefined ? current.exclude : validateIds(next.exclude, "exclude");
  return { values: next.values ?? current.values, include, exclude };
}

function defaultTranscript(): ResolvedTranscriptConfig {
  return {
    preset: "activity",
    capture: { ...TRANSCRIPT_PRESETS.activity },
    includeTruncationDigests: false,
  };
}

function defaultAuditLog(): ResolvedAuditLogConfig {
  return {
    capture: { ...DEFAULT_AUDIT_LOG_CAPTURE },
    includeTruncationDigests: false,
  };
}

function presetCapture(preset: TranscriptPreset): TranscriptCapturePolicy {
  const capture = TRANSCRIPT_PRESETS[preset];
  if (!capture) throw new PersistenceConfigurationError(`unknown transcript preset: ${preset}`);
  return { ...capture };
}

function validateLimits(limits: PersistenceLimits): void {
  validateIntegerRange("maxRecordBytes", limits.maxRecordBytes, 4_096, 16_777_216);
  validateIntegerRange(
    "maxCapturedFieldBytes",
    limits.maxCapturedFieldBytes,
    1_024,
    limits.maxRecordBytes,
  );
  validateIntegerRange("maxJsonDepth", limits.maxJsonDepth, 1, 128);
  validateIntegerRange("maxCursorBytes", limits.maxCursorBytes, 256, 16_384);
}

function validateIntegerRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PersistenceConfigurationError(`${name} must be an integer from ${min} through ${max}`);
  }
}

function validateTranscriptCapture(value: TranscriptCapturePolicy): void {
  oneOf("capture.messages", value.messages, ["none", "text"]);
  oneOf("capture.reasoning", value.reasoning, ["none", "text"]);
  oneOf("capture.tools", value.tools, ["none", "metadata", "input", "content"]);
  bool("capture.lifecycle", value.lifecycle);
  oneOf("capture.transitions", value.transitions, ["none", "metadata", "content"]);
  oneOf("capture.permissions", value.permissions, ["none", "decision", "full"]);
  bool("capture.usage", value.usage);
  oneOf("capture.configuration", value.configuration, ["none", "selections", "definitions"]);
  oneOf("capture.protocol", value.protocol, ["none", "metadata", "raw"]);
}

function validateAuditCapture(value: AuditLogCapturePolicy): void {
  oneOf("auditLog.capture.reasoning", value.reasoning, ["none", "text"]);
  oneOf("auditLog.capture.tools", value.tools, ["none", "metadata", "input", "content"]);
  bool("auditLog.capture.lifecycle", value.lifecycle);
  oneOf("auditLog.capture.transitions", value.transitions, ["none", "metadata"]);
  oneOf("auditLog.capture.permissions", value.permissions, ["none", "decision", "full"]);
  bool("auditLog.capture.usage", value.usage);
  oneOf("auditLog.capture.configuration", value.configuration, ["none", "selections", "definitions"]);
}

function oneOf(name: string, value: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(value)) {
    throw new PersistenceConfigurationError(`${name} is invalid`);
  }
}

function bool(name: string, value: unknown): void {
  if (typeof value !== "boolean") throw new PersistenceConfigurationError(`${name} must be boolean`);
}

function validateOptionalPath(value: string | undefined, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new PersistenceConfigurationError(`${name} cannot be blank`);
  }
}

function validateOptionalBoolean(value: boolean | undefined, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new PersistenceConfigurationError(`${name} must be boolean`);
  }
}

function assertKnownKeys(
  name: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new PersistenceConfigurationError(`${name}.${unknown} is not supported`);
}

function validateIds(values: readonly string[], name: string): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new PersistenceConfigurationError(`sessionConfiguration.${name} must contain nonblank IDs`);
  }
  return Object.freeze([...values]);
}

function enforceConstraint(
  label: string,
  enabled: boolean,
  constraint: "optional" | "required" | "forbidden" | undefined,
): void {
  if (constraint !== undefined && !["optional", "required", "forbidden"].includes(constraint)) {
    throw new PersistenceConfigurationError(`${label} constraint is invalid`);
  }
  if (constraint === "required" && !enabled) {
    throw new PersistenceConfigurationError(`${label} persistence is required by the session manager`);
  }
  if (constraint === "forbidden" && enabled) {
    throw new PersistenceConfigurationError(`${label} persistence is forbidden by the session manager`);
  }
}

function cloneSessionConfiguration(
  value: ResolvedSessionConfigurationPersistence,
): ResolvedSessionConfigurationPersistence {
  return { values: value.values, include: [...value.include], exclude: [...value.exclude] };
}

function freezeTranscript(
  value: false | ResolvedTranscriptConfig,
): false | ResolvedTranscriptConfig {
  if (value === false) return false;
  return Object.freeze({ ...value, capture: Object.freeze({ ...value.capture }) });
}

function freezeAuditLog(value: false | ResolvedAuditLogConfig): false | ResolvedAuditLogConfig {
  if (value === false) return false;
  return Object.freeze({ ...value, capture: Object.freeze({ ...value.capture }) });
}

function nonblank(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}
