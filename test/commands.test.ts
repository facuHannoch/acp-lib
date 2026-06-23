import { describe, expect, test } from "bun:test";
import { createAgentCommands } from "../src/repl/commands.ts";
import type { InteractiveAgentClient } from "../src/repl/commands.ts";
import { SessionManager } from "../src/session-manager.ts";
import type { SessionRecord, SessionStore } from "../src/session-store.ts";
import type { Capabilities } from "../src/capabilities.ts";
import type { ConnectResult } from "../src/client.ts";

// --- test doubles ------------------------------------------------------------

class MemorySessionStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>();
  async save(record: SessionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
  async get(id: string): Promise<SessionRecord | null> {
    return this.records.get(id) ?? null;
  }
  async list(): Promise<SessionRecord[]> {
    return [...this.records.values()];
  }
  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

function caps(overrides: Partial<Capabilities["agent"]> = {}): Capabilities {
  return {
    protocolVersion: 1,
    client: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    authMethods: [],
    agent: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      auth: { logout: true },
      sessionCapabilities: {
        list: true,
        delete: false,
        close: false,
        fork: true,
        resume: true,
        additionalDirectories: false,
      },
      ...overrides,
    },
  };
}

interface FakeClientOptions extends Partial<InteractiveAgentClient> {
  capabilities?: Capabilities;
}

/** A configurable InteractiveAgentClient that records calls and returns canned results. */
function makeClient(opts: FakeClientOptions = {}): InteractiveAgentClient {
  const connect = (sessionId: string): ConnectResult => ({ sessionId, resumed: false });
  const base: InteractiveAgentClient = {
    // AgentClient
    prompt: async () => ({ text: "", stopReason: "end_turn", status: "completed", usage: null }),
    interrupt: () => {},
    stop: async () => {},
    // Bridgeable
    bridge: async () => {},
    // identity / state
    id: "catalog-id",
    currentAdapterId: "codex",
    currentMode: "normal",
    currentSessionId: "sess-1",
    currentCwd: "/work",
    isDegraded: false,
    capabilities: opts.capabilities ?? caps(),
    authMethods: [],
    agentCommands: [],
    configOptions: new Map(),
    // control plane
    getCommands: () => [],
    authenticate: async () => undefined,
    newSession: async () => connect("new-sess"),
    listSessions: async () => ({ sessions: [] }),
    loadSession: async (sessionId: string) => connect(sessionId),
    resumeSession: async (sessionId: string) => connect(sessionId),
    forkSession: async () => connect("forked-sess"),
    setMode: async () => connect("mode-sess"),
    parseConfigValue: () => ({ ok: true, value: true }),
    setConfigFromString: async (configId) => ({ configId, value: true, currentValue: true }),
  };
  return { ...base, ...opts };
}

/** Collects note() output and runs a single command. */
async function run(
  client: InteractiveAgentClient,
  command: string,
  args: string[] = [],
  extra: Parameters<typeof createAgentCommands>[0] extends infer D
    ? Partial<Omit<NonNullable<D>, "client" | "note">>
    : never = {},
): Promise<{ handled: boolean; out: string }> {
  const lines: string[] = [];
  const { onSlashCommand } = createAgentCommands({
    client,
    note: (msg) => lines.push(msg),
    ...extra,
  });
  const handled = await onSlashCommand(command, args);
  return { handled, out: lines.join("\n") };
}

// --- dispatch ----------------------------------------------------------------

describe("createAgentCommands · dispatch", () => {
  test("unknown command is NOT handled (falls through to prompt)", async () => {
    const { handled } = await run(makeClient(), "definitely-not-a-command");
    expect(handled).toBe(false);
  });

  test("known commands are handled", async () => {
    for (const cmd of ["help", "caps", "session"]) {
      const { handled } = await run(makeClient(), cmd);
      expect(handled).toBe(true);
    }
  });
});

// --- introspection commands --------------------------------------------------

