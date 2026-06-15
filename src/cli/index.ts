#!/usr/bin/env bun
// Thin CLI entry — arg parsing + wiring only. Imports the public library like any
// external caller and owns NO protocol logic. The interactive loop lives in ./repl.ts.
// See SPEC.md "library first, CLI second".
//
// Usage:
//   acp-lib chat [SESSION_ID] [--adapter kimi] [--exec "docker exec -i <ctr>"]
//                [--cwd /workspace] [--approve] [--verbose] [--debug]
//                [--no-activity] [--degraded]
//
//   activity (thinking/tool markers) shows by DEFAULT; --no-activity disables it.
//   --verbose (-v): lifecycle summaries (connect, session_new, prompt_end)
//   --debug   (-d): the above PLUS raw protocol payloads (initialize/prompt/session_update)

import {
  AgentController,
  ADAPTERS,
  createConsoleLogger,
  formatConfigValue,
  type AdapterPreset,
  type ConfigOption,
} from "../index.ts";
import { runRepl } from "./repl.ts";
import { BOLD, DIM, colorEnabled, paint } from "./colors.ts";

interface Args {
  command: string;
  sessionId?: string;
  adapter: AdapterPreset;
  execPrefix: string[];
  cwd?: string;
  degraded: boolean;
  approve: boolean;
  verbose: boolean;
  debug: boolean;
  activity: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? "chat",
    adapter: "kimi",
    execPrefix: [],
    degraded: false,
    approve: false,
    verbose: false,
    debug: false,
    activity: true,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--adapter") a.adapter = argv[++i] as AdapterPreset;
    else if (arg === "--exec") a.execPrefix = (argv[++i] ?? "").split(" ").filter(Boolean);
    else if (arg === "--cwd") a.cwd = argv[++i];
    else if (arg === "--degraded") a.degraded = true;
    else if (arg === "--approve") a.approve = true;
    else if (arg === "--verbose" || arg === "-v") a.verbose = true;
    else if (arg === "--debug" || arg === "-d") a.debug = true;
    else if (arg === "--no-activity" || arg === "--disable-activity") a.activity = false;
    else if (arg && !arg.startsWith("--")) a.sessionId = arg;
  }
  return a;
}

