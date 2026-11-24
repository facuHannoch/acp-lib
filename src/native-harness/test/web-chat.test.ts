import { expect, test } from "bun:test";
import { serveWebChat } from "../src/interfaces/web-chat/server.ts";
import { createChannelHandler } from "../src/interfaces/protocol/local.ts";
import { createChannelOutputs, publishChannelEvent } from "../src/interfaces/protocol/output.ts";
import { createSession } from "../src/index.ts";
import { lastInput } from "./helpers/session.ts";

test("LAN chat uses the same agent, requires pairing and delivers notice-started output", async () => {
  const outputs = createChannelOutputs();
  const session = createSession({ systemPrompt: "test", configureTurn: () => ({
    model: async messages => ({ role: "assistant", content: lastInput(messages), calls: [] }),
    tools: [], executeTool: async () => "unused",
  }) });
  session.subscribe(event => publishChannelEvent(outputs, event));
  session.start();
  const agent = session.agent;
  const chat = serveWebChat(createChannelHandler(session, outputs), 0, "test-pairing");
  const base = `http://127.0.0.1:${chat.server.port}`;
  let reader: { cancel(): Promise<void> } | undefined;
  try {
    const page = await fetch(base); expect(page.status).toBe(200);
    const html = await page.text(), source = html.slice(html.indexOf("  function sha256Fallback"), html.indexOf("  async function upload"));
    const fallback = new Function(`${source}; return sha256Fallback`)() as (input: Uint8Array) => string;
    expect(fallback(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect((await fetch(`${base}/events?channelId=bob`)).status).toBe(401);
    expect((await fetch(`${base}/state?token=test-pairing`)).status).toBe(404);
    expect((await fetch(`${base}/messages`, { method: "POST", headers: { Authorization: "Bearer test-pairing", Origin: "http://elsewhere" }, body: "{}" })).status).toBe(403);
    const events = await fetch(`${base}/events?channelId=bob&token=test-pairing`);
    const stream = events.body!.getReader(); reader = stream;
    expect(new TextDecoder().decode((await stream.read()).value)).toContain("event: ready");
    const response = await fetch(`${base}/messages`, { method: "POST", headers: { Authorization: "Bearer test-pairing", Origin: base },
      body: JSON.stringify({channelId:"bob",participantId:"bob",text:"hello"}) });
    expect(await response.json()).toEqual({ answer: "hello" });
    expect(new TextDecoder().decode((await stream.read()).value)).toContain('"text":"hello"');
    expect(agent.notify({ channelId: "bob", fromChannelId: "alice", text: "Alice says hi" }).accepted).toBe(true);
    expect(new TextDecoder().decode((await stream.read()).value)).toContain("Alice says hi");
  } finally { await reader?.cancel(); await chat.server.stop(true); }
});

test("paired standalone chat uploads, submits and downloads a general file", async () => {
  const { openDevelopment } = await import("../src/interfaces/cli/development.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const home = mkdtempSync(join(tmpdir(), "chat-file-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "file" }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const dev = await openDevelopment({ systemPrompt: "test", script }); dev.session.start();
  const handler = createChannelHandler(dev.local);
  const chat = serveWebChat(handler, 0, "paired", { attachments: dev.attachments, ensureChannel(id) { const result = dev.session.channels.create({ channelId: id }); if (!result.ok) throw Error(result.error.message); } });
  const base = `http://127.0.0.1:${chat.server.port}`, data = Buffer.from("a general file");
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", headers: { Authorization: "Bearer paired", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw Error(JSON.stringify(result)); return result as any;
  };
  try {
    const denied = await fetch(base + "/attachments/begin", { method: "POST", body: "{}" }); expect(denied.status).toBe(401);
    const upload = await post("/attachments/begin", { channel: "a", filename: "file.txt", mediaType: "text/plain", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    await post("/attachments/write", { channel: "a", uploadId: upload.uploadId, offset: 0, data: data.toString("base64") });
    const metadata = await post("/attachments/finalize", { channel: "a", uploadId: upload.uploadId });
    const answer = await post("/messages", { channelId: "a", participantId: "person", text: "", parts: [{ type: "attachment", id: metadata.id }] });
    expect(answer.answer).toBe("done");
    const download = await post("/attachments/read", { channel: "a", id: metadata.id, offset: 0 });
    expect(Buffer.from(download.data, "base64")).toEqual(data);
  } finally { await chat.server.stop(true); dev.close(); rmSync(home, { recursive: true, force: true }); }
});

test("paired chat accepts a verified image with explicitly enabled scripted vision", async () => {
  const { imageValidationAvailable } = await import("../src/capabilities/attachments/image-validation.ts");
  if (!imageValidationAvailable()) return;
  const { openDevelopment } = await import("../src/interfaces/cli/development.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const home = mkdtempSync(join(tmpdir(), "chat-image-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "image" }, { type: "model", content: "seen" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const dev = await openDevelopment({ systemPrompt: "test", managedConfig: { version: 1, system: "test", model: { protocol: "scripted", script, imageInput: true }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } } });
  dev.session.start();
  const handler = createChannelHandler(dev.local);
  const chat = serveWebChat(handler, 0, "paired", { attachments: dev.attachments, ensureChannel(id) { const result = dev.session.channels.create({ channelId: id }); if (!result.ok) throw Error(result.error.message); } });
  const base = `http://127.0.0.1:${chat.server.port}`;
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==", "base64");
  const post = async (path: string, body: unknown) => { const response = await fetch(base + path, { method: "POST", headers: { Authorization: "Bearer paired", "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw Error(JSON.stringify(result)); return result as any; };
  try {
    expect(dev.imageInput).toBe(true);
    const upload = await post("/attachments/begin", { channel: "a", filename: "image.png", mediaType: "image/png", bytes: image.length, sha256: createHash("sha256").update(image).digest("hex") });
    await post("/attachments/write", { channel: "a", uploadId: upload.uploadId, offset: 0, data: image.toString("base64") });
    const metadata = await post("/attachments/finalize", { channel: "a", uploadId: upload.uploadId });
    const answer = await post("/messages", { channelId: "a", participantId: "person", text: "see this", parts: [{ type: "text", text: "see this" }, { type: "attachment", id: metadata.id }] });
    expect(answer.answer).toBe("seen");
  } finally { await chat.server.stop(true); dev.close(); rmSync(home, { recursive: true, force: true }); }
}, 15000);
