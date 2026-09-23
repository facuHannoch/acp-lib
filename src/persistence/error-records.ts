import type {
  ConversationErrorDetails,
  ConversationErrorRecoverability,
  ConversationErrorSource,
} from "./backend.ts";

/** Machine-readable codes the library owns. Readers must tolerate unknown future values. */
export const CONVERSATION_ERROR_CODES = Object.freeze([
  "provider_session_create_failed",
  "provider_session_load_failed",
  "provider_session_missing",
  "provider_process_exited",
  "connection_lost",
  "prompt_interrupted",
  "recovery_failed",
  "unknown",
] as const);

export type ConversationErrorCode = (typeof CONVERSATION_ERROR_CODES)[number];

export const CONVERSATION_ERROR_SOURCES: readonly ConversationErrorSource[] = Object.freeze([
  "provider_session",
  "transport",
  "operation",
  "recovery",
]);

export const CONVERSATION_ERROR_RECOVERABILITIES: readonly ConversationErrorRecoverability[] =
  Object.freeze(["retryable", "recoverable", "terminal", "unknown"]);

const MAX_ERROR_MESSAGE_CHARS = 512;
const MAX_ERROR_DETAIL_CHARS = 128;

/**
 * Reduce an arbitrary thrown value to a short, safe, single-line display string.
 *
 * The ordinary message must never carry a stack trace, credentials, a prompt, environment
 * values, filesystem contents, or a raw provider payload. Producers normally supply a
 * curated message; this is the safety net when a raw error is passed instead. Anything it
 * cannot reduce to a short non-blank string is dropped rather than persisted.
 */
export function sanitizeConversationErrorMessage(value: unknown): string | undefined {
  const raw = typeof value === "string"
    ? value
    : value instanceof Error
      ? value.message
      : undefined;
  if (raw === undefined) return undefined;
  const firstLine = raw.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!firstLine) return undefined;
  return firstLine.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

export interface ConversationErrorDetailInput {
  readonly providerCode?: unknown;
  readonly rpcCode?: unknown;
  readonly service?: unknown;
  readonly exitCode?: unknown;
  readonly signal?: unknown;
  readonly transportState?: unknown;
}

/**
 * Build the raw-capture detail bag from allow-listed fields only.
 *
 * Unknown provider fields are discarded rather than recursively copied or heuristically
 * redacted. Returns undefined when no allow-listed field is present, so `details` is absent
 * rather than an empty object.
 */
export function buildConversationErrorDetails(
  input: ConversationErrorDetailInput,
): ConversationErrorDetails | undefined {
  const providerCode = allowCode(input.providerCode);
  const rpcCode = allowInteger(input.rpcCode);
  const service = allowLabel(input.service);
  const exitCode = allowInteger(input.exitCode);
  const signal = allowLabel(input.signal);
  const transportState = allowLabel(input.transportState);
  const details: ConversationErrorDetails = Object.freeze({
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
    ...(service === undefined ? {} : { service }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(transportState === undefined ? {} : { transportState }),
  });
  return Object.keys(details).length > 0 ? details : undefined;
}

function allowCode(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return allowLabel(value);
}

function allowInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function allowLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_ERROR_DETAIL_CHARS);
}