describe("createAgentCommands · introspection", () => {
  test("/session shows id, adapter and mode", async () => {
    const { out } = await run(makeClient(), "session");
    expect(out).toContain("sess-1");
    expect(out).toContain("codex");
    expect(out).toContain("normal");
  });

  test("/session shows placeholder when no live session", async () => {
    const { out } = await run(makeClient({ currentSessionId: null }), "session");
    expect(out).toContain("(no session)");
  });

  test("/caps lists agent capabilities in normal mode", async () => {
    const { out } = await run(makeClient(), "caps");
    expect(out).toContain("loadSession=true");
    expect(out).toContain("list=true");
  });

  test("/caps refuses in degraded mode", async () => {
    const { out } = await run(makeClient({ isDegraded: true }), "caps");
    expect(out).toContain("degraded");
    expect(out).toContain("/upgrade");
  });

  test("/help lists controller command usages and agent commands", async () => {
    const client = makeClient({
      getCommands: () => [{ id: "new", usage: "/new" } as never],
      agentCommands: [{ name: "compact" } as never],
    });
    const { out } = await run(client, "help");
    expect(out).toContain("/new");
    expect(out).toContain("//name");
    expect(out).toContain("/compact");
  });
});

// --- mode swap ---------------------------------------------------------------

describe("createAgentCommands · degrade/upgrade", () => {
  test("/degrade short-circuits when already degraded", async () => {
    let called = false;
    const client = makeClient({
      currentMode: "degraded",
      isDegraded: true,
      setMode: async () => {
        called = true;
        return { sessionId: "x", resumed: false };
      },
    });
    const { out } = await run(client, "degrade");
    expect(out).toContain("already in degraded mode");
    expect(called).toBe(false);
  });

  test("/upgrade switches mode and reports the new session", async () => {
    const client = makeClient({
      currentMode: "degraded",
      isDegraded: true,
      setMode: async () => ({ sessionId: "upgraded-sess", resumed: false }),
    });
    const { out } = await run(client, "upgrade");
    expect(out).toContain("upgraded to ACP");
    expect(out).toContain("upgraded-sess");
  });
});

// --- session lifecycle + catalog persistence ---------------------------------

