import { HarnessClient, createStdioTransport } from "../../src/client.ts";

export function spawnHarness() {
  const child = Bun.spawn([process.execPath, new URL("../../src/interfaces/cli/main.ts", import.meta.url).pathname, "serve", "--stdio"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENROUTER_API_KEY: undefined },
  });
  const [protocol, capture] = child.stdout.tee();
  const stdout = new Response(capture).text();
  const stderr = new Response(child.stderr).text();
  const transport = createStdioTransport({ readable: protocol, exited: child.exited,
    async write(bytes) { child.stdin.write(bytes); await child.stdin.flush(); },
    async end() { await child.stdin.end(); },
  });
  const client = new HarnessClient(transport, 2000);
  return {
    client, child, stdout, stderr,
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
