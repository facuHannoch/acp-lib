import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";

test("legacy transcript records media descriptions without inline bytes, including failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-transcript-"));
  const path = join(root, "history.jsonl");
  const sent: any[][] = [];
  const session = await AgentSession.create({
    wire: (entry) => { if (entry.dir === "out") { const frame = JSON.parse(entry.line); if (frame.method === "session/prompt") sent.push(frame.params.prompt); } },
    adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/media-agent.ts")] }, adapterId: "fixture",
    transcriptPath: path, metering: { pricing: false },
  });
  try {
    await session.prompt({ text: "MEDIA_OUTPUT", parts: [{ kind: "image", data: new Uint8Array([1]), name: "input.png", mimeType: "image/png" }] });
    expect(sent[0]!.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe("MEDIA_OUTPUT");
    await expect(session.prompt("MEDIA_OUTPUT FAIL_AFTER_MEDIA")).rejects.toThrow("failed after media");
    const text = await readFile(path, "utf8");
    expect(text).toContain("[image input.png]");
    expect(text).toContain("[audio]");
    expect(text).not.toContain('"data"');
    expect(text).not.toContain('"blob"');
    expect(text).not.toContain("AQI=");
  } finally { await session.stop(); await rm(root, { recursive: true, force: true }); }
});
