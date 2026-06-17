// REPL command handlers — reusable slash-command layer for interactive sessions.
// This extracts command handlers from the CLI so they can be shared across any
// interactive consumer (CLI, hub terminal mode, etc).
//
// Usage:
//   const { onSlashCommand } = createAgentCommands({ client, note, color });
//   await runRepl(client, { onSlashCommand });

import type { AgentClient, AgentMode, Capabilities, ConfigOption, AuthMethod } from "../index.ts";
import type { AgentCommand, SessionListEntry } from "../types.ts";
import type { SessionManager, MergedSession } from "../session-manager.ts";

export interface CommandHandlerDeps {
  /** The agent connection (implements AgentClient + controller methods). */
  client: any; // AgentController-like; typed loosely for Phase 4a
  /** Output sink for command responses. */
  note: (msg: string) => void;
  /** Whether to emit color codes. Default false. */
  color?: boolean;
  /** Optional catalog manager for persisting session results. */
  sessionManager?: SessionManager;
  /** Current adapter id for catalog recording. Needed if sessionManager is set. */
  adapterId?: string;
}

/** Return value from createAgentCommands. */
export interface AgentCommands {
  onSlashCommand: (command: string, args: string[]) => Promise<boolean>;
}

/**
 * Create a reusable slash-command handler for interactive REPL sessions.
 * Handles /help, /login, /new, /sessions, /load, etc.
 */
