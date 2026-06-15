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
  AcpClient,
  ADAPTERS,
  createConsoleLogger,
  type AgentClient,
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
  if (args.degraded) {
    console.error("degraded mode is not implemented yet (deferred).");
    process.exit(1);
  }

  // Logging levels:
  //   default    → warn   (quiet — only warnings/errors)
  //   --verbose  → info   (lifecycle summaries: connect, session_new, prompt_end, …)
  //   --debug    → debug  (the above PLUS full protocol payloads + raw session updates)
  const minLevel = args.debug ? "debug" : args.verbose ? "info" : "warn";
  const logger = createConsoleLogger({ minLevel });

  const client = new AcpClient({
    adapter: ADAPTERS[args.adapter],
    execPrefix: args.execPrefix,
    cwd: args.cwd,
    sessionId: args.sessionId,
    defaultPermission: args.approve ? "approve" : "cancel",
    logger,
  });

  await client.connect();
  const { sessionId, resumed } = await client.startSession();
  let current = client;
  let currentAdapter = args.adapter;
  const proxy: AgentClient = {
    prompt: (...promptArgs) => current.prompt(...promptArgs),
    interrupt: (...interruptArgs) => current.interrupt(...interruptArgs),
    stop: () => current.stop(),
  };
  const label = ADAPTERS[args.adapter].displayName ?? args.adapter;
  const intro =
    `${resumed ? "resumed" : "new"} session ${sessionId} (${label}) — ` +
    `/exit to quit, Ctrl-C to interrupt`;

  const color = colorEnabled(process.stderr);
  const note = (s: string) => process.stderr.write(paint(color, DIM, s) + "\n");

  try {
    await runRepl(proxy, {
      activity: args.activity,
      // Suppress the spinner under --debug: raw session_update lines would fight its \r.
      spinner: !args.debug,
      intro,
      onSlashCommand: async (command, commandArgs) => {
        switch (command) {
          case "help":
            note("commands: /help /caps /session /sessions /config [CONFIG_ID [VALUE]] /load SESSION_ID /resume SESSION_ID /fork SESSION_ID /switch ADAPTER /exit");
            return true;
          case "caps": {
            const c = current.capabilities.agent;
            note(
              `loadSession=${c.loadSession} image=${c.promptCapabilities.image} ` +
                `logout=${c.auth?.logout ?? false} list=${c.sessionCapabilities.list} ` +
                `config=[${[...current.configOptions.keys()].join(",")}]`,
            );
            return true;
          }
          case "session":
            note(`${current.currentSessionId} (${currentAdapter})`);
            return true;
          case "sessions": {
            if (!current.capabilities.agent.sessionCapabilities.list) {
              note("agent does not support session/list");
              return true;
            }
            const page = await current.listSessions();
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
            if (!current.capabilities.agent.loadSession) {
              note("load not supported by this agent");
              return true;
            }
            const replay = createSessionReplayRenderer(color);
            clearTerminal();
            const result = await current.loadSession(target, { onUpdate: replay.onUpdate });
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
            if (!current.capabilities.agent.sessionCapabilities.resume) {
              note("resume not supported by this agent");
              return true;
            }
            const result = await current.resumeSession(target);
            note(`resumed session ${result.sessionId}`);
            return true;
          }
          case "fork": {
            const target = commandArgs[0];
            if (!target) {
              note("usage: /fork SESSION_ID");
              return true;
            }
            if (!current.capabilities.agent.sessionCapabilities.fork) {
              note("fork not supported by this agent");
              return true;
            }
            const result = await current.forkSession(target);
            note(`forked session ${target} -> ${result.sessionId}`);
            return true;
          }
          case "config": {
            const configId = commandArgs[0];
            if (!configId) {
              note(formatConfigList(current.configOptions));
              return true;
            }

            const option = current.configOptions.get(configId);
            if (!option) {
              note(`unknown config: ${configId}`);
              note(`available configs: ${[...current.configOptions.keys()].join(", ") || "(none)"}`);
              return true;
            }

            const rawValue = commandArgs.slice(1).join(" ");
            if (!rawValue) {
              note(formatConfigDetail(option));
              return true;
            }

            const parsed = parseConfigValue(option, rawValue);
            if (!parsed.ok) {
              note(parsed.error);
              return true;
            }

            await current.setConfig(configId, parsed.value);
            const updated = current.configOptions.get(configId);
            note(`set ${configId}=${formatValue(updated?.currentValue ?? parsed.value)}`);
            return true;
          }
          case "switch": {
            const target = commandArgs[0];
            if (!target) {
              note(`usage: /switch ADAPTER (${availableAdapters()})`);
              return true;
            }
            if (!isAdapterPreset(target)) {
              note(`unknown adapter: ${target}`);
              note(`available adapters: ${availableAdapters()}`);
              return true;
            }
            if (target === currentAdapter) {
              note(`already using ${target}`);
              return true;
            }

            const next = new AcpClient({
              adapter: ADAPTERS[target],
              execPrefix: args.execPrefix,
              cwd: args.cwd,
              defaultPermission: args.approve ? "approve" : "cancel",
              logger,
            });
            let switched;
            try {
              await next.connect();
              switched = await next.startSession();
            } catch (err) {
              await next.stop();
              throw err;
            }

            const previous = current;
            current = next;
            currentAdapter = target;
            await previous.stop();

            const nextLabel = ADAPTERS[target].displayName ?? target;
            note(`switched to ${nextLabel}, new session ${switched.sessionId}`);
            return true;
          }
          default:
            return false; // unknown → treat as a normal prompt
        }
      },
    });
  } finally {
    await current.stop();
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

function isAdapterPreset(value: string): value is AdapterPreset {
  return Object.hasOwn(ADAPTERS, value);
}

function availableAdapters(): string {
  return Object.keys(ADAPTERS).join(", ");
}

function formatConfigList(configOptions: Map<string, ConfigOption>): string {
  if (configOptions.size === 0) return "no config options advertised by this session";
  return [...configOptions.values()]
    .map((option) => {
      const label = option.label ? ` (${option.label})` : "";
      return `${option.configId}${label}  ${option.type}  current=${formatValue(option.currentValue)}`;
    })
    .join("\n");
}

function formatConfigDetail(option: ConfigOption): string {
  const lines = [
    `${option.configId}${option.label ? `: ${option.label}` : ""}`,
    `type: ${option.type}`,
    `current: ${formatValue(option.currentValue)}`,
  ];
  if (option.description) lines.push(`description: ${option.description}`);
  if (option.allowedValues?.length) {
    lines.push(`values: ${option.allowedValues.map((choice) => formatValue(choice.value)).join(", ")}`);
  }
  return lines.join("\n");
}

function parseConfigValue(
  option: ConfigOption,
  rawValue: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (option.type) {
    case "boolean": {
      const value = parseBoolean(rawValue);
      if (value == null) return { ok: false, error: `invalid boolean: ${rawValue}` };
      return { ok: true, value };
    }
    case "select": {
      const choice = option.allowedValues?.find((c) => String(c.value) === rawValue);
      if (!choice) {
        const allowed = option.allowedValues?.map((c) => formatValue(c.value)).join(", ") || "(none)";
        return {
          ok: false,
          error: `invalid value "${rawValue}" for ${option.configId}; allowed: ${allowed}`,
        };
      }
      return { ok: true, value: choice.value };
    }
    default:
      return { ok: true, value: parseJsonOrString(rawValue) };
  }
}

function parseBoolean(value: string): boolean | null {
  switch (value.toLowerCase()) {
    case "true":
    case "on":
    case "yes":
    case "1":
      return true;
    case "false":
    case "off":
    case "no":
    case "0":
      return false;
    default:
      return null;
  }
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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
