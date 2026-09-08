import { createHash } from "node:crypto";

export type PersistedMachineCode = string;

export class PersistenceSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceSerializationError";
  }
}

const MACHINE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

export function isPersistedMachineCode(value: unknown): value is PersistedMachineCode {
  return typeof value === "string" && MACHINE_CODE.test(value);
}

/** Provider-originated values are telemetry: invalid prose becomes one stable safe code. */
export function normalizeProviderMachineCode(value: unknown): PersistedMachineCode {
  return isPersistedMachineCode(value) ? value : "unknown";
}

/** Consumer/library structural codes fail closed rather than changing their meaning. */
export function assertPersistedMachineCode(
  value: unknown,
  label = "persisted machine code",
): asserts value is PersistedMachineCode {
  if (!isPersistedMachineCode(value)) {
    throw new PersistenceSerializationError(
      `${label} must match ^[A-Za-z][A-Za-z0-9_.:-]{0,127}$`,
    );
  }
}

/** RFC 8785 JSON Canonicalization Scheme serialization for JSON-compatible input. */
export function canonicalizeJson(value: unknown, maxDepth = 128): string {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new PersistenceSerializationError("maxDepth must be a positive safe integer");
  }
  return canonicalize(value, 0, maxDepth, new Set<object>());
}

export function sha256CanonicalJson(value: unknown, maxDepth = 128): string {
  return createHash("sha256").update(canonicalizeJson(value, maxDepth), "utf8").digest("hex");
}

export function checkpointDigest(
  checkpoint: Readonly<Record<string, unknown>>,
  maxDepth = 128,
): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checkpoint)) {
    if (key !== "digest") body[key] = value;
  }
  return sha256CanonicalJson(body, maxDepth);
}

export function checkpointDigestMatches(
  checkpoint: Readonly<Record<string, unknown>>,
  maxDepth = 128,
): boolean {
  return isLowercaseSha256(checkpoint.digest) && checkpoint.digest === checkpointDigest(checkpoint, maxDepth);
}

function canonicalize(
  value: unknown,
  depth: number,
  maxDepth: number,
  ancestors: Set<object>,
): string {
  if (depth > maxDepth) {
    throw new PersistenceSerializationError(`JSON value exceeds maximum depth ${maxDepth}`);
  }
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new PersistenceSerializationError("JSON numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "string":
      assertUnicodeScalarString(value);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new PersistenceSerializationError(`unsupported JSON value: ${typeof value}`);
  }

  if (ancestors.has(value)) throw new PersistenceSerializationError("cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new PersistenceSerializationError("sparse arrays are not valid canonical JSON");
        }
        items.push(canonicalize(value[index], depth + 1, maxDepth, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PersistenceSerializationError("canonical JSON objects must be plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PersistenceSerializationError("symbol keys are not valid canonical JSON");
    }

    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      assertUnicodeScalarString(key);
      members.push(
        `${JSON.stringify(key)}:${canonicalize(record[key], depth + 1, maxDepth, ancestors)}`,
      );
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new PersistenceSerializationError("strings must not contain lone surrogates");
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new PersistenceSerializationError("strings must not contain lone surrogates");
    }
  }
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
