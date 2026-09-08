import { createHash } from "node:crypto";
import {
  validatePersistenceLimits,
  type PersistenceLimits,
} from "./config.ts";
import { canonicalizeJson, PersistenceSerializationError } from "./integrity.ts";
import type {
  KnownAuditLogRecord,
  KnownTranscriptRecord,
  OmittedPersistedValue,
  PersistedTruncation,
} from "./records.ts";

export interface SessionLogTruncationOptions {
  readonly limits: PersistenceLimits;
  readonly includeTruncationDigests?: boolean;
}

export class SessionLogTruncationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionLogTruncationError";
  }
}

/**
 * Bound an already policy-filtered record. This function never decides capture policy:
 * values excluded by projection must not be passed here merely to compute their size/hash.
 */
export function truncateSessionLogRecord<T extends KnownTranscriptRecord | KnownAuditLogRecord>(
  record: T,
  options: SessionLogTruncationOptions,
): T {
  validatePersistenceLimits(options.limits);
  let output: MutableRecord;
  try {
    output = structuredClone(record) as MutableRecord;
  } catch (error) {
    throw new SessionLogTruncationError("projected record cannot be cloned as persistence data", { cause: error });
  }
  const candidates = truncationCandidates(output);
  const metadata = new Map<string, PersistedTruncation>();

  for (const candidate of candidates) {
    const value = candidate.get();
    if (value === undefined) continue;
    if (candidate.kind === "string") {
      const original = String(value);
      if (utf8Bytes(original) > options.limits.maxCapturedFieldBytes) {
        candidate.set(prefixByUtf8Bytes(original, options.limits.maxCapturedFieldBytes));
        metadata.set(candidate.field, truncationMetadata(candidate.field, "field_limit", original, options.includeTruncationDigests));
      }
      continue;
    }
    const measured = measureStructured(value, options.limits.maxJsonDepth);
    if (measured.status === "too_deep") {
      candidate.set(omitted("max_depth", undefined, undefined));
      candidate.reduced = true;
    } else if (measured.bytes > options.limits.maxCapturedFieldBytes) {
      const info = truncationMetadata(candidate.field, "field_limit", value, options.includeTruncationDigests);
      candidate.set(candidate.kind === "optional" ? undefined : omitted("field_limit", info.originalBytes, info.originalSha256));
      metadata.set(candidate.field, info);
      candidate.reduced = true;
    }
  }

  installMetadata(output, metadata);
  for (;;) {
    const size = recordBytes(output, options.limits.maxJsonDepth);
    if (size.status === "ok" && size.bytes <= options.limits.maxRecordBytes) return output as T;

    const candidate = candidates.find((item) => !item.reduced && item.get() !== undefined);
    if (!candidate) {
      throw new SessionLogTruncationError(
        size.status === "too_deep"
          ? "structural session-log record exceeds maxJsonDepth"
          : `structural session-log record exceeds maxRecordBytes (${size.bytes} > ${options.limits.maxRecordBytes})`,
      );
    }
    const original = candidate.original;
    if (candidate.kind === "string") {
      const info = truncationMetadata(candidate.field, "record_limit", original, options.includeTruncationDigests);
      metadata.set(candidate.field, info);
      installMetadata(output, metadata);
      candidate.set(longestFittingPrefix(output, candidate, String(candidate.get()), options.limits));
    } else {
      const measured = measureStructured(original, Number.MAX_SAFE_INTEGER);
      const info = measured.status === "ok"
        ? truncationMetadata(candidate.field, "record_limit", original, options.includeTruncationDigests)
        : null;
      candidate.set(candidate.kind === "optional"
        ? undefined
        : omitted("record_limit", info?.originalBytes, info?.originalSha256));
      if (info) metadata.set(candidate.field, info);
    }
    candidate.reduced = true;
    installMetadata(output, metadata);
  }
}

type MutableRecord = Record<string, any>;
interface Candidate {
  readonly field: string;
  readonly kind: "string" | "value" | "optional";
  readonly original: unknown;
  get(): unknown;
  set(value: unknown): void;
  reduced: boolean;
}

