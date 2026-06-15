#!/usr/bin/env bun
// Thin CLI consumer — imports the public library like any external caller and owns NO
// logic of its own. Mainly for exercising the library by hand. See SPEC.md "library
// first, CLI second".
//
// Usage:
//   acp-lib chat [SESSION_ID] [--adapter kimi] [--exec "docker exec -i <ctr>"]
//                [--cwd /workspace] [--degraded] [--approve]

import { AcpClient, ADAPTERS, type AdapterPreset } from "../index.ts";

interface Args {
  command: string;
  sessionId?: string;
  adapter: AdapterPreset;
  execPrefix: string[];
  cwd?: string;
  degraded: boolean;
  approve: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? "chat",
    adapter: "kimi",
    execPrefix: [],
    degraded: false,
    approve: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--adapter") a.adapter = argv[++i] as AdapterPreset;
    else if (arg === "--exec") a.execPrefix = (argv[++i] ?? "").split(" ").filter(Boolean);
    else if (arg === "--cwd") a.cwd = argv[++i];
    else if (arg === "--degraded") a.degraded = true;
    else if (arg === "--approve") a.approve = true;
    else if (arg && !arg.startsWith("--")) a.sessionId = arg;
  }
  return a;
}

async function chat(args: Args): Promise<void> {
  if (args.degraded) {
    console.error("degraded mode is not implemented yet (deferred).");
    process.exit(1);
  }

  const client = new AcpClient({
    adapter: ADAPTERS[args.adapter],
    execPrefix: args.execPrefix,
    cwd: args.cwd,
    sessionId: args.sessionId,
    defaultPermission: args.approve ? "approve" : "cancel",
  });

  const { sessionId, resumed } = await client.connect();
  console.error(`[${resumed ? "resumed" : "new"}] session ${sessionId}`);
  console.error(
    `[caps] loadSession=${client.capabilities.agent.loadSession} ` +
      `image=${client.capabilities.agent.promptCapabilities.image} ` +
      `configOptions=${[...client.configOptions.keys()].join(",") || "none"}`,
  );

  const prompt = "Reply with exactly: hello from acp-lib";
  console.error(`> ${prompt}\n`);
  const result = await client.prompt(prompt, {
    onChunk: (t) => process.stdout.write(t),
    onActivity: (e) => console.error(`\n[activity] ${e.kind}`),
  });
  console.error(
    `\n\n[done] status=${result.status} stopReason=${result.stopReason} ` +
      `chars=${result.text.length}`,
  );
  await client.stop();
}

const args = parseArgs(process.argv.slice(2));
if (args.command !== "chat") {
  console.error(`unknown command: ${args.command}`);
  process.exit(1);
}
await chat(args);
