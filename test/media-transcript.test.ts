import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../src/agent-session.ts";

test("legacy transcript records media descriptions without inline bytes, including failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-transcript-"));
  const path = join(root, "history.jsonl");
  const session = await AgentSession.create({
    adapter: { command: ["bun", resolve(import.meta.dir, "fixtures/media-agent.ts")] }, adapterId: "fixture",
    transcriptPath: path, metering: { pricing: false },
  });
  try {
    await session.prompt({ text: "MEDIA_OUTPUT", parts: [{ kind: "image", data: new Uint8Array([1]), name: "input.png", mimeType: "image/png" }] });
    await expect(session.prompt("MEDIA_OUTPUT FAIL_AFTER_MEDIA")).rejects.toThrow("failed after media");
    const text = await readFile(path, "utf8");
    expect(text).toContain("[image input.png]");
    expect(text).toContain("[audio]");
    expect(text).not.toContain('"data"');
    expect(text).not.toContain('"blob"');
    expect(text).not.toContain("AQI=");
  } finally { await session.stop(); await rm(root, { recursive: true, force: true }); }
});
