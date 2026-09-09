#!/usr/bin/env bun
// Thin CLI entry — arg parsing + wiring only. Imports the public library like any
// external caller and owns NO protocol logic. The interactive loop lives in ./repl.ts.
// See SPEC.md "library first, CLI second".
//
// Usage:
//   acp-client chat [SESSION_ID] [--adapter kimi] [--exec "docker exec -i <ctr>"]
//                [--cwd /workspace] [--approve] [--verbose] [--debug]
//                [--no-activity] [--degraded] [--wire[=FILE]]
//   acp-client chat [--adapter ID] --adapter-command '["agent","--acp"]'
//                [--pty-command '["agent"]'] [--adapter-name "My Agent"]
//   acp-client sessions [--root PATH] [--all] [--json]
//   acp-client delete AGENT_SESSION_ID [--root PATH] [--delete-transcript]
//                [--delete-audit-log] [--remove-registry-entry] [--yes]
//
//   activity (thinking/tool markers) shows by DEFAULT; --no-activity disables it.
//   --verbose (-v): lifecycle summaries (connect, session_new, prompt_end)
//   --debug   (-d): the above PLUS raw protocol payloads (initialize/prompt/session_update)
//   --wire       : dump every raw protocol line, both directions, to stderr
//   --wire=FILE  : the same as ndjson in FILE (truncated per run) instead of stderr

import {
  AgentController,
  createConsoleLogger,
  createWireLog,
  type Adapter,
} from "../index.ts";
import { createControllerCommands, runRepl } from "../repl/index.ts";
import { DIM, colorEnabled, paint } from "../repl/colors.ts";
import { parseCommandArg, resolveCliAdapter } from "./adapter.ts";
import {
  ManagedCliUsageError,
  parseManagedCliCommand,
  runManagedCliCommand,
} from "./managed.ts";

interface Args {
  command: string;
  sessionId?: string;
  adapterId?: string;
  adapterCommand?: string[];
  ptyCommand?: string[];
  adapterName?: string;
  execPrefix: string[];
  cwd?: string;
  degraded: boolean;
  approve: boolean;
  verbose: boolean;
  debug: boolean;
  activity: boolean;
  /** undefined = off, "" = stderr, otherwise a file path. */
  wire?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? "chat",
    execPrefix: [],
    degraded: false,
    approve: false,
    verbose: false,
    debug: false,
    activity: true,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--adapter") a.adapterId = argv[++i];
    else if (arg === "--adapter-command") {
      a.adapterCommand = parseCommandArg(argv[++i], "--adapter-command");
    }
    else if (arg === "--pty-command") {
      a.ptyCommand = parseCommandArg(argv[++i], "--pty-command");
    }
    else if (arg === "--adapter-name") a.adapterName = argv[++i];
    else if (arg === "--exec") a.execPrefix = (argv[++i] ?? "").split(" ").filter(Boolean);
    else if (arg === "--cwd") a.cwd = argv[++i];
    else if (arg === "--degraded") a.degraded = true;
    else if (arg === "--approve") a.approve = true;
    else if (arg === "--verbose" || arg === "-v") a.verbose = true;
    else if (arg === "--debug" || arg === "-d") a.debug = true;
    else if (arg === "--no-activity" || arg === "--disable-activity") a.activity = false;
    else if (arg === "--wire") a.wire = "";
    else if (arg?.startsWith("--wire=")) a.wire = arg.slice("--wire=".length);
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

  // A wire dump to stderr would fight the spinner's \r and the streamed reply, so the
  // file form is the usable one for a real conversation.
  const wire =
    args.wire === undefined
      ? undefined
      : args.wire === ""
        ? createWireLog({ console: "stderr" })
        : createWireLog({ path: args.wire });
  if (args.wire) process.stderr.write(`wire log: ${args.wire}\n`);

  const resolved = resolveCliAdapter({
    adapterId: args.adapterId,
    command: args.adapterCommand,
    ptyCommand: args.ptyCommand,
    displayName: args.adapterName,
  });
  const adapter: Adapter = resolved.adapter;
  const controller = new AgentController({
    adapter,
    adapterId: resolved.adapterId,
    mode: args.degraded ? "degraded" : "normal",
    execPrefix: args.execPrefix,
    cwd: args.cwd,
    sessionId: args.sessionId,
    defaultPermission: args.approve ? "approve" : "cancel",
    logger,
    wire,
  });

  const { sessionId, resumed } = await controller.start();
  const label = adapter.displayName ?? resolved.adapterId;
  const intro = controller.isDegraded
    ? `degraded (pty) session (${label}) — no ACP capabilities · /exit to quit, Ctrl-C to interrupt`
    : `${resumed ? "resumed" : "new"} session ${sessionId} (${label}) — ` +
      `/exit to quit, Ctrl-C to interrupt`;

  const color = colorEnabled(process.stderr);
  const note = (s: string) => process.stderr.write(paint(color, DIM, s) + "\n");

  const commands = createControllerCommands({
    client: controller,
    note,
    color,
    adapterId: resolved.adapterId,
  });

  try {
    await runRepl(controller, {
      activity: args.activity,
      // Suppress the spinner when raw lines are going to the terminal — they fight its \r.
      spinner: !args.debug && args.wire !== "",
      intro,
      onSlashCommand: commands.onSlashCommand,
    });
  } finally {
    await controller.stop();
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "sessions" || argv[0] === "delete") {
  try {
    await runManagedCliCommand(parseManagedCliCommand(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ManagedCliUsageError ? 2 : 1;
  }
} else {
  const args = parseArgs(argv);
  if (args.command !== "chat") {
    console.error(`unknown command: ${args.command}`);
    process.exitCode = 2;
  } else {
    await chat(args);
  }
}
