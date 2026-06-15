#!/usr/bin/env bun
// Thin CLI entry — arg parsing + wiring only. Imports the public library like any
// external caller and owns NO protocol logic. The interactive loop lives in ./repl.ts.
// See SPEC.md "library first, CLI second".
//
// Usage:
//   acp-lib chat [SESSION_ID] [--adapter kimi] [--exec "docker exec -i <ctr>"]
//                [--cwd /workspace] [--approve] [--verbose] [--degraded]

import {
  AcpClient,
  ADAPTERS,
  createConsoleLogger,
  type AdapterPreset,
} from "../index.ts";
import { runRepl } from "./repl.ts";
import { DIM, RESET } from "./colors.ts";

interface Args {
  command: string;
  sessionId?: string;
  adapter: AdapterPreset;
  execPrefix: string[];
  cwd?: string;
  degraded: boolean;
  approve: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? "chat",
    adapter: "kimi",
    execPrefix: [],
    degraded: false,
    approve: false,
    verbose: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--adapter") a.adapter = argv[++i] as AdapterPreset;
    else if (arg === "--exec") a.execPrefix = (argv[++i] ?? "").split(" ").filter(Boolean);
    else if (arg === "--cwd") a.cwd = argv[++i];
    else if (arg === "--degraded") a.degraded = true;
    else if (arg === "--approve") a.approve = true;
    else if (arg === "--verbose" || arg === "-v") a.verbose = true;
    else if (arg && !arg.startsWith("--")) a.sessionId = arg;
  }
  return a;
}

async function chat(args: Args): Promise<void> {
  if (args.degraded) {
    console.error("degraded mode is not implemented yet (deferred).");
    process.exit(1);
  }

  // --verbose surfaces the ACP protocol lifecycle (and agent stderr). Without it the
  // library logs only warnings/errors, keeping the chat clean.
  const logger = createConsoleLogger({ minLevel: args.verbose ? "debug" : "warn" });

  const client = new AcpClient({
    adapter: ADAPTERS[args.adapter],
    execPrefix: args.execPrefix,
    cwd: args.cwd,
    sessionId: args.sessionId,
    defaultPermission: args.approve ? "approve" : "cancel",
    logger,
  });

  const { sessionId, resumed } = await client.connect();
  const label = ADAPTERS[args.adapter].displayName ?? args.adapter;
  const intro =
    `${DIM}${resumed ? "resumed" : "new"} session ${sessionId} (${label}) — ` +
    `/exit to quit, Ctrl-C to interrupt${RESET}`;

  try {
    await runRepl(client, { verbose: args.verbose, intro });
  } finally {
    await client.stop();
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.command !== "chat") {
  console.error(`unknown command: ${args.command}`);
  process.exit(1);
}
await chat(args);