export function createAgentCommands(deps: CommandHandlerDeps): AgentCommands {
  const { client, note, color = false, sessionManager, adapterId } = deps;

  const recordSession = async (agentSessionId: string | null): Promise<void> => {
    if (!sessionManager || !adapterId || !client.id) return;
    try {
      await sessionManager.record({
        id: client.id,
        agentSessionId,
        adapter: adapterId,
        mode: client.currentMode,
        cwd: client.currentCwd,
      });
    } catch {
      // Catalog write failure is not fatal — the session still works.
    }
  };

  const onSlashCommand = async (command: string, commandArgs: string[]): Promise<boolean> => {
    switch (command) {
      case "help": {
        note(
          `commands: /help ${client.getCommands().map((c: any) => c.usage).join(" ")} ` +
            `/degrade /upgrade /exit`,
        );
        const agentCmds = client.agentCommands;
        if (agentCmds.length > 0) {
          note(`agent commands (send with //name): ${agentCmds.map((c: AgentCommand) => `/${c.name}`).join(" ")}`);
        } else if (!client.isDegraded) {
          note("agent commands: (none advertised) — //name still forwards a /name to the agent");
        } else {
          note("//name forwards a /name slash command to the agent's TUI");
        }
        return true;
      }
      case "caps": {
        if (client.isDegraded) {
          note("degraded (pty) mode — no ACP capabilities; /upgrade to reconnect over ACP");
          return true;
        }
        const c = client.capabilities.agent;
        note(
          `loadSession=${c.loadSession} image=${c.promptCapabilities.image} ` +
            `logout=${c.auth?.logout ?? false} list=${c.sessionCapabilities.list} ` +
            `config=[${[...client.configOptions.keys()].join(",")}]`,
        );
        return true;
      }
      case "session":
        note(
          `${client.currentSessionId ?? "(no session)"} ` +
            `(${client.currentAdapterId}, ${client.currentMode})`,
        );
        return true;
      case "login": {
        if (client.isDegraded) {
          note("ACP login unavailable in degraded mode (terminal bridge not built yet)");
          return true;
        }
        const methods = client.authMethods;
        const methodId = commandArgs[0];
        if (!methodId) {
          if (methods.length === 0) {
            note("agent advertises no auth methods (it may log in externally, or already be authenticated)");
            return true;
          }
          note("auth methods:");
          for (const m of methods) {
            note(`  ${m.id}  ${m.name}${m.description ? ` — ${m.description}` : ""}`);
          }
          note("run: /login METHOD");
          return true;
        }
        if (methods.length > 0 && !methods.some((m: AuthMethod) => m.id === methodId)) {
          note(`unknown method: ${methodId}`);
          note(`available: ${methods.map((m: AuthMethod) => m.id).join(", ") || "(none)"}`);
          return true;
        }
        note(`authenticating with ${methodId}… (follow any URL/code shown below)`);
        try {
          await client.authenticate(methodId, {
            onOutput: (line: string) => {
              if (!isRpcNoise(line)) note(line);
            },
          });
          note(`authenticated with ${methodId}. If replies were empty, run /new for a fresh session.`);
        } catch (e) {
          note(`login failed: ${String(e)}`);
        }
        return true;
      }
      case "new": {
        try {
          const result = await client.newSession();
          note(`new session ${result.sessionId}`);
          await recordSession(result.sessionId);
        } catch (e) {
          note(`could not start a new session: ${String(e)}`);
        }
        return true;
      }
      case "bridge": {
        try {
          await client.bridge();
        } catch (e) {
          note(`bridge failed: ${String(e)}`);
        }
        return true;
      }
      case "degrade":
      case "upgrade": {
        const mode = command === "degrade" ? "degraded" : "normal";
        if (client.currentMode === mode) {
          note(`already in ${mode} mode`);
          return true;
        }
        try {
          const result = await client.setMode(mode);
          note(
            mode === "degraded"
              ? `degraded to pty (${client.currentAdapterId})`
              : `upgraded to ACP, new session ${result.sessionId}`,
          );
        } catch (e) {
          note(`could not switch to ${mode}: ${String(e)}`);
        }
        return true;
      }
      case "sessions": {
        try {
          let sessions: (SessionListEntry | MergedSession)[] = [];

          // If we have a sessionManager, show merged view (catalog + agent)
          if (sessionManager && adapterId) {
            let agentEntries: SessionListEntry[] = [];
            if (!client.isDegraded && client.capabilities.agent.sessionCapabilities.list) {
              try {
                agentEntries = (await client.listSessions()).sessions;
              } catch {
                // Agent list broken — fall back to catalog only
              }
            }
            sessions = await sessionManager.listMerged(agentEntries, adapterId);
          } else if (client.capabilities.agent.sessionCapabilities.list) {
            // No catalog — just show agent sessions
            const page = await client.listSessions();
            sessions = page.sessions;
          } else {
            note("agent does not support session/list");
            return true;
          }

          if (sessions.length === 0) {
            note("(no sessions)");
          } else {
            for (const s of sessions) {
              const isMerged = "source" in s;
              const merged = s as MergedSession;
              const plain = s as SessionListEntry;
              const source = isMerged ? ` [${merged.source}]` : "";
              note(`${isMerged ? merged.id : plain.sessionId}  ${s.title ?? ""}  ${s.updatedAt ?? ""}${source}`);
            }
          }
        } catch (e) {
          note(`sessions failed: ${String(e)}`);
        }
        return true;
      }
      case "load": {
        const target = commandArgs[0];
        if (!target) {
          note("usage: /load SESSION_ID");
          return true;
        }
        if (!client.capabilities.agent.loadSession) {
          note("load not supported by this agent");
          return true;
        }
        const replay = createSessionReplayRenderer(color);
        clearTerminal();
        const result = await client.loadSession(target, { onUpdate: replay.onUpdate });
        replay.finish();
        note(`loaded session ${result.sessionId}`);
        await recordSession(result.sessionId);
        return true;
      }
      case "resume": {
        const target = commandArgs[0];
        if (!target) {
          note("usage: /resume SESSION_ID");
          return true;
        }
        if (!client.capabilities.agent.sessionCapabilities.resume) {
          note("resume not supported by this agent");
          return true;
        }
        const result = await client.resumeSession(target);
        note(`resumed session ${result.sessionId}`);
        await recordSession(result.sessionId);
        return true;
      }
      case "fork": {
        const target = commandArgs[0];
        if (!target) {
          note("usage: /fork SESSION_ID");
          return true;
        }
        if (!client.capabilities.agent.sessionCapabilities.fork) {
          note("fork not supported by this agent");
          return true;
        }
        const result = await client.forkSession(target);
        note(`forked session ${target} -> ${result.sessionId}`);
        await recordSession(result.sessionId);
        return true;
      }
      case "config": {
        const configId = commandArgs[0];
        if (!configId) {
          note(formatConfigList(client.configOptions));
          return true;
        }

        const option = client.configOptions.get(configId);
        if (!option) {
          note(`unknown config: ${configId}`);
          note(`available configs: ${[...client.configOptions.keys()].join(", ") || "(none)"}`);
          return true;
        }

        const rawValue = commandArgs.slice(1).join(" ");
        if (!rawValue) {
          note(formatConfigDetail(option));
          return true;
        }

        const parsed = client.parseConfigValue(configId, rawValue);
        if (!parsed.ok) {
          note(parsed.error);
          return true;
        }

        const result = await client.setConfigFromString(configId, rawValue);
        note(`set ${configId}=${formatConfigValue(result.currentValue)}`);
        return true;
      }
      default:
        return false; // unknown → treat as a normal prompt
    }
  };

  return { onSlashCommand };
}

