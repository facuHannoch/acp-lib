import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHarness } from "./helpers/stdio.ts";

test("stdio managed general-file upload, ordered push and download survive reopen", async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-stdio-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "file" }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const data = Buffer.alloc(600000, 0x5a), sha256 = createHash("sha256").update(data).digest("hex");
  let id = "", archive: Uint8Array | undefined;
  try {
    const first = spawnHarness({ home });
    try {
      const init = await first.client.initialize();
      expect(init.description.capabilities).toMatchObject({ managedAttachments: true, orderedParts: true });
      await first.client.createSession({ sessionId: "s", participants: [], channels: {}, channelChanges: [{ channel: "a", changeId: "a" }, { channel: "b", changeId: "b" }],
        config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } } });
      const upload = await first.client.beginAttachment({ channel: "a", filename: "data.bin", mediaType: "application/octet-stream", bytes: data.length, sha256 });
      id = upload.attachmentId;
      await first.client.writeAttachment({ channel: "a", uploadId: upload.uploadId, offset: 0, data: data.subarray(0, 400000).toString("base64") });
      await first.client.writeAttachment({ channel: "a", uploadId: upload.uploadId, offset: 400000, data: data.subarray(400000).toString("base64") });
      expect((await first.client.finalizeAttachment({ channel: "a", uploadId: upload.uploadId })).id).toBe(id);
      await expect(first.client.readAttachment({ channel: "b", id, offset: 0 })).rejects.toMatchObject({ code: "not_found" });
      expect((await first.client.push({ channel: "a", item: { id: "msg", kind: "user_message", sender: "human", content: [{ type: "text", text: "before" }, { type: "attachment", id }, { type: "text", text: "after" }] } })).accepted).toBe(true);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const view = await first.client.reconcileChannel({ channel: "a", itemIds: ["msg"] });
        if (view.items[0]?.milestone !== "received") break;
        await Bun.sleep(10);
      }
      const shared = await first.client.readAttachment({ channel: "b", id, offset: 0 });
      expect(Buffer.from(shared.data, "base64")).toEqual(data.subarray(0, 524288));
      const history = await first.client.channelMessages({ channel: "a" });
      const message = history.messages.find(entry => "itemId" in entry && entry.itemId === "msg");
      expect(message).toMatchObject({ parts: [{ type: "text", text: "before" }, { type: "attachment", id, metadata: { filename: "data.bin", bytes: data.length } }, { type: "text", text: "after" }] });
      expect(JSON.stringify(history)).not.toContain(data.subarray(0, 30).toString("base64"));
      await first.client.suspend();
      archive = await first.client.exportArchive();
    } finally { await first.close(); }
    const second = spawnHarness({ home });
    try {
      await second.client.initialize(); await second.client.openSession({ sessionId: "s" });
      const one = await second.client.readAttachment({ channel: "a", id, offset: 0 });
      const two = await second.client.readAttachment({ channel: "a", id, offset: one.nextOffset! });
      expect(Buffer.concat([Buffer.from(one.data, "base64"), Buffer.from(two.data, "base64")])).toEqual(data);
    } finally { await second.close(); }
    const destination = spawnHarness({ home });
    try {
      await destination.client.initialize();
      await destination.client.importArchive(archive!, "copy");
      await destination.client.openSession({ sessionId: "copy" });
      const one = await destination.client.readAttachment({ channel: "a", id, offset: 0 });
      const two = await destination.client.readAttachment({ channel: "a", id, offset: one.nextOffset! });
      expect(Buffer.concat([Buffer.from(one.data, "base64"), Buffer.from(two.data, "base64")])).toEqual(data);
    } finally { await destination.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);

