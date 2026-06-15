// Adapters carry ONLY what's needed to LAUNCH the connection — the command.
// Everything else (auth methods, capabilities, features) is DISCOVERED from initialize.
// See SPEC.md "Adapters" + "Core principles".

export interface Adapter {
  /** The command to spawn the ACP agent binary, e.g. ["kimi", "acp"]. */
  command: string[];
  /**
   * The command to launch the agent's INTERACTIVE CLI for degraded (pty) mode, e.g.
   * ["codex"] (vs ACP ["codex-acp"]). Omit if the agent has no interactive mode —
   * degraded mode then refuses to start for that adapter.
   */
  ptyCommand?: string[];
  /** Optional human label, purely cosmetic. */
  displayName?: string;
}

/**
 * Convenient presets. NOT exhaustive and NOT authoritative — a caller can always pass
 * a raw `{ command: [...] }`. These only encode how to start the binary; they say
 * nothing about what the agent supports.
 */
export const ADAPTERS = {
  kimi: { command: ["kimi", "acp"], ptyCommand: ["kimi"], displayName: "Kimi" },
  claude: { command: ["claude-agent-acp"], ptyCommand: ["claude"], displayName: "Claude" },
  codex: { command: ["codex-acp"], ptyCommand: ["codex"], displayName: "Codex" },
  gemini: { command: ["gemini", "--acp", "--stdio"], ptyCommand: ["gemini"], displayName: "Gemini" },
  copilot: { command: ["copilot", "--acp", "--stdio"], ptyCommand: ["copilot"], displayName: "Copilot" },
  opencode: { command: ["opencode", "acp"], ptyCommand: ["opencode"], displayName: "OpenCode" },
} satisfies Record<string, Adapter>;

export type AdapterPreset = keyof typeof ADAPTERS;

/**
 * Merge an exec prefix (e.g. ["docker","exec","-i","<container>"]) with the adapter
 * command. The adapter doesn't know or care how it's executed — the client owns the
 * prefix. See SPEC.md "Exec prefix (Docker etc.)".
 */
export function buildSpawnCommand(adapter: Adapter, execPrefix: string[] = []): string[] {
  return [...execPrefix, ...adapter.command];
}

/**
 * Like buildSpawnCommand but for the interactive (degraded/pty) command. Throws if the
 * adapter has no `ptyCommand` — degraded mode is impossible without an interactive CLI.
 */
export function buildPtyCommand(adapter: Adapter, execPrefix: string[] = []): string[] {
  if (!adapter.ptyCommand || adapter.ptyCommand.length === 0) {
    throw new Error("adapter has no ptyCommand — degraded (pty) mode is unavailable for it");
  }
  return [...execPrefix, ...adapter.ptyCommand];
}
