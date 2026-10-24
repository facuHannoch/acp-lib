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