test("real stdio vision negotiates per session and sends active images through a tool exchange", async () => {
  const { imageValidationAvailable } = await import("../src/capabilities/attachments/image-validation.ts");
  if (!imageValidationAvailable()) return;
  const home = mkdtempSync(join(tmpdir(), "a1-vision-"));
  const requests: any[] = [];
  let retainedImageId = "", retainedDigest = "";
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json());
    const first = requests.length === 1;
    const payload = first ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "echo", arguments: '{"text":"ok"}' } }] }, finish_reason: "tool_calls" }] }
      : { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const generator = Bun.spawn(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "768x512", "-i", "pipe:0", "-frames:v", "1", "-threads", "1", "-c:v", "png", "-compression_level", "0", "-f", "image2pipe", "pipe:1"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const imagePromise = new Response(generator.stdout).arrayBuffer();
    generator.stdin.write(randomBytes(768 * 512 * 3)); await generator.stdin.end();
    const image = Buffer.from(await imagePromise);
    expect(await generator.exited).toBe(0); expect(image.length).toBeGreaterThan(1024 * 1024);
    const sha256 = createHash("sha256").update(image).digest("hex");
    retainedDigest = sha256;
    const endpoint = `http://127.0.0.1:${provider.port}/`;
    const plain = spawnHarness({ home, providerEndpoint: endpoint }), vision = spawnHarness({ home, providerEndpoint: endpoint });
    try {
      const [initPlain, initVision] = await Promise.all([plain.client.initialize(), vision.client.initialize()]);
      expect(initPlain.description).toEqual(initVision.description);
      const model = { protocol: "openrouter" as const, model: "fixture", apiKeyEnv: "OPENROUTER_API_KEY" };
      const policies = { open: { fallback: "allow" as const, tools: {} } };
      const plainOpen = await plain.client.createSession({ sessionId: "plain", participants: [], channels: {}, channelChanges: [{ channel: "a", changeId: "a" }], config: { version: 1, system: "test", model, defaultPolicy: "open", policies } });
      const visionOpen = await vision.client.createSession({ sessionId: "vision", participants: [], channels: {}, channelChanges: [{ channel: "a", changeId: "a" }], config: { version: 1, system: "test", model: { ...model, imageInput: true }, defaultPolicy: "open", policies } });
      expect(plainOpen.imageInput).toBeUndefined(); expect(visionOpen.imageInput).toBe(true);
      const upload = async (client: typeof vision.client) => {
        const begun = await client.beginAttachment({ channel: "a", filename: "image.png", mediaType: "image/png", bytes: image.length, sha256 });
        for (let offset = 0; offset < image.length; offset += 400000) await client.writeAttachment({ channel: "a", uploadId: begun.uploadId, offset, data: image.subarray(offset, offset + 400000).toString("base64") });
        await client.finalizeAttachment({ channel: "a", uploadId: begun.uploadId });
        return begun.attachmentId;
      };
      const [plainId, imageId] = await Promise.all([upload(plain.client), upload(vision.client)]);
      retainedImageId = imageId;
      await expect(plain.client.push({ channel: "a", item: { id: "no", kind: "user_message", sender: "human", content: [{ type: "attachment", id: plainId }] } })).rejects.toMatchObject({ code: "unsupported_image" });
      let ended = 0;
      vision.client.onChannelEvent(({ event }) => { if (event.type === "turn_ended") ended++; });
      const item = { id: "vision-item", kind: "user_message" as const, sender: "human", content: [{ type: "text" as const, text: "before" }, { type: "attachment" as const, id: imageId }, { type: "text" as const, text: "after" }] };
      expect((await vision.client.push({ channel: "a", item })).accepted).toBe(true);
      const until = async (predicate: () => boolean) => { const deadline = Date.now() + 10000; while (!predicate() && Date.now() < deadline) await Bun.sleep(20); expect(predicate()).toBe(true); };
      await until(() => ended >= 1);
      const history = await vision.client.channelMessages({ channel: "a" });
      expect(history.messages.find(message => message.itemId === "vision-item")).toMatchObject({ parts: [{ type: "text", text: "before" }, { type: "attachment", id: imageId, metadata: { mediaType: "image/png" } }, { type: "text", text: "after" }] });
      expect(JSON.stringify(history)).not.toContain(image.toString("base64"));
      expect((await vision.client.push({ channel: "a", item })).duplicate).toBe(true);
      await expect(vision.client.push({ channel: "a", item: { ...item, content: [{ type: "text", text: "changed" }, { type: "attachment", id: imageId }] } })).rejects.toMatchObject({ code: "item_conflict" });
      expect((await vision.client.push({ channel: "a", item: { ...item, id: "only", content: [{ type: "attachment", id: imageId }] } })).accepted).toBe(true);
      await until(() => ended >= 2);
      expect(requests.length).toBe(3);
      for (const request of requests.slice(0, 2)) {
        const active = request.messages.find((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url"));
        expect(active.content.map((part: any) => part.type)).toEqual(["text", "text", "image_url", "text"]);
        expect(active.content[2].image_url.url).toBe(`data:image/png;base64,${image.toString("base64")}`);
      }
      expect(requests[2].messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url"))).toBe(true);
    } finally { await plain.close(); await vision.close(); }
    const reopened = spawnHarness({ home, providerEndpoint: endpoint });
    try {
      await reopened.client.initialize();
      expect((await reopened.client.openSession({ sessionId: "vision" })).imageInput).toBe(true);
      const chunks: Buffer[] = []; let offset = 0;
      do { const page = await reopened.client.readAttachment({ channel: "a", id: retainedImageId, offset }); chunks.push(Buffer.from(page.data, "base64")); offset = page.nextOffset ?? -1; } while (offset >= 0);
      expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(retainedDigest);
      rmSync(join(home, "vision", "media", retainedImageId));
      let failure: import("../src/contracts/attachments.ts").AttachmentFailure | undefined;
      reopened.client.onChannelEvent(({ event }) => { if (event.type === "turn_ended" && event.attachmentFailure) failure = event.attachmentFailure; });
      await reopened.client.push({ channel: "a", item: { id: "missing", kind: "user_message", sender: "human", content: [{ type: "attachment", id: retainedImageId }] } });
      const deadline = Date.now() + 5000; while (!failure && Date.now() < deadline) await Bun.sleep(10);
      expect(failure).toEqual({ code: "attachment_unavailable", attachmentIds: [retainedImageId] });
      expect(requests.length).toBe(3);
      const item = (await reopened.client.reconcileChannel({ channel: "a", itemIds: ["missing"] })).items[0]!;
      const recovered = await reopened.client.reconcileChannel({ channel: "a", turnIds: [item.turnId!] });
      expect(recovered.turns[0]?.attachmentFailure).toEqual(failure);
    } finally { await reopened.close(); }
  } finally { provider.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 30000);

test("scripted image capability requires explicit opt-in", async () => {
  const { imageValidationAvailable } = await import("../src/capabilities/attachments/image-validation.ts");
  if (!imageValidationAvailable()) return;
  const home = mkdtempSync(join(tmpdir(), "a1-script-image-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "fixture" }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const server = spawnHarness({ home });
  try {
    await server.client.initialize();
    const result = await server.client.createSession({ sessionId: "script", participants: [], channels: {}, config: { version: 1, system: "test", model: { protocol: "scripted", script, imageInput: true }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } } });
    expect(result.imageInput).toBe(true);
  } finally { await server.close(); rmSync(home, { recursive: true, force: true }); }
}, 15000);

test("missing image tools suppress vision while general file upload remains available", async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-no-decoder-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "no-decoder" }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const server = spawnHarness({ home, pathOverride: "/nonexistent" });
  try {
    const init = await server.client.initialize(); expect(init.description.capabilities.managedAttachments).toBe(true);
    const opened = await server.client.createSession({ sessionId: "s", participants: [], channels: {}, channelChanges: [{ channel: "a", changeId: "a" }], config: { version: 1, system: "test", model: { protocol: "scripted", script, imageInput: true }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } } });
    expect(opened.imageInput).toBeUndefined();
    const bytes = Buffer.from("plain file");
    const upload = await server.client.beginAttachment({ channel: "a", filename: "x.txt", mediaType: "text/plain", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await server.client.writeAttachment({ channel: "a", uploadId: upload.uploadId, offset: 0, data: bytes.toString("base64") });
    const metadata = await server.client.finalizeAttachment({ channel: "a", uploadId: upload.uploadId });
    const page = await server.client.readAttachment({ channel: "a", id: metadata.id, offset: 0 });
    expect(Buffer.from(page.data, "base64")).toEqual(bytes);
  } finally { await server.close(); rmSync(home, { recursive: true, force: true }); }
}, 15000);

for (const fault of ["attachmentPublished:1", "attachmentReady:1", "acceptItem:1"] as const) test(`stdio recovers attachment publication and acceptance after ${fault}`, async () => {
  const home = mkdtempSync(join(tmpdir(), "a1-crash-")), script = join(home, "scenario.jsonl");
  writeFileSync(script, [{ type: "scenario", version: 1, name: "crash" }, { type: "model", content: "done" }].map(x => JSON.stringify(x)).join("\n") + "\n");
  const bytes = Buffer.from("durable crash fixture"), sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const first = spawnHarness({ home, fault });
    let id = "";
    try {
      await first.client.initialize();
      await first.client.createSession({ sessionId: "s", participants: [], channels: {}, channelChanges: [{ channel: "a", changeId: "a" }], config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } } } });
      const upload = await first.client.beginAttachment({ channel: "a", filename: "data.txt", mediaType: "text/plain", bytes: bytes.length, sha256 }); id = upload.attachmentId;
      await first.client.writeAttachment({ channel: "a", uploadId: upload.uploadId, offset: 0, data: bytes.toString("base64") });
      if (fault === "acceptItem:1") {
        await first.client.finalizeAttachment({ channel: "a", uploadId: upload.uploadId });
        await expect(first.client.push({ channel: "a", item: { id: "input", kind: "user_message", sender: "p", content: [{ type: "attachment", id }] } })).rejects.toThrow();
      } else await expect(first.client.finalizeAttachment({ channel: "a", uploadId: upload.uploadId })).rejects.toThrow();
      expect(await first.child.exited).not.toBe(0);
    } finally { first.client.close(); first.child.kill(); }
    const second = spawnHarness({ home });
    try {
      await second.client.initialize(); await second.client.openSession({ sessionId: "s" });
      if (fault === "attachmentPublished:1") await expect(second.client.readAttachment({ channel: "a", id, offset: 0 })).rejects.toMatchObject({ code: "not_found" });
      else {
        expect(Buffer.from((await second.client.readAttachment({ channel: "a", id, offset: 0 })).data, "base64")).toEqual(bytes);
        if (fault === "acceptItem:1") expect((await second.client.push({ channel: "a", item: { id: "input", kind: "user_message", sender: "p", content: [{ type: "attachment", id }] } })).duplicate).toBe(true);
      }
    } finally { await second.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20000);
