import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import type { ChannelEvent } from "../src/contracts/events.ts";
for (const mode of ["in-process", "stdio"] as const) test(`${mode}: oversized completion is a stable reference readable in bounded byte pages`, async () => {
  const home = mkdtempSync(join(tmpdir(), "large-model-")), script = join(home, "script.json"), answer = "🚀".repeat(300_000);
  writeFileSync(script, JSON.stringify({ version: 1, responses: [{ content: answer }] }));
  const harness = mode === "stdio" ? spawnHarness({ home }) : createInProcessHarness({ home }); const events: ChannelEvent[] = [];
  try {
    harness.client.onChannelEvent(event => events.push(event)); await harness.client.initialize();
    await harness.client.createSession({ sessionId: "s", participants: [], channels: {}, config: { version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "allow", policies: { allow: { fallback: "allow", tools: {} } } } });
    await harness.client.push({ channel: "a", item: { id: "i", kind: "user_message", sender: "u", content: [{ type: "text", text: "hi" }] } });
    for (let i = 0; i < 600 && !events.some(e => e.event.type === "turn_ended"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const completion = events.find(e => e.event.type === "message_completed")?.event;
    if (!completion || completion.type !== "message_completed" || !completion.messageId) throw new Error("missing completion");
    expect(completion.reference).toBe(true); expect(completion.parts).toBeUndefined();
    const buffers: Buffer[] = []; let offset = 0;
    for (;;) { const page = await harness.client.request("session/message/read", { messageId: completion.messageId, offset });
      const bytes = Buffer.from(page.data, "base64"); expect(bytes.length).toBeLessThanOrEqual(524288); buffers.push(bytes);
      if (page.nextOffset === undefined) break; offset = page.nextOffset; }
    expect(Buffer.concat(buffers).toString("utf8")).toBe(answer);
    const loaded = await harness.client.loadSession({ sessionId: "s" }); expect(loaded.messages[0]).toMatchObject({ messageId: completion.messageId, reference: true });
  } finally { await harness.close(); rmSync(home, { recursive: true, force: true }); }
}, 15000);