describe("createAgentCommands · sessions + catalog", () => {
  test("/new reports the session and records it to the catalog", async () => {
    const store = new MemorySessionStore();
    const manager = new SessionManager(store);
    const client = makeClient({ newSession: async () => ({ sessionId: "fresh", resumed: false }) });

    const { out } = await run(client, "new", [], { sessionManager: manager, adapterId: "codex" });

    expect(out).toContain("fresh");
    const record = await store.get("catalog-id");
    expect(record?.agentSessionId).toBe("fresh");
    expect(record?.adapter).toBe("codex");
  });

  test("/new without a sessionManager does not throw and still reports", async () => {
    const { out } = await run(makeClient(), "new");
    expect(out).toContain("new session");
  });

  test("/load requires an argument", async () => {
    const { out } = await run(makeClient(), "load", []);
    expect(out).toContain("usage: /load");
  });

  test("/load refuses when the agent lacks loadSession", async () => {
    const client = makeClient({ capabilities: caps({ loadSession: false }) });
    const { out } = await run(client, "load", ["target"]);
    expect(out).toContain("not supported");
  });

  test("/resume records the resumed session to the catalog", async () => {
    const store = new MemorySessionStore();
    const manager = new SessionManager(store);
    const client = makeClient({ resumeSession: async (id) => ({ sessionId: id, resumed: true }) });

    const { out } = await run(client, "resume", ["abc"], { sessionManager: manager, adapterId: "codex" });
    expect(out).toContain("resumed session abc");
    expect((await store.get("catalog-id"))?.agentSessionId).toBe("abc");
  });

  test("/fork refuses when unsupported", async () => {
    const client = makeClient({
      capabilities: caps({
        sessionCapabilities: { ...caps().agent.sessionCapabilities, fork: false },
      }),
    });
    const { out } = await run(client, "fork", ["abc"]);
    expect(out).toContain("not supported");
  });

  test("/sessions shows agent list when no catalog is wired", async () => {
    const client = makeClient({
      listSessions: async () => ({
        sessions: [{ sessionId: "agent-1", cwd: "/work", title: "From agent", updatedAt: "2026-01-01" }],
      }),
    });
    const { out } = await run(client, "sessions");
    expect(out).toContain("agent-1");
    expect(out).toContain("From agent");
  });

  test("/sessions shows merged view with source tags when a catalog is wired", async () => {
    const store = new MemorySessionStore();
    await store.save({
      id: "cat-only",
      agentSessionId: null,
      adapter: "codex",
      mode: "normal",
      title: "catalog only",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const manager = new SessionManager(store);
    const client = makeClient({
      listSessions: async () => ({ sessions: [{ sessionId: "agent-only", cwd: "/work", title: "live" }] }),
    });

    const { out } = await run(client, "sessions", [], { sessionManager: manager, adapterId: "codex" });
    expect(out).toContain("[catalog]");
    expect(out).toContain("[agent]");
  });

  test("/sessions reports when the agent does not support listing", async () => {
    const client = makeClient({
      capabilities: caps({
        sessionCapabilities: { ...caps().agent.sessionCapabilities, list: false },
      }),
    });
    const { out } = await run(client, "sessions");
    expect(out).toContain("does not support");
  });
});

// --- config ------------------------------------------------------------------

describe("createAgentCommands · config", () => {
  test("/config with no args lists options", async () => {
    const client = makeClient({
      configOptions: new Map([
        ["model", { configId: "model", type: "string", currentValue: "gpt" } as never],
      ]),
    });
    const { out } = await run(client, "config");
    expect(out).toContain("model");
    expect(out).toContain("gpt");
  });

  test("/config rejects an unknown option", async () => {
    const { out } = await run(makeClient(), "config", ["nope"]);
    expect(out).toContain("unknown config: nope");
  });

  test("/config sets a value when parsing succeeds", async () => {
    const client = makeClient({
      configOptions: new Map([
        ["flag", { configId: "flag", type: "boolean", currentValue: false } as never],
      ]),
      parseConfigValue: () => ({ ok: true, value: true }),
      setConfigFromString: async (configId) => ({ configId, value: true, currentValue: true }),
    });
    const { out } = await run(client, "config", ["flag", "true"]);
    expect(out).toContain("set flag=true");
  });

  test("/config surfaces a parse error without setting", async () => {
    let setCalled = false;
    const client = makeClient({
      configOptions: new Map([
        ["flag", { configId: "flag", type: "boolean", currentValue: false } as never],
      ]),
      parseConfigValue: () => ({ ok: false, error: "not a boolean" }),
      setConfigFromString: async (configId) => {
        setCalled = true;
        return { configId, value: false, currentValue: false };
      },
    });
    const { out } = await run(client, "config", ["flag", "banana"]);
    expect(out).toContain("not a boolean");
    expect(setCalled).toBe(false);
  });
});

// --- login --------------------------------------------------------------------

describe("createAgentCommands · login", () => {
  test("refuses in degraded mode", async () => {
    const { out } = await run(makeClient({ isDegraded: true }), "login");
    expect(out).toContain("unavailable in degraded mode");
  });

  test("lists auth methods when called with no argument", async () => {
    const client = makeClient({
      authMethods: [{ id: "oauth", name: "OAuth", description: "browser login" }],
    });
    const { out } = await run(client, "login");
    expect(out).toContain("oauth");
    expect(out).toContain("/login METHOD");
  });

  test("rejects an unknown method", async () => {
    const client = makeClient({ authMethods: [{ id: "oauth", name: "OAuth" }] });
    const { out } = await run(client, "login", ["nope"]);
    expect(out).toContain("unknown method: nope");
  });
});
