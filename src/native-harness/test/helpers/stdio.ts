import { HarnessClient, createStdioTransport } from "../../src/client.ts";
import type { ClientTransport, RpcNotification, RpcResponse } from "../../src/contracts/protocol.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Record everything the transport delivers, in wire order. A client resolves
 * responses a microtask after listeners run, so only this log shows the order
 * in which a response and the notifications around it actually arrived. */
export function recordWire(transport: ClientTransport) {
  const wire: (RpcResponse | RpcNotification)[] = [];
  transport.subscribe(message => { wire.push(message); });
  return wire;
}

export interface SpawnOptions { home?: string; fault?: string; effects?: string; requests?: string; stallChannel?: string; snapshotLog?: string; streamResponses?: boolean; modelTimeoutMs?: number; reminderTime?: number; providerEndpoint?: string; webEndpoint?: string; exaKey?: string; pathOverride?: string; extraCaCerts?: string }
export function spawnHarness(options: SpawnOptions = {}) {
  const temporaryHome = options.home ? undefined : mkdtempSync(join(tmpdir(), "harness-stdio-"));
  const child = Bun.spawn([process.execPath, new URL("../../src/interfaces/cli/main.ts", import.meta.url).pathname, "serve", "--stdio",
    "--home", options.home ?? temporaryHome!], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: options.extraCaCerts ?? process.env.NODE_EXTRA_CA_CERTS, PATH: options.pathOverride ?? process.env.PATH, OPENROUTER_API_KEY: options.providerEndpoint ? "fixture-key" : undefined, HARNESS_TEST_PROVIDER_ENDPOINT: options.providerEndpoint, HARNESS_TEST_WEB_ENDPOINT: options.webEndpoint, EXA_API_KEY: options.exaKey, HARNESS_TEST_FAULT: options.fault, HARNESS_TEST_EFFECTS: options.effects, HARNESS_TEST_REQUESTS: options.requests, HARNESS_TEST_STALL_CHANNEL: options.stallChannel, HARNESS_TEST_SNAPSHOT_LOG: options.snapshotLog, HARNESS_TEST_STREAM_RESPONSES: options.streamResponses ? "1" : undefined, HARNESS_TEST_MODEL_TIMEOUT_MS: options.modelTimeoutMs?.toString(), HARNESS_TEST_REMINDER_TIME: options.reminderTime?.toString() },
  });
  const [protocol, capture] = child.stdout.tee();
  const stdout = new Response(capture).text();
  const stderr = new Response(child.stderr).text();
  const transport = createStdioTransport({ readable: protocol, exited: child.exited,
    async write(bytes) { child.stdin.write(bytes); await child.stdin.flush(); },
    async end() { await child.stdin.end(); },
  });
  const wire = recordWire(transport);
  const client = new HarnessClient(transport, 2000);
  if (temporaryHome) void child.exited.then(() => rmSync(temporaryHome, { recursive: true, force: true }));
  return {
    client, child, stdout, stderr, wire,
    async close() {
      client.close();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        const code = await child.exited;
        if (code !== 0) throw new Error(`Harness exit ${code}: ${await stderr}`);
        for (const line of (await stdout).trim().split("\n").filter(Boolean)) JSON.parse(line);
      } finally { clearTimeout(timer); child.kill(); }
    },
  };
}
