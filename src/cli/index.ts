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
  type AdapterPreset,
} from "../index.ts";
import { createAgentCommands, runRepl } from "../repl/index.ts";
import { DIM, colorEnabled, paint } from "./colors.ts";

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
    adapter: ADAPTERS[args.adapter],
    adapterId: args.adapter,
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

  const commands = createAgentCommands({ client: controller, note, color });

  try {
    await runRepl(controller, {
      activity: args.activity,
      // Suppress the spinner under --debug: raw session_update lines would fight its \r.
      spinner: !args.debug,
      intro,
      onSlashCommand: commands.onSlashCommand,
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
