import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnHarness } from "./helpers/stdio.ts";
const config = { version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: new URL("./fixtures/crash-scenario.json", import.meta.url).pathname },
  defaultPolicy: "__legacy_allow", policies: { __legacy_allow: { fallback: "allow" as const, tools: {} } } };
for (const point of ["startAttempt", "commitResponse"] as const) test(`SQLite process crash after ${point} keeps matching call and reply state`, async () => {
  const home = mkdtempSync(join(tmpdir(), "model-crash-")), first = spawnHarness({ home, fault: `${point}:1` });
  try {
    await first.client.initialize(); await first.client.createSession({ sessionId: "s", config, participants: [], channels: {} });
    void first.client.push({ channel: "a", item: { id: "i", kind: "user_message", sender: "u", content: [{ type: "text", text: "hello" }] } }).catch(() => {});
    expect(await first.child.exited).not.toBe(0); first.client.close();
    const next = spawnHarness({ home });
    try {
      await next.client.initialize(); await next.client.openSession({ sessionId: "s" });
      const loaded = await next.client.reconcileChannel({ channel: "a", turnIds: ["1"] });
      const calls = (await next.client.request("session/model-calls", {})).calls;
      expect(calls).toHaveLength(1); expect(calls[0]?.attempts[0]?.scriptStep).toBe(0);
      if (point === "startAttempt") { expect(calls[0]?.outcome).toBe("interrupted"); expect(loaded.replies).toEqual([]); }
      else { expect(calls[0]?.outcome).toBe("succeeded"); expect(loaded.replies[0]?.messageId).toBe(calls[0]?.messageId); }
      const seen: string[] = []; next.client.onChannelEvent(event => { if (event.event.type === "message_completed" && event.event.parts) seen.push(event.event.parts[0]!.text); });
      await next.client.push({ channel: "a", item: { id: "fresh", kind: "user_message", sender: "u", content: [{ type: "text", text: "again" }] } });
      for (let i = 0; i < 500 && !seen.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(seen).toEqual(["First reply."]);
      const after = (await next.client.modelCalls()).calls; expect(after[1]?.attempts[0]?.scriptStep).toBe(1);
    } finally { await next.close(); }
  } finally { first.child.kill(); rmSync(home, { recursive: true, force: true }); }
}, 15000);