function clearTerminal(): void {
  if (process.stderr.isTTY) process.stderr.write("\x1b[2J\x1b[H");
}

/** True for lines that are part of an agent's raw JSON-RPC error dump (not user-facing). */
function isRpcNoise(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (/^Error handling request/i.test(t)) return true;
  if (/^[{}],?$/.test(t)) return true;
  if (/^(jsonrpc|id|method|params|code|message|data)\s*:/i.test(t)) return true;
  return false;
}

function formatConfigList(configOptions: Map<string, ConfigOption>): string {
  if (configOptions.size === 0) return "no config options advertised by this session";
  return [...configOptions.values()]
    .map((option) => {
      const label = option.label ? ` (${option.label})` : "";
      return `${option.configId}${label}  ${option.type}  current=${formatConfigValue(option.currentValue)}`;
    })
    .join("\n");
}

function formatConfigDetail(option: ConfigOption): string {
  const lines = [
    `${option.configId}${option.label ? `: ${option.label}` : ""}`,
    `type: ${option.type}`,
    `current: ${formatConfigValue(option.currentValue)}`,
  ];
  if (option.description) lines.push(`description: ${option.description}`);
  if (option.allowedValues?.length) {
    lines.push(`values: ${option.allowedValues.map((choice) => formatConfigValue(choice.value)).join(", ")}`);
  }
  return lines.join("\n");
}

function formatConfigValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  if (v === undefined) return "(unset)";
  return String(v);
}

function createSessionReplayRenderer(
  color: boolean,
): {
  onUpdate(notification: unknown): void;
  finish(): void;
} {
  let currentRole: "user" | "agent" | null = null;
  let wrote = false;

  const paint = (text: string): string => {
    if (!color) return text;
    // BOLD for labels
    return `\x1b[1m${text}\x1b[0m`;
  };

  const label = (role: "user" | "agent") => {
    if (currentRole === role) return;
    if (wrote) process.stderr.write("\n");
    const text = role === "user" ? "you ›" : "agent ›";
    process.stderr.write(paint(text) + " ");
    currentRole = role;
    wrote = true;
  };

  return {
    onUpdate(notification: unknown) {
      const update = (notification as Record<string, any>)?.update;
      const kind = update?.sessionUpdate;
      if (kind !== "user_message_chunk" && kind !== "agent_message_chunk") return;

      const text = update.content?.type === "text" ? (update.content.text ?? "") : "";
      if (!text) return;

      label(kind === "user_message_chunk" ? "user" : "agent");
      process.stderr.write(text);
    },
    finish() {
      if (wrote) process.stderr.write("\n");
    },
  };
}

// Re-export runRepl for convenience (used by consumers composing commands + repl).
export { runRepl } from "../cli/repl.ts";
export type { ReplOptions } from "../cli/repl.ts";
