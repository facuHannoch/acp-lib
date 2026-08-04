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
 *
 * A wrong command here surfaces as a connect timeout, which reads like a library fault, so
 * the marked entries are the ones actually spawned and verified. The `claude` CLI itself
 * speaks no ACP; there are TWO separate bridges and they are not interchangeable — see the
 * `claude` and `claudeAgent` entries. Check `which <command>` before assuming the library
 * is at fault.
 */
export const ADAPTERS = {
  kimi: { command: ["kimi", "acp"], ptyCommand: ["kimi"], displayName: "Kimi" }, // verified
  // verified — @zed-industries/claude-code-acp, Zed's bridge. Installs a global binary.
  claude: { command: ["claude-code-acp"], ptyCommand: ["claude"], displayName: "Claude" },
  /**
   * verified — @agentclientprotocol/claude-agent-acp, the ACP project's own Claude agent.
   * A DIFFERENT program from `claude-code-acp` above, not a rename of it, and it ships no
   * global binary (hence `bunx`).
   *
   * They differ in ways that reach the caller. Most sharply: this one orders its permission
   * options `reject_once` first, where `claude-code-acp` puts `allow_always` first — so a
   * client choosing an option by POSITION auto-refuses everything here and silently grants
   * standing permission there. Both are covered by smoke-tests/test4-permission.
   */
  claudeAgent: {
    command: ["bunx", "@agentclientprotocol/claude-agent-acp"],
    ptyCommand: ["claude"],
    displayName: "Claude Agent",
  },
  // verified — @agentclientprotocol/codex-acp. The `codex` CLI has no `acp` subcommand.
  codex: { command: ["codex-acp"], ptyCommand: ["codex"], displayName: "Codex" },
  // Below: from each project's docs, not spawned here. Correct at time of writing, unverified.
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
