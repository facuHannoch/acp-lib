import { basename } from "node:path";
import { ADAPTERS, type Adapter } from "../adapters.ts";

export interface CliAdapterSelection {
  /** Preset key, or the stable id assigned to a custom adapter. */
  adapterId?: string;
  /** Explicit ACP launch argv. When present, this takes precedence over presets. */
  command?: string[];
  /** Optional interactive launch argv for degraded mode and bridge. */
  ptyCommand?: string[];
  /** Optional custom display label. */
  displayName?: string;
}

export interface ResolvedCliAdapter {
  adapterId: string;
  adapter: Adapter;
}

/**
 * Parse one CLI command value. A plain value represents one executable; commands with
 * arguments use a JSON string array so paths and arguments containing spaces stay exact.
 */
export function parseCommandArg(value: string | undefined, flag: string): string[] {
  if (!value?.trim()) throw new Error(`${flag} requires an executable or JSON argv array`);
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return [trimmed];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${String(error)}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error(`${flag} must be a non-empty JSON array of non-empty strings`);
  }
  return parsed;
}

/** Resolve a built-in preset or construct the custom adapter supplied by the CLI user. */
export function resolveCliAdapter(selection: CliAdapterSelection): ResolvedCliAdapter {
  if (selection.command) {
    if (selection.command.length === 0) throw new Error("custom adapter command cannot be empty");
    const adapterId = selection.adapterId?.trim() || basename(selection.command[0]!) || "custom";
    return {
      adapterId,
      adapter: {
        command: [...selection.command],
        ...(selection.ptyCommand ? { ptyCommand: [...selection.ptyCommand] } : {}),
        ...(selection.displayName ? { displayName: selection.displayName } : {}),
      },
    };
  }

  const adapterId = selection.adapterId?.trim() || "kimi";
  if (!(adapterId in ADAPTERS)) {
    throw new Error(
      `unknown adapter preset: ${adapterId}; known presets: ${Object.keys(ADAPTERS).join(", ")}; ` +
        "use --adapter-command for a custom ACP harness",
    );
  }
  const adapter = ADAPTERS[adapterId as keyof typeof ADAPTERS];
  return { adapterId, adapter };
}
