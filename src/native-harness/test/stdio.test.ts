import { expect, test } from "bun:test";
import { LineDecoder, LineWriter } from "../src/interfaces/protocol/framing.ts";
import { HarnessClient, createStdioTransport } from "../src/client.ts";
import { serveProtocolStdio } from "../src/interfaces/protocol/stdio-server.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import { createInProcessTransport } from "../src/client.ts";

test("framing handles byte-fragmented UTF-8, CRLF, multiple lines and bounded incomplete frames", () => {
  const decoder = new LineDecoder(); const lines: string[] = [];
  for (const byte of new TextEncoder().encode('{"text":"你好"}\r\n\n{}\n')) lines.push(...decoder.push(new Uint8Array([byte])));
  expect(lines).toEqual(['{"text":"你好"}', '{}']); decoder.finish();
  const partial = new LineDecoder(); partial.push(new TextEncoder().encode("{"));
  expect(() => partial.finish()).toThrow("Incomplete");
  expect(() => new LineDecoder(3).push(new TextEncoder().encode("1234"))).toThrow("size limit");
});

test("writer serializes asynchronous writes and surfaces backpressure failures", async () => {
  const written: string[] = []; let active = false;
  const writer = new LineWriter(async bytes => {
    expect(active).toBe(false); active = true;
    await Promise.resolve(); written.push(new TextDecoder().decode(bytes)); active = false;
  });
  await Promise.all([writer.send({ n: 1 }), writer.send({ n: 2 })]);
  expect(written).toEqual(['{"n":1}\n', '{"n":2}\n']);
  await expect(new LineWriter(async () => { throw new Error("broken pipe"); }).send({})).rejects.toThrow("broken pipe");
});

test("malformed server output immediately rejects pending and future requests", async () => {
  for (const bad of ['not json\n', '{"jsonrpc":"2.0","id":1}\n', '{"jsonrpc":"2.0","method":"channel/event","params":{}}\n']) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const client = new HarnessClient(createStdioTransport({ readable: stream, async write() {}, end() {} }), 1000);
    const request = client.idle(); controller.enqueue(new TextEncoder().encode(bad));
    await expect(request).rejects.toMatchObject({ code: "transport_closed" });
    await expect(client.idle()).rejects.toMatchObject({ code: "transport_closed" });
    client.close();
  }
});

test("child death rejects pending requests without waiting for the request timeout", async () => {
  const harness = spawnHarness();
  // The real child may answer a normal request immediately; queue a request and
  // kill it synchronously before the writer can dispatch to the process.
  const request = harness.client.initialize();
  harness.child.kill("SIGKILL");
  try { await expect(request).rejects.toMatchObject({ code: "transport_closed" }); }
  finally { harness.client.close(); await harness.child.exited; }
}, 5000);

test("server recovers from a malformed JSON line, keeps stdout clean and exits on EOF", async () => {
  const child = Bun.spawn([process.execPath, new URL("../src/interfaces/cli/main.ts", import.meta.url).pathname, "serve", "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    child.stdin.write('bad json\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"host":{"name":"test","version":"0"},"callbacks":[],"subscription":{"text":"final","tools":"full"}}}\n');
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    const messages = (await output).trim().split("\n").map(line => JSON.parse(line));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(messages[1]).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    expect(await errors).toBe("");
  } finally { clearTimeout(timer); child.kill(); }
}, 5000);

test("EOF shutdown fails within its grace period when accepted work never becomes idle", async () => {
  await expect(serveProtocolStdio({ subscribe: () => () => {}, request: async request => ({ jsonrpc: "2.0", id: request.id, result: { idle: false } }) },
    new ReadableStream({ start(controller) { controller.close(); } }), async () => {}, 20)).rejects.toThrow("shutdown grace expired");
});

test("transport closure and writer failure promptly reject outstanding requests", async () => {
  const local = createInProcessTransport({ subscribe: () => () => {}, request: () => new Promise(() => {}) });
  const client = new HarnessClient(local, 1000);
  const pending = client.idle(); local.close();
  await expect(pending).rejects.toMatchObject({ code: "transport_closed" });
  const broken = new HarnessClient(createStdioTransport({ readable: new ReadableStream(),
    async write() { throw new Error("broken pipe"); }, end() {},
  }), 1000);
  await expect(broken.idle()).rejects.toMatchObject({ code: "transport_closed" });
  client.close(); broken.close();
});

test("server waits for accepted work after EOF and flushes output before returning", async () => {
  let idle = false;
  const frames: string[] = [];
  const endpoint = { subscribe(listener: (message: any) => void) {
    const timer = setTimeout(() => {
      listener({ jsonrpc: "2.0", method: "channel/event", params: { channel: "a", event: { type: "turn_ended", turnId: "1", outcome: "completed" } } });
      idle = true;
    }, 20);
    return () => clearTimeout(timer);
  }, request: async (request: any) => ({ jsonrpc: "2.0" as const, id: request.id, result: { idle } }) };
  await serveProtocolStdio(endpoint, new ReadableStream({ start(c) { c.close(); } }), async bytes => { frames.push(new TextDecoder().decode(bytes)); }, 1000);
  expect(idle).toBe(true);
  expect(frames).toHaveLength(1);
  expect(JSON.parse(frames[0]!).params.event.type).toBe("turn_ended");
});

test("unterminated stdin frame produces a nonzero exit with diagnostics only on stderr", async () => {
  const child = Bun.spawn([process.execPath, new URL("../src/interfaces/cli/main.ts", import.meta.url).pathname, "serve", "--stdio"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    child.stdin.write('{"jsonrpc":'); await child.stdin.end();
    expect(await child.exited).toBe(1);
    expect(await output).toBe("");
    expect(await errors).toContain("Incomplete protocol frame");
  } finally { clearTimeout(timer); child.kill(); }
}, 5000);
