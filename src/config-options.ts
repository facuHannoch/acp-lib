// Config options (models, reasoning_effort, etc.) — NEVER hardcoded. Discovered from
// session/new and stored as a Map keyed by configId. See SPEC.md "Config options".

import type * as schema from "@agentclientprotocol/sdk";

export interface ConfigOptionChoice {
  value: unknown;
  label?: string;
  description?: string;
}

export interface ConfigOption {
  configId: string;
  label?: string;
  description?: string;
  type: "select" | "boolean" | "unknown";
  currentValue: unknown;
  /** For select types: the allowed values. */
  allowedValues?: ConfigOptionChoice[];
}

export type ConfigOptions = Map<string, ConfigOption>;

/** Parse the configOptions array returned by session/new into our Map model. */
export function parseConfigOptions(
  raw: schema.SessionConfigOption[] | null | undefined,
): ConfigOptions {
  const map: ConfigOptions = new Map();
  for (const o of raw ?? []) {
    const opt = o as Record<string, any>;
    const type: ConfigOption["type"] =
      opt.type === "select" || opt.type === "boolean" ? opt.type : "unknown";

    const allowedValues: ConfigOptionChoice[] | undefined =
      type === "select" && Array.isArray(opt.options)
        ? flattenSelectOptions(opt.options)
        : undefined;

    map.set(opt.id, {
      configId: opt.id,
      label: opt.name ?? undefined,
      description: opt.description ?? undefined,
      type,
      currentValue: opt.currentValue ?? opt.value,
      allowedValues,
    });
  }
  return map;
}

function flattenSelectOptions(options: Record<string, any>[]): ConfigOptionChoice[] {
  const choices: ConfigOptionChoice[] = [];
  for (const option of options) {
    if (Array.isArray(option.options)) {
      choices.push(...flattenSelectOptions(option.options));
      continue;
    }
    choices.push({
      value: option.value ?? option.id,
      label: option.name ?? option.label,
      description: option.description ?? undefined,
    });
  }
  return choices;
}
