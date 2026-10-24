import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeParts } from "../src/media/parts.ts";
import { resolveParts } from "../src/media/store.ts";
import { attachmentParts, partsToAcp } from "../src/media/acp.ts";
import { redactMedia } from "../src/media/redact.ts";

const caps = { image: true, audio: true, embeddedContext: true };
test("copy sources map to actual ACP kinds and text resources", async () => {
  const resolved = await resolveParts([
    { kind: "text", text: "look" }, { kind: "pasted", text: "paste", name: "notes" },
    { kind: "image", data: new Uint8Array([1]), mimeType: "image/png" },
    { kind: "audio", data: new Uint8Array([2]), mimeType: "audio/wav" },
    { kind: "file", data: new TextEncoder().encode("hello"), mimeType: "text/plain" },
    { kind: "image", data: new TextEncoder().encode("<svg/>"), mimeType: "image/svg+xml" },
    { kind: "file", data: new Uint8Array([3]), mimeType: "application/pdf" },
  ], { cwd: process.cwd(), capabilities: caps });
  const blocks = partsToAcp(resolved);
  expect(blocks.map((b) => b.type)).toEqual(["text", "text", "image", "audio", "resource", "resource", "resource"]);
  expect(blocks[4]).toMatchObject({ resource: { text: "hello" } });
  expect(blocks[5]).toMatchObject({ resource: { text: "<svg/>", mimeType: "image/svg+xml" } });
  expect(blocks[6]).toMatchObject({ resource: { blob: "Aw==" } });
});

test("path auto mode selects by size and capabilities; explicit unsupported copies fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "parts-"));
  try {
    await writeFile(join(root, "photo.png"), new Uint8Array([1, 2]));
    const input = [{ kind: "image" as const, path: "photo.png" }];
    expect(await resolveParts(input, { cwd: root, capabilities: caps, thresholds: { image: 1 } })).toMatchObject([{ mode: "link", uri: `file://${root}/photo.png`, size: 2 }]);
    expect(await resolveParts(input, { cwd: root })).toMatchObject([{ mode: "link" }]);
    expect(await resolveParts(input, { cwd: root, capabilities: caps })).toMatchObject([{ mode: "copy", data: new Uint8Array([1, 2]) }]);
    await expect(resolveParts([{ ...input[0]!, mode: "copy" }], { cwd: root })).rejects.toThrow("does not support");
    expect(await resolveParts([{ kind: "image", data: new Uint8Array([1, 2]) }], { cwd: root, capabilities: caps, thresholds: { image: 1 } })).toMatchObject([{ mode: "copy" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid link and recording combinations are refused", () => {
  expect(() => normalizeParts([{ kind: "image", data: new Uint8Array(), mode: "link" }])).toThrow("requires path");
  expect(() => normalizeParts([{ kind: "file", path: "a", mode: "link", keep: false }])).toThrow("only valid");
  expect(() => normalizeParts([{ kind: "image", data: new Uint8Array(), record: false, keep: false }])).toThrow("cannot specify keep");
});

test("attachments retain copy/no-keep semantics and redaction never mutates wire values", () => {
  expect(attachmentParts([{ mimeType: "audio/wav", data: new ArrayBuffer(1) }])).toMatchObject([{ kind: "audio", mode: "copy", keep: false }]);
  const value = { prompt: [{ type: "image", data: "AQI=" }, { type: "resource", resource: { blob: "AQI=" } }] };
  expect(redactMedia(value)).toEqual({ prompt: [{ type: "image", data: { byteLength: 2 } }, { type: "resource", resource: { blob: { byteLength: 2 } } }] });
  expect(value.prompt[0]!.data).toBe("AQI=");
});
