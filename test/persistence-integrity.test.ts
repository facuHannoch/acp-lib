import { describe, expect, test } from "bun:test";
import {
  PersistenceSerializationError,
  assertPersistedMachineCode,
  canonicalizeJson,
  checkpointDigest,
  checkpointDigestMatches,
  isPersistedMachineCode,
  normalizeProviderMachineCode,
  sha256CanonicalJson,
} from "../src/persistence/integrity.ts";

describe("persistence canonicalization", () => {
  test("sorts object keys recursively and preserves array order", () => {
    expect(canonicalizeJson({ z: [{ b: 2, a: 1 }, 3], a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2},3]}',
    );
  });

  test("uses deterministic ECMAScript number and string serialization", () => {
    expect(canonicalizeJson({ negativeZero: -0, small: 1e-7, text: "€\n😀" })).toBe(
      '{"negativeZero":0,"small":1e-7,"text":"€\\n😀"}',
    );
  });

  test("produces the known SHA-256 for canonical JSON", () => {
    expect(sha256CanonicalJson({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  test("rejects unsupported, lossy, cyclic, sparse, and over-depth values", () => {
    expect(() => canonicalizeJson({ value: undefined })).toThrow(PersistenceSerializationError);
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow("numbers must be finite");
    expect(() => canonicalizeJson(new Date())).toThrow("plain objects");
    expect(() => canonicalizeJson([, 1])).toThrow("sparse arrays");
    expect(() => canonicalizeJson("\ud800")).toThrow("lone surrogates");
    expect(() => canonicalizeJson({ nested: { tooDeep: true } }, 1)).toThrow("maximum depth");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow("cyclic JSON value");
  });

  test("allows repeated non-cyclic object references", () => {
    const shared = { value: 1 };
    expect(canonicalizeJson({ a: shared, b: shared })).toBe(
      '{"a":{"value":1},"b":{"value":1}}',
    );
  });

  test("checkpoint digests exclude exactly the digest member", () => {
    const checkpoint: Record<string, unknown> = {
      version: 1,
      stateRevision: 3,
      digest: "ignored",
      state: { b: 2, a: 1 },
    };
    checkpoint.digest = checkpointDigest(checkpoint);
    expect(checkpointDigestMatches(checkpoint)).toBe(true);

    checkpoint.stateRevision = 4;
    expect(checkpointDigestMatches(checkpoint)).toBe(false);
    checkpoint.digest = checkpointDigest(checkpoint);
    expect(checkpointDigestMatches(checkpoint)).toBe(true);
    checkpoint.digest = String(checkpoint.digest).toUpperCase();
    expect(checkpointDigestMatches(checkpoint)).toBe(false);
  });
});

describe("persisted machine codes", () => {
  test("accepts bounded identifiers used by library and adapters", () => {
    for (const value of ["unknown", "transport.closed", "ACP_LOAD:failed-1", `a${"x".repeat(127)}`]) {
      expect(isPersistedMachineCode(value)).toBe(true);
      expect(() => assertPersistedMachineCode(value)).not.toThrow();
    }
  });

  test("rejects prose, paths, whitespace, punctuation, and oversized identifiers", () => {
    for (const value of ["", "two words", "/home/user", "bad/error", "bad@example", `a${"x".repeat(128)}`]) {
      expect(isPersistedMachineCode(value)).toBe(false);
      expect(() => assertPersistedMachineCode(value)).toThrow(PersistenceSerializationError);
    }
  });

  test("normalizes untrusted provider values to one safe code", () => {
    expect(normalizeProviderMachineCode("rate_limit.exceeded")).toBe("rate_limit.exceeded");
    expect(normalizeProviderMachineCode("Error reading /home/alice/secret")).toBe("unknown");
    expect(normalizeProviderMachineCode({ message: "secret" })).toBe("unknown");
  });
});
