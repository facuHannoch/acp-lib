import { HarnessClient, createStdioTransport } from "../../src/client.ts";
import type { ClientTransport, RpcNotification, RpcResponse } from "../../src/contracts/protocol.ts";

/** Record everything the transport delivers, in wire order. A client resolves
 * responses a microtask after listeners run, so only this log shows the order
 * in which a response and the notifications around it actually arrived. */
export function recordWire(transport: ClientTransport) {
  const wire: (RpcResponse | RpcNotification)[] = [];
  transport.subscribe(message => { wire.push(message); });
  return wire;
}

export interface SpawnOptions { home?: string; fault?: string; effects?: string }
export function spawnHarness(options: SpawnOptions = {}) {
  const child = Bun.spawn([process.execPath, new URL("../../src/interfaces/cli/main.ts", import.meta.url).pathname, "serve", "--stdio",
    ...(options.home ? ["--home", options.home] : [])], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, OPENROUTER_API_KEY: undefined, HARNESS_TEST_FAULT: options.fault, HARNESS_TEST_EFFECTS: options.effects },
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
