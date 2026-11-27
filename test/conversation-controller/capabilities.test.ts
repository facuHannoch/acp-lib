/**
 * Neutral capabilities (controller-interface spec, Capabilities; Brief B1 step 1): the mapping from
 * ACP's `initialize` result, `conversationCapabilities` on a real controller before start, after
 * start and in PTY mode, the unchanged ACP `capabilities`, and `UnsupportedError`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../../src/agent-session.ts";
import { parseCapabilities } from "../../src/capabilities.ts";
import { HarnessController } from "../../src/controller.ts";
import { NotConnectedError, UnsupportedError } from "../../src/errors.ts";
import {
  conversationCapabilitiesFromAcp,
  conversationCapabilitiesOf,
  fromAcp,
  mediaCapabilitiesOf,
} from "../../src/conversation-controller/index.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");
const ECHO = join(FIXTURES, "echo-prompt-agent.ts");
const IDLE_PTY = join(FIXTURES, "idle-pty-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

const initialize = (agentCapabilities: Record<string, unknown>) =>
  parseCapabilities({ protocolVersion: 1, agentCapabilities } as never);

describe("fromAcp", () => {
  test("an agent that advertises everything", () => {
    const acp = initialize({
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, fork: {}, resume: {}, delete: {} },
    });
    expect(fromAcp(acp)).toEqual({
      loadSession: true,
      forkSession: true,
      listSessions: true,
      media: { image: true, audio: true, file: true },
      mcpServers: { stdio: true, http: true, sse: true },
      acp,
    });
  });

  test("an agent that advertises nothing: every flag false but stdio MCP, which every ACP agent takes", () => {
    const backend = fromAcp(initialize({}));
    expect(backend).toMatchObject({
      loadSession: false,
      forkSession: false,
      listSessions: false,
      media: { image: false, audio: false, file: false },
      mcpServers: { stdio: true, http: false, sse: false },
    });
  });

  test("each flag follows its own ACP capability", () => {
    expect(fromAcp(initialize({ loadSession: true })).loadSession).toBe(true);
    expect(fromAcp(initialize({ sessionCapabilities: { fork: {} } }))).toMatchObject({ forkSession: true, listSessions: false });
    expect(fromAcp(initialize({ sessionCapabilities: { list: {} } }))).toMatchObject({ forkSession: false, listSessions: true });
    expect(fromAcp(initialize({ promptCapabilities: { embeddedContext: true } })).media).toEqual({ image: false, audio: false, file: true });
    expect(fromAcp(initialize({ promptCapabilities: { image: true } })).media).toEqual({ image: true, audio: false, file: false });
    expect(fromAcp(initialize({ mcpCapabilities: { sse: true } })).mcpServers).toEqual({ stdio: true, http: false, sse: true });
  });

  test("the media mapper gives the prompt builder's shape (file is embeddedContext), and nothing when unknown", () => {
    const backend = fromAcp(initialize({ promptCapabilities: { image: true, embeddedContext: true } }));
    expect(mediaCapabilitiesOf(backend)).toEqual({ image: true, audio: false, embeddedContext: true });
    expect(mediaCapabilitiesOf(null)).toBeUndefined();
  });
});

describe("conversationCapabilities of an ACP controller", () => {
  test("never native steering; backend unknown without capabilities", () => {
    expect(conversationCapabilitiesFromAcp(null)).toEqual({ nativeSteering: false, backend: null });
    const acp = initialize({ loadSession: true });
    expect(conversationCapabilitiesFromAcp(acp)).toEqual({ nativeSteering: false, backend: fromAcp(acp) });
  });

  test("reading from a client: absent, not connected yet (NotConnectedError is unknown, not thrown), connected; other errors propagate", () => {
    const acp = initialize({});
    expect(conversationCapabilitiesOf(null).backend).toBeNull();
    expect(conversationCapabilitiesOf(undefined).backend).toBeNull();
    expect(conversationCapabilitiesOf({ get capabilities(): never { throw new NotConnectedError(); } }).backend).toBeNull();
    expect(conversationCapabilitiesOf({ capabilities: acp }).backend).toEqual(fromAcp(acp));
    expect(() => conversationCapabilitiesOf({ get capabilities(): never { throw new Error("boom"); } })).toThrow("boom");
  });

  test("a real controller: null before start (the ACP getter still throws, unchanged), known after, the raw ACP shape preserved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-capabilities-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const controller = new HarnessController({ adapter: { command: ["bun", ECHO] }, adapterId: "fixture", cwd: directory });
    cleanups.push(() => controller.stop());
    expect(controller.conversationCapabilities).toEqual({ nativeSteering: false, backend: null });
    expect(() => controller.capabilities).toThrow();
    await controller.start();
    const after = controller.conversationCapabilities;
    expect(after.nativeSteering).toBe(false);
    expect(after.backend).toEqual(fromAcp(controller.capabilities));
    expect(after.backend?.acp).toBe(controller.capabilities);
    expect(after.backend?.media.image).toBe(controller.capabilities.agent.promptCapabilities.image);
    expect(after.backend?.loadSession).toBe(controller.capabilities.agent.loadSession);
  }, 20_000);

  test("PTY mode: safe to read, backend null, and the ACP getter still throws as before", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-capabilities-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const controller = new HarnessController({
      adapter: { command: ["bun", ECHO], ptyCommand: ["bun", IDLE_PTY] },
      adapterId: "fixture",
      mode: "degraded",
      cwd: directory,
    });
    cleanups.push(() => controller.stop());
    await controller.start();
    expect(controller.isDegraded).toBe(true);
    expect(controller.conversationCapabilities).toEqual({ nativeSteering: false, backend: null });
    expect(() => controller.capabilities).toThrow("requires ACP");
  }, 20_000);
});

describe("on a session", () => {
  test("conversationCapabilities delegates to the controller; capabilities keeps its ACP shape; listing follows the neutral flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-capabilities-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const session = await AgentSession.create({
      adapter: { command: ["bun", ECHO] },
      adapterId: "fixture",
      agentSessionId: "capabilities-session",
      cwd: directory,
    });
    cleanups.push(() => session.stop());
    expect(session.conversationCapabilities).toEqual(session.connection.conversationCapabilities);
    expect(session.conversationCapabilities.backend?.acp).toBe(session.capabilities);
    expect(session.capabilities.agent.promptCapabilities).toBeDefined();
    // The echo agent doesn't advertise listing, so the merged list has no agent half (as before).
    expect(session.conversationCapabilities.backend?.listSessions).toBe(false);
    expect(await session.listSessions()).toEqual([]);
  }, 20_000);

  test("listSessions before the agent is connected still throws NotConnectedError (an unknown backend is not an unsupported one)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-capabilities-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const session = await AgentSession.create({
      adapter: { command: ["bun", ECHO] },
      adapterId: "fixture",
      agentSessionId: "capabilities-before-connect",
      cwd: directory,
    });
    cleanups.push(() => session.stop());
    await session.connection.stop(); // the connection is gone: not connected, as before the first start
    expect(session.conversationCapabilities.backend).toBeNull();
    await expect(session.listSessions()).rejects.toThrow(NotConnectedError);
    await expect(session.listSessions()).rejects.toThrow("AgentController is not started");
  }, 20_000);

  test("listSessions in PTY mode returns the catalog half only, with no error (a known mode without listing)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-capabilities-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const session = await AgentSession.create({
      adapter: { command: ["bun", ECHO], ptyCommand: ["bun", IDLE_PTY], displayName: "fixture" },
      adapterId: "fixture",
      agentSessionId: "capabilities-pty",
      mode: "degraded",
      cwd: directory,
    });
    cleanups.push(() => session.stop());
    expect(session.conversationCapabilities.backend).toBeNull();
    expect(await session.listSessions()).toEqual([]);
  }, 20_000);
});

describe("UnsupportedError", () => {
  test("is a named Error carrying its message", () => {
    const error = new UnsupportedError("listSessions is not supported by this controller");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UnsupportedError");
    expect(error.message).toBe("listSessions is not supported by this controller");
  });
});
