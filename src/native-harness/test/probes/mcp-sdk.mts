// Run from an isolated npm install containing @modelcontextprotocol/sdk@1.31.0.
// Copy this probe beside node_modules before running it with Bun.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Message = Record<string, any>;
const revision = process.argv.find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? "2025-11-25";
function serve(m: Message, emit: (message: Message) => void) {
  if (m.method === "initialize") emit({id:m.id,result:{protocolVersion:revision,capabilities:{tools:{}},serverInfo:{name:"probe",version:"1"}}});
  if (m.method === "tools/list") emit({id:m.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}});
  if (m.method === "tools/call") {
    if (m.params.arguments.mode === "quick") emit({id:m.id,result:{content:[{type:"text",text:"ok"}]}});
    else {
      const token = m.params._meta.progressToken;
      emit({method:"notifications/progress",params:{progressToken:token,progress:1}});
      setTimeout(() => emit({id:m.id,result:{content:[{type:"text",text:"late"}]}}),350);
    }
  }
}

if (process.argv.includes("--server")) {
  const { createInterface } = await import("node:readline");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const m = JSON.parse(line);
    if (m.method === "notifications/cancelled") process.stderr.write(JSON.stringify(m) + "\n");
    serve(m, (msg) => process.stdout.write(JSON.stringify({ jsonrpc:"2.0", ...msg }) + "\n"));
  }
  process.exit(0);
}

const wire: Message[] = [];
const child = Bun.spawn([process.execPath, import.meta.path, "--server", revision], {
  stdin:"pipe", stdout:"pipe", stderr:"pipe", env:{},
});
const cancellations = new Response(child.stderr).text();
const stdio = {
  onmessage: undefined as ((message: any) => void) | undefined,
  onerror: undefined as ((error: Error) => void) | undefined,
  async start() {
    void (async () => {
      let remainder = "";
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        remainder += chunk;
        if (remainder.length > 65536) throw new Error("Probe frame too large");
        let end: number;
        while ((end = remainder.indexOf("\n")) >= 0) {
          this.onmessage?.(JSON.parse(remainder.slice(0,end)));
          remainder = remainder.slice(end+1);
        }
      }
    })().catch((error) => this.onerror?.(error));
  },
  async send(message: Message) { wire.push(message); child.stdin.write(JSON.stringify(message)+"\n"); await child.stdin.flush(); },
  async close() { child.stdin.end(); child.kill(); await child.exited; },
};

async function exercise(transport: Parameters<Client["connect"]>[0], sent: Message[]) {
  const client = new Client({name:"probe",version:"1"}, {capabilities:{}});
  try {
    await client.connect(transport, {timeout:2000});
    assert.equal((await client.listTools(undefined,{timeout:1000})).tools[0]?.name,"echo");
    for (const abort of [true,false]) {
      const controller = new AbortController();
      let progress = 0;
      await assert.rejects(client.callTool({name:"echo",arguments:{mode:"pending"}},undefined,{
        timeout:150, signal:controller.signal, resetTimeoutOnProgress:false,
        onprogress: () => { progress++; if (abort) controller.abort(); },
      }));
      assert.equal(progress, 1);
      const request = sent.findLast(m => m.method === "tools/call");
      const stop = performance.now()+1000;
      while (!sent.some(m => m.method === "notifications/cancelled" && m.params.requestId === request?.id)) {
        assert.ok(performance.now() < stop,"cancellation frame missing");
        await Bun.sleep(5);
      }
      const quick = await client.callTool({name:"echo",arguments:{mode:"quick"}},undefined,{timeout:1000});
      assert.deepEqual(quick.content,[{type:"text",text:"ok"}]);
    }
  } finally { await client.close(); }
}

await exercise(stdio,wire);
const observed = (await cancellations).trim().split("\n").map(line => JSON.parse(line).params.requestId);
assert.deepEqual(observed,wire.filter(m => m.method === "notifications/cancelled").map(m => m.params.requestId));
console.log(revision, "stdio: negotiated, discovered, progress, abort and timeout cancellation received");

const dir = mkdtempSync(join(tmpdir(),"mcp-sdk-"));
try {
  const cert = join(dir,"cert.pem"), key = join(dir,"key.pem");
  const openssl = Bun.spawnSync(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,
    "-days","1","-subj","/CN=localhost","-addext","subjectAltName=IP:127.0.0.1"],{stdout:"ignore",stderr:"ignore"});
  assert.equal(openssl.exitCode,0);
  const requests: Message[] = [];
  const server = Bun.serve({hostname:"127.0.0.1",port:0,tls:{key:Bun.file(key),cert:Bun.file(cert)},async fetch(req) {
    assert.equal(req.headers.get("authorization"),"Bearer fixture-only");
    if (req.method !== "POST") return new Response(null,{status:405});
    const message = await req.json() as Message;
    requests.push(message);
    if (message.id === undefined) return new Response(null,{status:202});
    let closed = false;
    return new Response(new ReadableStream({
      start(controller) {
        serve(message,(msg) => {
          if (closed) return;
          controller.enqueue(new TextEncoder().encode("data: "+JSON.stringify({jsonrpc:"2.0",...msg})+"\n\n"));
          if ("id" in msg) controller.close();
        });
      },
      cancel() { closed = true; },
    }),{headers:{"Content-Type":"text/event-stream"}});
  }});
  try {
    const url = new URL("/mcp",server.url);
    await exercise(new StreamableHTTPClientTransport(url,{
      requestInit:{headers:{authorization:"Bearer fixture-only"}},
      fetch: async (input,init) => {
        assert.equal(String(input),url.href);
        const response = await fetch(input,{...init,redirect:"error",tls:{ca:readFileSync(cert,"utf8")}});
        if (!response.body) return response;
        let bytes = 0;
        return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 65536) throw new Error("Probe HTTP body too large");
            controller.enqueue(chunk);
          },
        })), { status: response.status, headers: response.headers });
      },
    }),requests);
    console.log(revision, "HTTPS: negotiated, discovered, streamed progress, abort and timeout cancellation received");
  } finally { await server.stop(true); }
} finally { rmSync(dir,{recursive:true,force:true}); }
