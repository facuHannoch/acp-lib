import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AcpClient } from "../src/client.ts";
import { AgentSession } from "../src/agent-session.ts";
import { prepareLaunch, type AcpLauncher } from "../src/launcher.ts";
import { SessionManager } from "../src/session-manager.ts";
import { AIR_CLIENT_CAPABILITY_META } from "../src/provider-notices.ts";

const AGENT = resolve(import.meta.dir, "../smoke-tests/test5-operations/operations-agent.ts");
const BUN = Bun.which("bun")!;

describe("AcpLauncher", () => {
  test("receives the untouched ACP target command and supplies an exact spawn environment", async () => {
    const inheritedKey = "ACP_LAUNCHER_MUST_NOT_INHERIT";
    const previous = process.env[inheritedKey];
    process.env[inheritedKey] = "host-value";
    let preparedKind: string | undefined;
    let preparedTarget: readonly string[] | undefined;
    let disposals = 0;

    const target = [BUN, AGENT, "exact-launch"];
    const launcher: AcpLauncher = {
      async prepare(request) {
        preparedKind = request.kind;
        preparedTarget = request.targetCommand;
        return {
          command: [
            "/bin/sh",
            "-c",
            `test -z "$${inheritedKey}" && test "$ACP_EXPLICIT" = yes && exec "$@"`,
            "sh",
            ...request.targetCommand,
          ],
          spawnEnv: { ACP_EXPLICIT: "yes" },
          dispose: () => { disposals++; },
        };
      },
    };

    const client = new AcpClient({
      adapter: { command: target },
      launcher,
      clientHandlers: { terminal: false, filesystem: false },
    });
    try {
      const capabilities = await client.connect();
      expect(preparedKind).toBe("acp");
      expect(preparedTarget).toEqual(target);
      expect(capabilities.client).toEqual({
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
        _meta: AIR_CLIENT_CAPABILITY_META,
      });
    } finally {
      await client.stop();
      if (previous === undefined) delete process.env[inheritedKey];
      else process.env[inheritedKey] = previous;
    }
    expect(disposals).toBe(1);
  });

  test("disposes exactly once when initialization fails", async () => {
    let disposals = 0;
    const client = new AcpClient({
      adapter: { command: ["ignored"] },
      launcher: {
        async prepare() {
          return {
            command: ["/bin/sh", "-c", "exit 12"],
            spawnEnv: {},
            dispose: () => { disposals++; },
          };
        },
      },
    });

    await expect(client.connect()).rejects.toThrow();
    await client.stop();
    expect(disposals).toBe(1);
  });

  test("disposes when AgentSession construction fails after connection", async () => {
    let disposals = 0;
    await expect(AgentSession.create({
      adapter: { command: [BUN, AGENT, "construction-failure"] },
      adapterId: "fake",
      providerSession: { kind: "new" },
      sessions: new SessionManager({
        async get() { throw new Error("catalog unavailable"); },
        async save() {},
        async list() { return []; },
        async delete() {},
      }),
      launcher: {
        async prepare({ targetCommand }) {
          return {
            command: [...targetCommand],
            spawnEnv: { ...(process.env as Record<string, string>) },
            dispose: () => { disposals++; },
          };
        },
      },
    })).rejects.toThrow("catalog unavailable");
    expect(disposals).toBe(1);
  });

  test("passes ACP and PTY adapter commands independently to the launcher", async () => {
    const seen: Array<{ kind: string; target: readonly string[] }> = [];
    const launcher: AcpLauncher = {
      async prepare(request) {
        seen.push({ kind: request.kind, target: request.targetCommand });
        return { command: ["unused"], spawnEnv: {} };
      },
    };
    const adapter = { command: ["agent", "--acp"], ptyCommand: ["agent", "--tui"] };

    await prepareLaunch("acp", launcher, { adapter });
    await prepareLaunch("pty", launcher, { adapter });

    expect(seen).toEqual([
      { kind: "acp", target: ["agent", "--acp"] },
      { kind: "pty", target: ["agent", "--tui"] },
    ]);
  });

  test("a partial custom filesystem advertises only its implemented method", async () => {
    const client = new AcpClient({
      adapter: { command: [BUN, AGENT, "partial-fs"] },
      clientHandlers: {
        terminal: false,
        filesystem: {
          readTextFile: async () => ({ content: "custom" }),
        },
      },
    });
    try {
      const capabilities = await client.connect();
      expect(capabilities.client).toEqual({
        terminal: false,
        fs: { readTextFile: true, writeTextFile: false },
        _meta: AIR_CLIENT_CAPABILITY_META,
      });
    } finally {
      await client.stop();
    }
  });
});
