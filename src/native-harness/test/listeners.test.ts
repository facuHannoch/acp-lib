import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindLocalSocket, bindWebPort } from "../src/interfaces/cli/listeners.ts";

test("stale Unix socket recovery preserves regular files and refuses a live listener", async () => {
  const directory = mkdtempSync(join(tmpdir(), "harness-listeners-"));
  const path = join(directory, "agent.sock");
  const fetch = () => new Response("ready");
  const bind = () => Bun.serve({ unix: path, fetch });
  let listener: ReturnType<typeof bind> | undefined;
  try {
    writeFileSync(path, "keep");
    await expect(bindLocalSocket(path, bind)).rejects.toThrow("occupied");
    expect(readFileSync(path, "utf8")).toBe("keep");
    rmSync(path);
    const child = Bun.spawn([process.execPath, "-e",
      'Bun.serve({unix: process.argv[1], fetch: () => new Response("child")}); console.log("ready");', path],
    { stdout: "pipe" });
    const reader = child.stdout.getReader();
    try { expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("ready"); }
    finally { await reader.cancel(); child.kill("SIGKILL"); await child.exited; }
    expect(lstatSync(path).isSocket()).toBe(true);

    const attempts = await Promise.allSettled([bindLocalSocket(path, bind), bindLocalSocket(path, bind)]);
    const started = attempts.filter(result => result.status === "fulfilled");
    expect(started).toHaveLength(1);
    listener = started[0]!.value;
    await expect(bindLocalSocket(path, bind)).rejects.toThrow("already listens");
    expect(await (await globalThis.fetch("http://localhost", { unix: path })).text()).toBe("ready");
  } finally { await listener?.stop(true); rmSync(directory, { recursive: true, force: true }); }
});

test("occupied browser defaults fall back and explicit ports report the setting", async () => {
  const bind = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
  const occupied = bind(0);
  const variable = "HARNESS_TEST_EXPLICIT_PORT";
  const fallback = bindWebPort(occupied.port!, variable, bind);
  try {
    expect(fallback.port).not.toBe(occupied.port);
    process.env[variable] = String(occupied.port);
    expect(() => bindWebPort(occupied.port!, variable, bind)).toThrow(`Set ${variable}=0`);
  } finally {
    delete process.env[variable];
    await fallback.stop(true);
    await occupied.stop(true);
  }
});
