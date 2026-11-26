import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHarness } from "./helpers/stdio.ts";

test("managed open reports a new live listener after conditional stop and process replacement", async () => {
  const home = mkdtempSync(join(tmpdir(), "managed-inspector-"));
  const script = join(home, "script.jsonl");
  writeFileSync(script, '{"type":"scenario","version":1,"name":"inspector"}\n{"type":"model","content":"done"}\n');
  const env = { HARNESS_INSPECTOR_PORT: "0" };
  const first = spawnHarness({ home, env });
  try {
    let url: string;
    try {
      await first.client.initialize();
      const opened = await first.client.createSession({ sessionId: "inspected", participants: [], channels: {}, config: {
        version: 1, system: "persistent inspector", model: { protocol: "scripted", script },
        defaultPolicy: "owner", policies: { owner: { fallback: "allow", tools: {} } },
      } });
      const state = opened.inspector;
      if (state?.state !== "listening") throw new Error("Inspector did not bind");
      url = `http://127.0.0.1:${state.port}/`;
      expect((await first.client.openSession({ sessionId: "inspected" })).inspector).toEqual(state);
      const events = (await fetch(new URL("events", url))).body!.getReader();
      expect((await events.read()).done).toBe(false);
      try {
        expect(await first.client.stopIfIdle()).toMatchObject({ stopped: true });
        expect((await first.client.status()).inspector).toEqual({ state: "stopped" });
        await expect(fetch(url)).rejects.toThrow();
      } finally { await events.cancel().catch(() => {}); }
    } finally { await first.close(); }

    const second = spawnHarness({ home, env });
    try {
      await second.client.initialize();
      const reopened = await second.client.openSession({ sessionId: "inspected" });
      const state = reopened.inspector;
      if (state?.state !== "listening") throw new Error("Inspector did not bind on reopen");
      url = `http://127.0.0.1:${state.port}/`;
      expect(await (await fetch(new URL("context", url))).text()).toContain("persistent inspector");
    } finally { await second.close(); }
    await expect(fetch(url)).rejects.toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15_000);
