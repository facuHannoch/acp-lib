// Provider notices: warnings, retries and failures a harness reports in an update's `_meta`.
//
// ACP has no standard "warning" or "retrying" update, so adapters put them in `_meta` of a
// `session_info_update`. Two shapes are read here:
//
// - The JetBrains AIR session-failure extension (`_meta.jetbrains.air.sessionFailure`), sent by
//   codex-acp and claude-agent-acp once the client advertises the `sessionFailure` capability
//   (`AIR_CLIENT_CAPABILITY_META`). One typed object: id, revision, category, severity, title,
//   actions.
// - codex-acp's own fallback (`_meta.codex.error`), sent to clients that don't advertise AIR:
//   the error message, Codex's error info (an HTTP status inside) and `willRetry`.
//
// A notice with severity "error" (or `willRetry: false`) is a failure the provider reports; any
// other severity is a notice that ends nothing (a retry in progress, a reconnect, an advisory).

/** What acp-client advertises in `clientCapabilities._meta`: AIR extension version 1, session failures. */
export const AIR_CLIENT_CAPABILITY_META = Object.freeze({
  jetbrains: Object.freeze({ air: Object.freeze({ version: 1, capabilities: Object.freeze(["sessionFailure"]) }) }),
});

export type ProviderNoticeSeverity = "info" | "warning" | "error";
export type ProviderNoticeAction = "retry" | "login" | "new_session";

/** A notice or failure the provider reported, normalized from either shape. */
export interface ProviderNoticeActivity {
  kind: "provider_notice";
  /** Stable per notice: later revisions of the same notice share it. */
  noticeId: string;
  revision: number;
  severity: ProviderNoticeSeverity;
  /** Coarse class, as the adapter sends it: "limit", "service", "connection", "access", "request", … */
  category: string;
  /** A finer code when the shape allows one (from Codex's error info: "rate_limited", …). */
  code?: string;
  title: string;
  details?: string;
  actions: readonly ProviderNoticeAction[];
  httpStatus?: number;
  willRetry?: boolean;
  /** Which shape it came from. */
  source: "air" | "codex";
}

const MAX_TEXT = 512;
const ACTIONS = new Set<ProviderNoticeAction>(["retry", "login", "new_session"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line ? line.slice(0, MAX_TEXT) : undefined;
}

function actions(value: unknown): ProviderNoticeAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is ProviderNoticeAction => typeof a === "string" && ACTIONS.has(a as ProviderNoticeAction));
}

/** The HTTP status inside Codex's error info (`{ <variant>: { httpStatusCode } }`), if any. */
function codexHttpStatus(info: unknown): number | undefined {
  const variants = record(info);
  if (!variants) return undefined;
  for (const detail of Object.values(variants)) {
    const status = record(detail)?.httpStatusCode;
    if (typeof status === "number" && Number.isSafeInteger(status)) return status;
  }
  return undefined;
}

/** Codex's own categories, from its error info: a 429 is a rate limit, a 401 sign-in. */
function codexCode(info: unknown, status: number | undefined): { code: string; category: string } {
  if (status === 429) return { code: "rate_limited", category: "limit" };
  if (status === 401 || info === "unauthorized") return { code: "auth_required", category: "access" };
  if (info === "usageLimitExceeded") return { code: "quota_exhausted", category: "limit" };
  if (info === "contextWindowExceeded") return { code: "context_exhausted", category: "limit" };
  return { code: "provider_error", category: "service" };
}

function fromAir(failure: Record<string, unknown>): ProviderNoticeActivity | null {
  const noticeId = typeof failure.id === "string" && failure.id ? failure.id : undefined;
  const title = text(failure.title);
  if (!noticeId || !title) return null;
  const severity = failure.severity === "error" ? "error" : failure.severity === "info" ? "info" : "warning";
  const revision = typeof failure.revision === "number" && Number.isSafeInteger(failure.revision) ? failure.revision : 1;
  const details = text(failure.details);
  return {
    kind: "provider_notice",
    noticeId,
    revision,
    severity,
    category: text(failure.category) ?? "unknown",
    title,
    ...(details ? { details } : {}),
    actions: actions(failure.actions),
    source: "air",
  };
}

function fromCodex(error: Record<string, unknown>, fallbackId: string): ProviderNoticeActivity | null {
  const title = text(error.message);
  if (!title) return null;
  const status = codexHttpStatus(error.codexErrorInfo);
  const { code, category } = codexCode(error.codexErrorInfo, status);
  const willRetry = error.willRetry === true;
  const turn = typeof error.turnId === "string" && error.turnId ? error.turnId : fallbackId;
  return {
    kind: "provider_notice",
    // One notice per turn: a later retry warning for the same turn is a new revision of it.
    noticeId: `codex:${turn}`,
    revision: 1,
    severity: willRetry ? "warning" : "error",
    category,
    code,
    title,
    actions: willRetry ? [] : code === "auth_required" ? ["login"] : code === "rate_limited" ? ["retry"] : [],
    ...(status === undefined ? {} : { httpStatus: status }),
    willRetry,
    source: "codex",
  };
}

/**
 * A provider notice in a `session_info_update`'s `_meta`, if it carries one. AIR wins when both are
 * present. `fallbackId` names the notice when Codex sends no turn id.
 */
export function providerNoticeFromMeta(meta: unknown, fallbackId = "session"): ProviderNoticeActivity | null {
  const root = record(meta);
  if (!root) return null;
  const air = record(record(record(root.jetbrains)?.air)?.sessionFailure);
  if (air) return fromAir(air);
  const codexError = record(record(root.codex)?.error);
  if (codexError) return fromCodex(codexError, fallbackId);
  return null;
}
