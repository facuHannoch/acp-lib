import type { NeutralPermissionRequest } from "./request.ts";

export type PermissionLevel = "deny" | "ask" | "allow";

export interface PermissionSettings {
  readonly default: PermissionLevel;
  readonly rules?: Readonly<Record<string, PermissionLevel>>;
}

const weight: Record<PermissionLevel, number> = { deny: 0, ask: 1, allow: 2 };

/** Match explicit ACP kind and exact command keys. No match uses the configured default. */
export function matchPermissionLevel(
  request: Partial<Pick<NeutralPermissionRequest, "tool">>,
  settings: PermissionSettings,
): PermissionLevel {
  const { rules } = settings;
  const kind = request.tool?.kind;
  if (!rules || !kind) return settings.default;
  const command = kind === "execute" ? normalizeCommand(request.tool?.rawInput) : undefined;
  const byKind = lookup(rules, `kind:${kind}`);
  const byCommand = command === undefined ? undefined : lookup(rules, `command:${command}`);
  if (byKind === undefined) return byCommand ?? settings.default;
  if (byCommand === undefined) return byKind;
  return weight[byKind] <= weight[byCommand] ? byKind : byCommand;
}

function lookup(rules: NonNullable<PermissionSettings["rules"]>, key: string): PermissionLevel | undefined {
  return Object.hasOwn(rules, key) ? rules[key] : undefined;
}

function normalizeCommand(input: unknown): string | undefined {
  if (typeof input === "string") return normalizeShellLine(input);
  if (Array.isArray(input)) return normalizeArgv(input);
  if (typeof input !== "object" || input === null) return undefined;

  const fields = input as Record<string, unknown>;
  const hasArgs = Object.hasOwn(fields, "args");
  if (Object.hasOwn(fields, "argv")) {
    if (Object.hasOwn(fields, "command") || hasArgs) return undefined;
    return Array.isArray(fields.argv) ? normalizeArgv(fields.argv) : undefined;
  }
  if (!Object.hasOwn(fields, "command")) return undefined;
  if (hasArgs) {
    return typeof fields.command === "string" && Array.isArray(fields.args)
      ? normalizeArgv([fields.command, ...fields.args])
      : undefined;
  }
  if (typeof fields.command === "string") return normalizeShellLine(fields.command);
  return Array.isArray(fields.command) ? normalizeArgv(fields.command) : undefined;
}

function normalizeShellLine(command: string): string | undefined {
  if (!isSingleLine(command)) return undefined;
  // The only string wrappers accepted are exactly bash -lc '…' and bash -lc "…".
  // Double quotes admit outer-shell expansion, so reject expansion or escape characters there.
  const wrapped = /^bash -lc '(?<single>[^']*)'$|^bash -lc "(?<double>[^"`$\\]*)"$/.exec(command);
  if (wrapped) {
    const inner = wrapped.groups?.single ?? wrapped.groups?.double;
    return inner !== undefined && isSingleLine(inner) ? inner : undefined;
  }
  // A malformed or compound bash -lc expression is ambiguous, even if it starts with a known wrapper.
  if (/^\s*bash[ \t]+-lc(?:\s|$)/.test(command)) return undefined;
  return command;
}

function normalizeArgv(argv: readonly unknown[]): string | undefined {
  const [executable, flag, body] = argv;
  // The only argv wrapper accepted is exactly ["bash", "-lc", command].
  if (executable === "bash" && flag === "-lc") {
    return argv.length === 3 && typeof body === "string" && isSingleLine(body) ? body : undefined;
  }
  if (typeof executable !== "string" || executable.includes("=")) return undefined;
  // Joining an empty, quoted or compound token would lose the original argument boundaries.
  if (!argv.every((arg) => typeof arg === "string" && /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg))) return undefined;
  return argv.join(" ");
}

function isSingleLine(command: string): boolean {
  return command.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(command);
}