function truncationCandidates(record: MutableRecord): Candidate[] {
  const candidates: Candidate[] = [];
  // Priority is normative: raw duplicates/results, reasoning, invocation input, message
  // structure/text, then other presentation-only details.
  if (record.t === "raw") add(record, "data", "data", "value", candidates);
  if (record.t === "activity" && isRecord(record.data)) {
    add(record.data, "content", "data.content", "value", candidates);
  }
  if (record.t === "reasoning") add(record, "text", "text", "string", candidates);
  if (record.t === "activity" && isRecord(record.data)) {
    add(record.data, "input", "data.input", "value", candidates);
  }
  if (record.t === "message") {
    add(record, "structured", "structured", "optional", candidates);
    add(record, "text", "text", "string", candidates);
    add(record, "status", "status", "string", candidates);
    add(record, "stopReason", "stopReason", "string", candidates);
  }
  if (record.t === "configuration") {
    add(record, "definitions", "definitions", "value", candidates);
    add(record, "value", "value", "value", candidates);
  }
  if (record.t === "permission") add(record, "details", "details", "value", candidates);
  if (record.t === "transition") {
    add(record, "summary", "summary", "string", candidates);
    add(record, "reasonText", "reasonText", "string", candidates);
  }
  if (record.t === "metering_reference") add(record, "summary", "summary", "value", candidates);
  if (record.t === "lifecycle") add(record, "detail", "detail", "value", candidates);
  if (record.t === "protocol" && isRecord(record.agent)) {
    add(record.agent, "name", "agent.name", "string", candidates);
    add(record.agent, "title", "agent.title", "string", candidates);
    add(record.agent, "version", "agent.version", "string", candidates);
  }
  return candidates;
}

function add(
  container: MutableRecord,
  key: string,
  field: string,
  kind: Candidate["kind"],
  output: Candidate[],
): void {
  if (!(key in container)) return;
  const original = structuredClone(container[key]);
  output.push({
    field,
    kind,
    original,
    get: () => container[key],
    set: (value) => { if (value === undefined) delete container[key]; else container[key] = value; },
    reduced: false,
  });
}

function installMetadata(record: MutableRecord, values: Map<string, PersistedTruncation>): void {
  if (values.size === 0) return;
  const existing = Array.isArray(record.truncation) ? record.truncation : [];
  const fields = new Set(values.keys());
  record.truncation = [
    ...existing.filter((item: PersistedTruncation) => !fields.has(item.field)),
    ...values.values(),
  ];
}

function truncationMetadata(
  field: string,
  reason: PersistedTruncation["reason"],
  value: unknown,
  includeDigest = false,
): PersistedTruncation {
  const bytes = persistenceBytes(value);
  return {
    field,
    reason,
    originalBytes: bytes.byteLength,
    ...(includeDigest ? { originalSha256: createHash("sha256").update(bytes).digest("hex") } : {}),
  };
}

function omitted(
  reason: OmittedPersistedValue["reason"],
  originalBytes?: number,
  originalSha256?: string,
): OmittedPersistedValue {
  return {
    omitted: true,
    reason,
    ...(originalBytes === undefined ? {} : { originalBytes }),
    ...(originalSha256 === undefined ? {} : { originalSha256 }),
  };
}

function longestFittingPrefix(
  record: MutableRecord,
  candidate: Candidate,
  current: string,
  limits: PersistenceLimits,
): string {
  const points = Array.from(current);
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = points.slice(0, middle).join("");
    candidate.set(value);
    const size = recordBytes(record, limits.maxJsonDepth);
    if (size.status === "ok" && size.bytes <= limits.maxRecordBytes) {
      best = value;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function prefixByUtf8Bytes(value: string, limit: number): string {
  let used = 0;
  let output = "";
  for (const point of value) {
    const bytes = utf8Bytes(point);
    if (used + bytes > limit) break;
    output += point;
    used += bytes;
  }
  return output;
}

function measureStructured(value: unknown, maxDepth: number): { status: "ok"; bytes: number } | { status: "too_deep" } {
  try {
    return { status: "ok", bytes: utf8Bytes(canonicalizeJson(value, maxDepth)) };
  } catch (error) {
    if (isMaximumDepthError(error)) return { status: "too_deep" };
    throw new SessionLogTruncationError("captured value is not canonical JSON", { cause: error });
  }
}

function recordBytes(record: MutableRecord, maxDepth: number): { status: "ok"; bytes: number } | { status: "too_deep"; bytes?: never } {
  try {
    canonicalizeJson(record, maxDepth);
    return { status: "ok", bytes: utf8Bytes(JSON.stringify(record)) };
  } catch (error) {
    if (isMaximumDepthError(error)) return { status: "too_deep" };
    throw new SessionLogTruncationError("session-log record is not canonical JSON", { cause: error });
  }
}

function isMaximumDepthError(error: unknown): boolean {
  return error instanceof PersistenceSerializationError
    && error.message.startsWith("JSON value exceeds maximum depth ");
}

function persistenceBytes(value: unknown): Buffer {
  return Buffer.from(typeof value === "string" ? value : canonicalizeJson(value), "utf8");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
