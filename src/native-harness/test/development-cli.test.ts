import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions } from "../src/capabilities/context/load-instructions.ts";
import { controlLocal } from "../src/interfaces/protocol/local.ts";
import { createSqliteStorageAdapter } from "../src/state/storage/sqlite.ts";

test("CLI creates fresh durable sessions and reopens by ID or database path", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-cli-"));
  const socket = join(home, "agent.sock");
  const sessions = join(home, ".harness", "sessions");
  const cli = new URL("../src/interfaces/cli/main.ts", import.meta.url).pathname;
  const script = new URL("./fixtures/development-lifecycle.jsonl", import.meta.url).pathname;
  const env = { ...process.env, HOME: home, HARNESS_SOCKET: socket, HARNESS_INSPECTOR_PORT: "0", HARNESS_CHAT_PORT: "0", OPENROUTER_API_KEY: "offline-test-key" };

  async function start(...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, "start", ...args], { env, stdout: "pipe", stderr: "inherit" });
    const lines = child.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      let output = "";
      while (!output.includes("Ctrl+C stops the agent")) {
        const chunk = await lines.read();
        if (chunk.done) throw new Error(`CLI stopped before it was ready: ${await child.exited}`);
        output += decoder.decode(chunk.value, { stream: true });
      }
      const status = await controlLocal(socket, "status") as { sessionId: string };
      expect(output).toContain(`Session ID: ${status.sessionId}`);
      if (args.includes("--debug")) {
        const inspector = /^Context inspector: (.+)$/m.exec(output)?.[1];
        if (!inspector) throw new Error("Missing inspector URL");
        const view = await (await fetch(new URL("/context", inspector))).json() as {
          base: { content: string }[]; tools: { name: string }[];
        };
        expect(view.base[0]?.content).toContain(loadInstructions("agent-demo").trimEnd());
        expect(view.base[0]?.content).toContain(loadInstructions("harness").trimEnd());
        expect(view.tools.map(tool => tool.name)).toEqual(["current_time", "test_echo", "test_wait", "test_fail", "notify_channel"]);
      }
      return status.sessionId;
    } finally {
      child.kill("SIGTERM");
      await lines.cancel();
      await child.exited;
    }
  }

  try {
    const first = await start("--script", script);
    const second = await start("--script", script);
    expect(first).not.toBe(second);
    expect(readdirSync(sessions).sort()).toEqual([first, second].sort());
    const path = join(sessions, first, "session.sqlite");
    expect(createSqliteStorageAdapter(path).readSavedHeader()).toMatchObject({ ok: true, value: { sessionId: first } });
    expect(await start("--session", first)).toBe(first);
    expect(await start("--db", path)).toBe(first);
    expect(await start("--session", "chosen", "--create", "--script", script)).toBe("chosen");
    expect(await start("--session", "chosen")).toBe("chosen");
    const explicit = join(home, "explicit.sqlite");
    expect(await start("--db", explicit, "--create", "--script", script)).toBe("development");
    expect(await start("--db", explicit)).toBe("development");
    const debug = await start("--debug");
    const saved = createSqliteStorageAdapter(join(sessions, debug, "session.sqlite")).readSavedConfig();
    expect(saved.ok && saved.value?.system).toContain("general-purpose assistant");
    expect(await start("--session", debug, "--debug")).toBe(debug);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15000);