async function chat(args: Args): Promise<void> {
  // Logging levels:
  //   default    → warn   (quiet — only warnings/errors)
  //   --verbose  → info   (lifecycle summaries: connect, session_new, prompt_end, …)
  //   --debug    → debug  (the above PLUS full protocol payloads + raw session updates)
  const minLevel = args.debug ? "debug" : args.verbose ? "info" : "warn";
  const logger = createConsoleLogger({ minLevel });

  const controller = new AgentController({
    adapters: ADAPTERS,
    initialAdapter: args.adapter,
    mode: args.degraded ? "degraded" : "normal",
    execPrefix: args.execPrefix,
    cwd: args.cwd,
    sessionId: args.sessionId,
    defaultPermission: args.approve ? "approve" : "cancel",
    logger,
  });

  const { sessionId, resumed } = await controller.start();
  const label = ADAPTERS[args.adapter].displayName ?? args.adapter;
  const intro = controller.isDegraded
    ? `degraded (pty) session (${label}) — no ACP capabilities · /exit to quit, Ctrl-C to interrupt`
    : `${resumed ? "resumed" : "new"} session ${sessionId} (${label}) — ` +
      `/exit to quit, Ctrl-C to interrupt`;

  const color = colorEnabled(process.stderr);
  const note = (s: string) => process.stderr.write(paint(color, DIM, s) + "\n");

  try {
    await runRepl(controller, {
      activity: args.activity,
      // Suppress the spinner under --debug: raw session_update lines would fight its \r.
      spinner: !args.debug,
      intro,
      onSlashCommand: async (command, commandArgs) => {
        switch (command) {
          case "help": {
            note(
              `commands: /help ${controller.getCommands().map((c) => c.usage).join(" ")} ` +
                `/degrade /upgrade /exit`,
            );
            const agentCmds = controller.agentCommands;
            if (agentCmds.length > 0) {
              note(`agent commands (send with //name): ${agentCmds.map((c) => `/${c.name}`).join(" ")}`);
            } else if (!controller.isDegraded) {
              note("agent commands: (none advertised) — //name still forwards a /name to the agent");
            } else {
              note("//name forwards a /name slash command to the agent's TUI");
            }
            return true;
          }
          case "caps": {
            if (controller.isDegraded) {
              note("degraded (pty) mode — no ACP capabilities; /upgrade to reconnect over ACP");
              return true;
            }
            const c = controller.capabilities.agent;
            note(
              `loadSession=${c.loadSession} image=${c.promptCapabilities.image} ` +
                `logout=${c.auth?.logout ?? false} list=${c.sessionCapabilities.list} ` +
                `config=[${[...controller.configOptions.keys()].join(",")}]`,
            );
            return true;
          }
          case "session":
            note(
              `${controller.currentSessionId ?? "(no session)"} ` +
                `(${controller.currentAdapterId}, ${controller.currentMode})`,
            );
            return true;
          case "login": {
            if (controller.isDegraded) {
              note("ACP login unavailable in degraded mode (terminal bridge not built yet)");
              return true;
            }
            const methods = controller.authMethods;
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
            if (methods.length > 0 && !methods.some((m) => m.id === methodId)) {
              note(`unknown method: ${methodId}`);
              note(`available: ${methods.map((m) => m.id).join(", ") || "(none)"}`);
              return true;
            }
            note(`authenticating with ${methodId}… (follow any URL/code shown below)`);
            try {
              await controller.authenticate(methodId, {
                // Tee the agent's stderr (login URL / device code) but drop the noise of a
                // raw JSON-RPC error dump on failure — we report the error ourselves.
                onOutput: (line) => {
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
              const result = await controller.newSession();
              note(`new session ${result.sessionId}`);
            } catch (e) {
              note(`could not start a new session: ${String(e)}`);
            }
            return true;
          }
          case "bridge": {
            try {
              await controller.bridge();
            } catch (e) {
              note(`bridge failed: ${String(e)}`);
            }
            return true;
          }
          case "degrade":
          case "upgrade": {
            const mode = command === "degrade" ? "degraded" : "normal";
            if (controller.currentMode === mode) {
              note(`already in ${mode} mode`);
              return true;
            }
            try {
              const result = await controller.setMode(mode);
              note(
                mode === "degraded"
                  ? `degraded to pty (${controller.currentAdapterId})`
                  : `upgraded to ACP, new session ${result.sessionId}`,
              );
            } catch (e) {
              note(`could not switch to ${mode}: ${String(e)}`);
            }
            return true;
          }
          case "sessions": {
            if (!controller.capabilities.agent.sessionCapabilities.list) {
              note("agent does not support session/list");
              return true;
            }
            const page = await controller.listSessions();
            if (page.sessions.length === 0) note("(no sessions)");
            for (const s of page.sessions) {
              note(`${s.sessionId}  ${s.title ?? ""}  ${s.updatedAt ?? ""}`);
            }
            return true;
          }
          case "load": {
            const target = commandArgs[0];
            if (!target) {
              note("usage: /load SESSION_ID");
              return true;
            }
            if (!controller.capabilities.agent.loadSession) {
              note("load not supported by this agent");
              return true;
            }
            const replay = createSessionReplayRenderer(color);
            clearTerminal();
            const result = await controller.loadSession(target, { onUpdate: replay.onUpdate });
            replay.finish();
            note(`loaded session ${result.sessionId}`);
            return true;
          }
          case "resume": {
            const target = commandArgs[0];
            if (!target) {
              note("usage: /resume SESSION_ID");
              return true;
            }
            if (!controller.capabilities.agent.sessionCapabilities.resume) {
              note("resume not supported by this agent");
              return true;
            }
            const result = await controller.resumeSession(target);
            note(`resumed session ${result.sessionId}`);
            return true;
          }
          case "fork": {
            const target = commandArgs[0];
            if (!target) {
              note("usage: /fork SESSION_ID");
              return true;
            }
            if (!controller.capabilities.agent.sessionCapabilities.fork) {
              note("fork not supported by this agent");
              return true;
            }
            const result = await controller.forkSession(target);
            note(`forked session ${target} -> ${result.sessionId}`);
            return true;
          }
          case "config": {
            const configId = commandArgs[0];
            if (!configId) {
              note(formatConfigList(controller.configOptions));
              return true;
            }

            const option = controller.configOptions.get(configId);
            if (!option) {
              note(`unknown config: ${configId}`);
              note(`available configs: ${[...controller.configOptions.keys()].join(", ") || "(none)"}`);
              return true;
            }

            const rawValue = commandArgs.slice(1).join(" ");
            if (!rawValue) {
              note(formatConfigDetail(option));
              return true;
            }

            const parsed = controller.parseConfigValue(configId, rawValue);
            if (!parsed.ok) {
              note(parsed.error);
              return true;
            }

            const result = await controller.setConfigFromString(configId, rawValue);
            note(`set ${configId}=${formatConfigValue(result.currentValue)}`);
            return true;
          }
          case "switch": {
            const target = commandArgs[0];
            if (!target) {
              note(`usage: /switch ADAPTER (${controller.adapterIds.join(", ")})`);
              return true;
            }
            if (!controller.hasAdapter(target)) {
              note(`unknown adapter: ${target}`);
              note(`available adapters: ${controller.adapterIds.join(", ")}`);
              return true;
            }
            if (target === controller.currentAdapterId) {
              note(`already using ${target}`);
              return true;
            }

            const switched = await controller.switchAdapter(target);
            const nextLabel = ADAPTERS[target as AdapterPreset]?.displayName ?? target;
            note(`switched to ${nextLabel}, new session ${switched.sessionId}`);
            return true;
          }
          default:
            return false; // unknown → treat as a normal prompt
        }
      },
    });
  } finally {
    await controller.stop();
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.command !== "chat") {
  console.error(`unknown command: ${args.command}`);
  process.exit(1);
}
await chat(args);

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

function createSessionReplayRenderer(color: boolean): {
  onUpdate(notification: unknown): void;
  finish(): void;
} {
  let currentRole: "user" | "agent" | null = null;
  let wrote = false;

  const label = (role: "user" | "agent") => {
    if (currentRole === role) return;
    if (wrote) process.stderr.write("\n");
    const text = role === "user" ? "you ›" : "agent ›";
    process.stderr.write(paint(color, BOLD, text) + " ");
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
