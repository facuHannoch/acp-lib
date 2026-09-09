import type { ConfigOption, ConfigOptions } from "../config-options.ts";
import type {
  JsonValue,
  PersistedSessionConfigSelection,
  SessionConfigurationCheckpoint,
} from "./checkpoint.ts";
import type { ResolvedSessionConfigurationPersistence } from "./config.ts";
import { canonicalizeJson, sha256CanonicalJson } from "./integrity.ts";

export interface SnapshotSessionConfigurationOptions {
  readonly adapterId: string;
  readonly configOptions: ConfigOptions;
  readonly policy: ResolvedSessionConfigurationPersistence;
  readonly restorationTargets?: readonly PersistedSessionConfigSelection[];
  readonly observedAt?: string;
}

export interface SnapshotSessionConfigurationAfterSelectionOptions
  extends SnapshotSessionConfigurationOptions {
  readonly selection: {
    readonly configId: string;
    readonly type: ConfigOption["type"];
    readonly value: unknown;
    readonly recordedAt?: string;
  };
}

/**
 * Convert the harness's latest complete option announcement into bounded continuation
 * state. Values are inspected only after their IDs/types pass persistence policy.
 */
export function snapshotSessionConfiguration(
  options: SnapshotSessionConfigurationOptions,
): SessionConfigurationCheckpoint {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const announced = [...options.configOptions.values()].sort((a, b) =>
    a.configId.localeCompare(b.configId)
  );
  const explicitlyIncluded = new Set(options.policy.include);
  const excluded = new Set(options.policy.exclude);
  const effective: Record<string, JsonValue> = {};
  const omittedConfigIds: string[] = [];

  for (const config of announced) {
    if (!isAdmitted(config, options.policy, explicitlyIncluded, excluded)) {
      omittedConfigIds.push(config.configId);
      continue;
    }
    const value = toJsonValue(config.currentValue);
    if (value === null && config.currentValue !== null) {
      omittedConfigIds.push(config.configId);
      continue;
    }
    effective[config.configId] = value;
  }

  const targets = (options.restorationTargets ?? [])
    .filter((target) => isTargetAdmitted(target, options.policy, explicitlyIncluded, excluded))
    .map((target) => structuredClone(target));

  return Object.freeze({
    adapterId: options.adapterId,
    schemaDigest: sha256CanonicalJson(announced.map(schemaProjection)),
    announcedConfigIds: Object.freeze(announced.map((config) => config.configId)),
    restorationTargets: Object.freeze(targets),
    effective: Object.freeze(effective),
    omittedConfigIds: Object.freeze(omittedConfigIds),
    restorationFidelity:
      options.policy.values === "none" || omittedConfigIds.length > 0 ? "partial" : "exact",
    observedAt,
  });
}

/** Add one successful explicit selection to the ordered restoration targets. */
export function snapshotSessionConfigurationAfterSelection(
  options: SnapshotSessionConfigurationAfterSelectionOptions,
): SessionConfigurationCheckpoint {
  const recordedAt = options.selection.recordedAt ?? options.observedAt ?? new Date().toISOString();
  const explicitlyIncluded = new Set(options.policy.include);
  const excluded = new Set(options.policy.exclude);
  const existing = (options.restorationTargets ?? [])
    .filter((target) => target.configId !== options.selection.configId);
  const value = toJsonValue(options.selection.value);
  const candidate: PersistedSessionConfigSelection | null =
    (value !== null || options.selection.value === null)
      ? {
          configId: options.selection.configId,
          type: options.selection.type,
          value,
          ordinal: existing.reduce((max, target) => Math.max(max, target.ordinal), -1) + 1,
          source: "explicit_selection",
          recordedAt,
        }
      : null;
  const restorationTargets = candidate && isTargetAdmitted(
    candidate,
    options.policy,
    explicitlyIncluded,
    excluded,
  )
    ? [...existing, candidate]
    : existing;
  return snapshotSessionConfiguration({ ...options, restorationTargets });
}

function isAdmitted(
  config: ConfigOption,
  policy: ResolvedSessionConfigurationPersistence,
  explicitlyIncluded: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): boolean {
  if (excluded.has(config.configId)) return false;
  if (explicitlyIncluded.size > 0 && !explicitlyIncluded.has(config.configId)) return false;
  if (policy.values === "none") return false;
  if (policy.values === "all") return true;
  if (config.type === "boolean") return typeof config.currentValue === "boolean";
  if (config.type === "select") {
    const current = tryCanonical(config.currentValue);
    return current !== null && (config.allowedValues ?? []).some(
      (choice) => tryCanonical(choice.value) === current,
    );
  }
  return explicitlyIncluded.has(config.configId);
}

function isTargetAdmitted(
  target: PersistedSessionConfigSelection,
  policy: ResolvedSessionConfigurationPersistence,
  explicitlyIncluded: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): boolean {
  if (excluded.has(target.configId)) return false;
  if (explicitlyIncluded.size > 0 && !explicitlyIncluded.has(target.configId)) return false;
  if (policy.values === "none") return false;
  return policy.values === "all" || target.type !== "unknown" || explicitlyIncluded.has(target.configId);
}

function schemaProjection(config: ConfigOption): Record<string, JsonValue> {
  const allowedValues: JsonValue[] = [];
  for (const choice of config.allowedValues ?? []) {
    const value = toJsonValue(choice.value);
    if (value !== null || choice.value === null) allowedValues.push(value);
  }
  return {
    configId: config.configId,
    type: config.type,
    allowedValues,
  };
}

function tryCanonical(value: unknown): string | null {
  try {
    return canonicalizeJson(value);
  } catch {
    return null;
  }
}

function toJsonValue(value: unknown): JsonValue | null {
  try {
    return JSON.parse(canonicalizeJson(value)) as JsonValue;
  } catch {
    return null;
  }
}
