import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalRegistry, UnknownTerminalError } from "../src/terminals.ts";

// How agents that route a shell tool through ACP terminals actually populate the request.
// `claude-code-acp` sends its entire Bash command line in `command` with NO `args` — so
// spawning `command` as an executable path fails every shell tool call it ever makes, with
// `Executable not found in $PATH: "printf 'ran' > shell.txt"`. Measured against the real
// binary in smoke-tests/test4-permission.
describe("TerminalRegistry — a command line in `command`, no args", () => {
  test("runs a bare command that carries its own arguments", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "printf hello" });

    expect(await registry.waitForExit(id)).toEqual({ exitCode: 0, signal: null });
    expect(registry.output(id).output).toBe("hello");

    registry.releaseAll();
  });

  test("honours shell metacharacters — the exact shape that was failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-terminal-"));
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "printf 'ran' > shell.txt", cwd: dir });

    expect((await registry.waitForExit(id)).exitCode).toBe(0);
    expect(await readFile(join(dir, "shell.txt"), "utf8")).toBe("ran");

    registry.releaseAll();
  });

  test("honours a pipeline", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "printf hi | tr a-z A-Z" });

    await registry.waitForExit(id);
    expect(registry.output(id).output).toBe("HI");

    registry.releaseAll();
  });

  test("an empty args array is the same as no args", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "printf one && printf two", args: [] });

    await registry.waitForExit(id);
    expect(registry.output(id).output).toBe("onetwo");

    registry.releaseAll();
  });

  // The other half of the contract: when the agent DID split the command up, its arguments
  // are already final and must not be re-split. Handing this to a shell would turn one
  // argument into two.
  test("spawns directly when args are given, so nothing is word-split", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "printf", args: ["%s", "a b"] });

    await registry.waitForExit(id);
    expect(registry.output(id).output).toBe("a b");

    registry.releaseAll();
  });

  test("a non-zero exit from the shell line is reported as the exit code", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "printf nope >&2; exit 3" });

    expect((await registry.waitForExit(id)).exitCode).toBe(3);
    expect(registry.output(id).output).toBe("nope");

    registry.releaseAll();
  });
});

describe("TerminalRegistry", () => {
  test("captures output and exit status", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "printf", args: ["hello"] });

    const status = await registry.waitForExit(id);
    expect(status).toEqual({ exitCode: 0, signal: null });

    const out = registry.output(id);
    expect(out.output).toBe("hello");
    expect(out.truncated).toBe(false);
    expect(out.exitStatus).toEqual({ exitCode: 0, signal: null });

    registry.releaseAll();
  });

  test("merges stderr into the output and reports a failing exit code", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({
      command: "sh",
      args: ["-c", "printf out; printf err >&2; exit 3"],
    });

    const status = await registry.waitForExit(id);
    expect(status.exitCode).toBe(3);

    const { output } = registry.output(id);
    expect(output).toContain("out");
    expect(output).toContain("err");

    registry.releaseAll();
  });

  test("honours the env and cwd the agent asked for", async () => {
    const registry = new TerminalRegistry({ cwd: "/" });
    const id = registry.create({
      command: "sh",
      args: ["-c", "printf %s \"$ACP_TEST_VAR\"; pwd"],
      cwd: "/tmp",
      env: [{ name: "ACP_TEST_VAR", value: "from-agent" }],
    });

    await registry.waitForExit(id);
    const { output } = registry.output(id);
    expect(output).toContain("from-agent");
    expect(output).toContain("/tmp");

    registry.releaseAll();
  });

  test("truncates from the front at a character boundary", async () => {
    const registry = new TerminalRegistry();
    // Each "é" is two bytes; a naive byte cut would leave a broken code point.
    const id = registry.create({
      command: "sh",
      args: ["-c", "printf 'ééééééééé'"],
      outputByteLimit: 7,
    });

    await registry.waitForExit(id);
    const { output, truncated } = registry.output(id);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(7);
    expect(output).toBe("ééé"); // 6 bytes — under the limit rather than split
    expect(output.includes("�")).toBe(false);

    registry.releaseAll();
  });

  test("kill keeps the terminal readable, release invalidates it", async () => {
    const registry = new TerminalRegistry();
    const id = registry.create({ command: "sh", args: ["-c", "printf up; sleep 30"] });

    // Give the shell a moment to emit before we kill it.
    await Bun.sleep(150);
    registry.kill(id);
    const status = await registry.waitForExit(id);
    expect(status.signal).toBe("SIGKILL");
    expect(registry.output(id).output).toBe("up");

    registry.release(id);
    expect(registry.has(id)).toBe(false);
    expect(() => registry.output(id)).toThrow(UnknownTerminalError);
  });

  test("unknown ids are rejected rather than silently answered", () => {
    const registry = new TerminalRegistry();
    expect(() => registry.output("nope")).toThrow("unknown terminalId: nope");
    expect(() => registry.kill("nope")).toThrow("unknown terminalId: nope");
    expect(() => registry.release("nope")).not.toThrow(); // releasing twice is fine
  });
});
