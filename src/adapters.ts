// Adapters carry ONLY what's needed to LAUNCH the connection — the command.
// Everything else (auth methods, capabilities, features) is DISCOVERED from initialize.
// See SPEC.md "Adapters" + "Core principles".

export interface Adapter {
  /** The command to spawn the ACP agent binary, e.g. ["kimi", "acp"]. */
  command: string[];
  /** Optional human label, purely cosmetic. */
  displayName?: string;
}

/**
 * Convenient presets. NOT exhaustive and NOT authoritative — a caller can always pass
 * a raw `{ command: [...] }`. These only encode how to start the binary; they say
 * nothing about what the agent supports.
 */
export const ADAPTERS = {
  kimi: { command: ["kimi", "acp"], displayName: "Kimi" },
  claude: { command: ["claude-agent-acp"], displayName: "Claude" },
  codex: { command: ["codex-acp"], displayName: "Codex" },
  gemini: { command: ["gemini", "--acp", "--stdio"], displayName: "Gemini" },
  copilot: { command: ["copilot", "--acp", "--stdio"], displayName: "Copilot" },
  opencode: { command: ["opencode", "acp"], displayName: "OpenCode" },
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
