import { expect, test } from "bun:test";
import { AcpClient } from "../src/client.ts";
import { resolve } from "node:path";

test("fixture receives ordered parts and compatibility attachment MIME kinds", async () => {
  const client = new AcpClient({ adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/media-agent.ts")] } });
  try {
    await client.connect();
    const result = await client.prompt({ text: "", parts: [
      { kind: "text", text: "first" },
      { kind: "image", data: new Uint8Array([1]), mimeType: "image/png" },
      { kind: "text", text: "last" },
    ], attachments: [{ data: new Uint8Array([2]).buffer, mimeType: "audio/wav" }] });
    expect(JSON.parse(result.text).blocks).toEqual([
      { type: "text", text: "first" }, { type: "image", data: "AQ==", mimeType: "image/png" },
      { type: "text", text: "last" }, { type: "audio", data: "Ag==", mimeType: "audio/wav" },
    ]);
  } finally { await client.stop(); }
});

test("media responses preserve order, text view and stream parts", async () => {
  const client = new AcpClient({ adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/media-agent.ts")] } });
  try {
    await client.connect();
    const chunks: unknown[] = [];
    const result = await client.prompt("MEDIA_OUTPUT", { onResponseChunk: (chunk) => chunks.push(chunk) });
    expect(result.messages).toHaveLength(1);
    expect(result.text).toBe("after image");
    expect(result.messages[0]!.parts?.map((part) => part.kind)).toEqual(["image", "text", "audio", "file", "file", "file"]);
    expect(chunks).toHaveLength(6);
    expect(result.messages[0]!.parts?.[0]).toMatchObject({ kind: "image", mode: "copy", size: 2, data: new Uint8Array([1, 2]) });
    expect(result.messages[0]!.parts?.[3]).toMatchObject({ mode: "link", uri: "file:///tmp/original.pdf" });
  } finally { await client.stop(); }
});
