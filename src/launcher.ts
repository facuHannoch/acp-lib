import type { Adapter } from "./adapters.ts";
import { buildPtyCommand, buildSpawnCommand } from "./adapters.ts";

export type LaunchKind = "acp" | "pty";

/** A fully resolved host process launch. The environment is exact, not an overlay. */
export interface PreparedLaunch {
  command: string[];
  spawnCwd?: string;
  /** Complete environment for the directly spawned process. */
  spawnEnv: Record<string, string>;
  /** Release resources created while preparing this launch. Called exactly once. */
  dispose?: () => void | Promise<void>;
}

/** Translates an adapter command into a runtime-specific host process launch. */
export interface AcpLauncher {
  prepare(request: {
    kind: LaunchKind;
    targetCommand: readonly string[];
  }): Promise<PreparedLaunch>;
}

export interface LegacyLaunchOptions {
  adapter: Adapter;
  execPrefix?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Resolve the new launcher contract, or reproduce the historical adapter/execPrefix
 * behavior for callers that have not migrated yet.
 */
export async function prepareLaunch(
  kind: LaunchKind,
  launcher: AcpLauncher | undefined,
  legacy: LegacyLaunchOptions,
): Promise<PreparedLaunch> {
  const targetCommand = kind === "acp" ? legacy.adapter.command : legacy.adapter.ptyCommand;
  if (!targetCommand?.length) {
    // Preserve buildPtyCommand's established error for adapters without a PTY command.
    if (kind === "pty") buildPtyCommand(legacy.adapter);
    throw new Error("adapter command cannot be empty");
  }

  if (launcher) {
    const prepared = await launcher.prepare({ kind, targetCommand: [...targetCommand] });
    if (!prepared.command.length) {
      await prepared.dispose?.();
      throw new Error("launcher returned an empty command");
    }
    if (prepared.spawnEnv == null) {
      await prepared.dispose?.();
      throw new Error("launcher must return a complete spawnEnv");
    }
    return prepared;
  }

  const command = kind === "acp"
    ? buildSpawnCommand(legacy.adapter, legacy.execPrefix)
    : buildPtyCommand(legacy.adapter, legacy.execPrefix);
  const env = {
    ...(process.env as Record<string, string>),
    ...(legacy.env ?? {}),
  };
  if (kind === "pty") env.TERM = legacy.env?.TERM ?? "xterm-color";

  return {
    command,
    // This inference exists only in the compatibility adapter. Explicit launchers own cwd.
    spawnCwd: kind === "acp" && command[0] === "docker" ? undefined : legacy.cwd,
    spawnEnv: env,
  };
}

/** Wrap a prepared launch's cleanup in an exactly-once async operation. */
export function onceDispose(dispose?: PreparedLaunch["dispose"]): () => Promise<void> {
  let result: Promise<void> | null = null;
  return () => {
    result ??= Promise.resolve().then(async () => {
      await dispose?.();
    });
    return result;
  };
}
