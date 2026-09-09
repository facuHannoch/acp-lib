import { describe, expect, test } from "bun:test";
import type { ConfigOptions } from "../src/config-options.ts";
import {
  snapshotSessionConfiguration,
  snapshotSessionConfigurationAfterSelection,
} from "../src/persistence/configuration-state.ts";

const options: ConfigOptions = new Map([
  ["model", { configId: "model", type: "select", currentValue: "sonnet", allowedValues: [{ value: "sonnet" }, { value: "opus" }] }],
  ["enabled", { configId: "enabled", type: "boolean", currentValue: true }],
  ["secret", { configId: "secret", type: "unknown", currentValue: "private-value" }],
]);

describe("session configuration persistence snapshots", () => {
  test("typed policy keeps recognized values and reports omitted unknown values", () => {
    const snapshot = snapshotSessionConfiguration({
      adapterId: "claude",
      configOptions: options,
      policy: { values: "typed", include: [], exclude: [] },
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(snapshot.announcedConfigIds).toEqual(["enabled", "model", "secret"]);
    expect(snapshot.effective).toEqual({ enabled: true, model: "sonnet" });
    expect(snapshot.omittedConfigIds).toEqual(["secret"]);
    expect(snapshot.restorationFidelity).toBe("partial");
    expect(snapshot.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an include list is an allowlist and may explicitly admit an unknown value", () => {
    const snapshot = snapshotSessionConfiguration({
      adapterId: "claude",
      configOptions: options,
      policy: { values: "typed", include: ["secret"], exclude: [] },
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(snapshot.effective).toEqual({ secret: "private-value" });
    expect(snapshot.omittedConfigIds).toEqual(["enabled", "model"]);
    expect(snapshot.restorationFidelity).toBe("partial");
  });

  test("excluded and non-JSON values are never copied into continuation state", () => {
    const malformed: ConfigOptions = new Map([
      ...options,
      ["bad", { configId: "bad", type: "unknown", currentValue: undefined }],
    ]);
    const snapshot = snapshotSessionConfiguration({
      adapterId: "claude",
      configOptions: malformed,
      policy: { values: "all", include: [], exclude: ["secret"] },
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(snapshot.effective).toEqual({ enabled: true, model: "sonnet" });
    expect(snapshot.omittedConfigIds).toEqual(["bad", "secret"]);
  });

  test("schema digest is stable across announcement-map insertion order", () => {
    const reversed = new Map([...options].reverse());
    const policy = { values: "all" as const, include: [], exclude: [] };
    const a = snapshotSessionConfiguration({ adapterId: "claude", configOptions: options, policy, observedAt: "2026-01-01T00:00:00.000Z" });
    const b = snapshotSessionConfiguration({ adapterId: "claude", configOptions: reversed, policy, observedAt: "2026-01-01T00:00:00.000Z" });
    expect(a.schemaDigest).toBe(b.schemaDigest);
  });

  test("successful selections become ordered restoration targets and reselection moves last", () => {
    const policy = { values: "typed" as const, include: [], exclude: [] };
    const first = snapshotSessionConfigurationAfterSelection({
      adapterId: "claude", configOptions: options, policy,
      selection: { configId: "model", type: "select", value: "sonnet", recordedAt: "2026-01-01T00:00:00.000Z" },
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    const second = snapshotSessionConfigurationAfterSelection({
      adapterId: "claude", configOptions: options, policy,
      restorationTargets: first.restorationTargets,
      selection: { configId: "enabled", type: "boolean", value: true, recordedAt: "2026-01-01T00:00:01.000Z" },
      observedAt: "2026-01-01T00:00:01.000Z",
    });
    const third = snapshotSessionConfigurationAfterSelection({
      adapterId: "claude", configOptions: options, policy,
      restorationTargets: second.restorationTargets,
      selection: { configId: "model", type: "select", value: "opus", recordedAt: "2026-01-01T00:00:02.000Z" },
      observedAt: "2026-01-01T00:00:02.000Z",
    });

    expect(third.restorationTargets.map((target) => [target.configId, target.ordinal]))
      .toEqual([["enabled", 1], ["model", 2]]);
    expect(third.restorationTargets[1]?.value).toBe("opus");
  });
});
