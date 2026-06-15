import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "child_process";

const stdinTransform = new TransformStream();

const proc = Bun.spawn(["docker", "exec", "-u", "devuser", "-i", "agents-atlas-a-4a9a77", "kimi", "acp"], {
  stdin: stdinTransform.readable,
  stdout: "pipe",
  stderr: "pipe",
});

// Print stderr
(async () => {
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process.stdout.write("[stderr] " + dec.decode(value));
  }
})();

const stream = acp.ndJsonStream(stdinTransform.writable, proc.stdout);

class Handler {
  async sessionUpdate(params) {
    console.log("[update]", JSON.stringify(params));
  }
  async requestPermission(params) {
    console.log("[permission]", JSON.stringify(params));
    return { outcome: { outcome: "cancelled" } };
  }
  async readTextFile() { return { content: "" }; }
  async writeTextFile() { return {}; }
}

const conn = new acp.ClientSideConnection(() => new Handler(), stream);

// initialize
console.log("\n--- initialize ---");
const init = await conn.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  clientInfo: { name: "acp-lib", title: "ACP Lib", version: "0.1.0" },
});
console.log(JSON.stringify(init, null, 2));

// session/new
console.log("\n--- session/new ---");
const session = await conn.newSession({ cwd: "/workspace", mcpServers: [] });
console.log(JSON.stringify(session, null, 2));
const sessionId = session.sessionId;

// session/prompt
console.log("\n--- prompt ---");
const result = await conn.prompt({
  sessionId,
  prompt: [{ type: "text", text: "You have a 3-litre jug and a 5-litre jug. How do you measure exactly 4 litres? Think step by step." }],
});
console.log(JSON.stringify(result, null, 2));

proc.kill();
