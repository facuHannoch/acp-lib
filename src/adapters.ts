// Adapters carry the launch command and the grace for terminating an unresponsive harness.
// Everything else (auth methods, capabilities, features) is DISCOVERED from initialize.
// See SPEC.md "Adapters" + "Core principles".

export interface Adapter {
  /** Maximum cancellation wait before terminating this provider process. */
  cancelGraceMs?: number;
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
 * the marked entries are the ones actually spawned and verified. Check `which <command>`
 * before assuming the library is at fault.
 */
export const ADAPTERS = {
  kimi: { command: ["kimi", "acp"], ptyCommand: ["kimi"], displayName: "Kimi" }, // verified
  // verified — @agentclientprotocol/claude-agent-acp. Not the `claude` CLI, which speaks no
  // ACP. If the binary isn't on PATH: `npm i -g @agentclientprotocol/claude-agent-acp`, or
  // pass `{ command: ["bunx", "@agentclientprotocol/claude-agent-acp"] }` and skip installing.
  claude: { command: ["claude-agent-acp"], ptyCommand: ["claude"], displayName: "Claude" },
  /**
   * @deprecated The same bridge under its old name. npm marks it renamed to
   * `@agentclientprotocol/claude-agent-acp`, and it has been left far behind (0.16.x against
   * 0.64.x), so it is frozen rather than merely older. Use `claude` above.
   *
   * Kept, and NOT quietly redirected, because a preset names a program to spawn: silently
   * launching a different binary than the key says would be the harder failure to diagnose
   * of the two. It is here so an existing install keeps working while it is migrated.
   *
   * The versions behave differently in ways that reach the caller. Most sharply, the ORDER
   * of the permission options they offer is reversed — `allow_always` first here,
   * `reject_once` first in the current package — so a client that picked an option by
   * POSITION granted standing permission against one and refused everything against the
   * other. Both are covered by smoke-tests/test4-permission.
   */
  claudeCode: {
    command: ["claude-code-acp"],
    ptyCommand: ["claude"],
    displayName: "Claude (deprecated bridge)",
  },
  // verified — @agentclientprotocol/codex-acp. The `codex` CLI has no `acp` subcommand.
  codex: { command: ["codex-acp"], ptyCommand: ["codex"], displayName: "Codex" },
  // @automatalabs/pi-acp embeds Pi through its SDK and publishes the `pi-acp` binary.
  // Pi itself remains the interactive PTY command for bridge/degraded mode.
  pi: { command: ["pi-acp"], ptyCommand: ["pi"], displayName: "Pi" },
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
