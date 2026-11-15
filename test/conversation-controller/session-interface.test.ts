/**
 * The session on the interface (controller-interface spec, Capabilities: every optional member and
 * its guard; Brief B1 step 3). A real session runs against its real `HarnessController`, and against
 * the same controller with every optional member hidden (a core-only controller, as the native one
 * will be): each guard then takes its documented unsupported path, before any metered or durable
 * operation is opened.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession } from "../../src/agent-session.ts";
import { HarnessController } from "../../src/controller.ts";
import { UnsupportedError } from "../../src/errors.ts";
import type { ConversationController } from "../../src/conversation-controller/index.ts";
import {
  createController,
  harnessControllerOf,
  isDegradedController,
} from "../../src/conversation-controller/index.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");
const ECHO = join(FIXTURES, "echo-prompt-agent.ts");
const LIFECYCLE = join(FIXTURES, "lifecycle-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

const OPTIONAL = [
  "prepareInternalPrompt", "availableCommands", "subscribeAvailableCommands", "currentMode", "setMode",
  "reconnect", "listSessions", "bridge", "authenticate",
];

const CORE = [
  "send", "subscribeTurns", "prepareTurn", "abandonTurn", "cancel", "forceStop", "stop", "start", "startFresh",
  "isConnected", "subscribeOutput", "subscribeConnection", "cancelGraceMs", "conversationCapabilities",
  "configOptions", "setConfig", "subscribeUsageUpdate", "currentSessionId",
];

/**
 * A core-only controller over a real one: a plain object (not a `HarnessController`) with the core members
 * delegated (methods bound, properties read live) and no optional member at all.
 */
function coreOnly(controller: ConversationController): ConversationController {
  const stripped: Record<string, unknown> = {};
  for (const name of CORE) {
    Object.defineProperty(stripped, name, {
      enumerable: true,
      configurable: true,
      get() {
        const value = (controller as unknown as Record<string, unknown>)[name];
        return typeof value === "function" ? value.bind(controller) : value;
      },
    });
  }
  return stripped as unknown as ConversationController;
}

async function openSession(fixture = ECHO): Promise<AgentSession> {
  const directory = await mkdtemp(join(tmpdir(), "acp-session-interface-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const session = await AgentSession.create({
    adapter: { command: ["bun", fixture] },
    adapterId: "fixture",
    agentSessionId: `interface-${Math.random().toString(36).slice(2)}`,
    cwd: directory,
    metering: { pricing: false },
  });
  cleanups.push(() => session.stop());
  return session;
}

/** Swaps the session's live controller for a wrapped one (the session reads it through its private field). */
function swapController(session: AgentSession, wrap: (current: ConversationController) => ConversationController): ConversationController {
  const internals = session as unknown as { controller: ConversationController; bindController(controller: ConversationController): void };
  internals.controller = wrap(internals.controller);
  internals.bindController(internals.controller); // the session listens to the controller it holds
  return internals.controller;
}

describe("connection and harnessConnection", () => {
  test("connection is the interface; harnessConnection is the same live HarnessController; capabilities go through it unchanged", async () => {
    const session = await openSession();
    const harness = session.harnessConnection();
    expect(harness).toBeInstanceOf(HarnessController);
    expect(session.connection).toBe(harness as ConversationController);
    expect(session.capabilities).toBe(harness!.capabilities);
    expect(session.conversationCapabilities.backend?.acp).toBe(harness!.capabilities);
  }, 20_000);

  test("a controller that isn't a HarnessController: harnessConnection is null and capabilities says so", async () => {
    const session = await openSession();
    swapController(session, (current) => coreOnly(current));
    // A plain object is not an instance of the class: it stands for a backend that isn't an external harness.
    expect(session.harnessConnection()).toBeNull();
    expect(() => session.capabilities).toThrow(UnsupportedError);
    expect(session.conversationCapabilities.backend).not.toBeNull();
  }, 20_000);

  test("the guards: harnessControllerOf and isDegradedController (a controller without a mode is never degraded)", async () => {
    const session = await openSession();
    const harness = session.harnessConnection()!;
    expect(harnessControllerOf(harness)).toBe(harness);
    expect(isDegradedController(harness)).toBe(false);
    const stripped = coreOnly(harness);
    expect(harnessControllerOf(stripped)).toBeNull();
    expect(isDegradedController(stripped)).toBe(false);
  }, 20_000);

  test("the factory creates a HarnessController for an adapter", () => {
    const created = createController({ adapter: { command: ["bun", ECHO] }, adapterId: "fixture" });
    expect(created).toBeInstanceOf(HarnessController);
  });
});

describe("a core-only controller: each optional member's guard", () => {
  test("the stripped controller really lacks every optional member", async () => {
    const session = await openSession();
    const controller = swapController(session, (current) => coreOnly(current));
    expect(OPTIONAL.filter((name) => name in controller)).toEqual([]);
    expect(controller.isConnected).toBe(true);
  }, 20_000);

  test("commands: none (an empty frozen list), and no subscription is attempted", async () => {
    const session = await openSession();
    swapController(session, (current) => coreOnly(current));
    expect(session.internalSessionCommands).toEqual([]);
    expect(Object.isFrozen(session.internalSessionCommands)).toBe(true);
  }, 20_000);

  test("mode: not degraded; switching fails with UnsupportedError before anything is queued or recorded", async () => {
    const session = await openSession();
    swapController(session, (current) => coreOnly(current));
    const events: string[] = [];
    session.subscribe(({ event }) => { events.push(event.kind); });
    expect(session.isDegraded).toBe(false);
    const queue = (session as unknown as { operations: { enqueue(...args: unknown[]): unknown } }).operations;
    const enqueue = queue.enqueue.bind(queue);
    let enqueued = 0;
    queue.enqueue = (...args: unknown[]) => { enqueued += 1; return enqueue(...args); };
    await expect(session.setMode("degraded")).rejects.toThrow(UnsupportedError);
    expect(enqueued).toBe(0); // refused up front: nothing was queued
    expect(events.filter((kind) => kind === "metering_recorded" || kind.startsWith("turn_") || kind.startsWith("operation_"))).toEqual([]);
    expect(session.state.operation).toBeNull();
  }, 20_000);

  test("bridge and authenticate throw UnsupportedError (synchronously: nothing to wait for)", async () => {
    const session = await openSession();
    swapController(session, (current) => coreOnly(current));
    expect(() => session.bridge()).toThrow(UnsupportedError);
    expect(() => session.authenticate("any")).toThrow(UnsupportedError);
  }, 20_000);

  test("session listing: no agent half, no error, even though the backend says it lists", async () => {
    const session = await openSession();
    expect(session.conversationCapabilities.backend?.listSessions).toBe(false); // echo doesn't list: force the flag
    const real = session.connection;
    swapController(session, () => {
      const stripped = coreOnly(real);
      Object.defineProperty(stripped, "conversationCapabilities", {
        get: () => ({ nativeSteering: false, backend: { ...real.conversationCapabilities.backend!, listSessions: true } }),
      });
      return stripped;
    });
    expect(await session.listSessions()).toEqual([]);
  }, 20_000);

  test("a prompt still runs (the core path needs no optional member)", async () => {
    const session = await openSession();
    swapController(session, (current) => coreOnly(current));
    const result = await session.prompt("hello");
    expect(result.status).toBe("completed");
    expect(result.text).toContain("hello");
  }, 20_000);

  test("reconnect: a core-only controller (no reconnect) is handled as a lost provider session: the default rule starts a fresh one", async () => {
    // The managed, owned and strict variants are in reload-unsupported.test.ts; this is the fully core-only controller.
    const session = await openSession();
    await session.connection.forceStop();
    swapController(session, (current) => coreOnly(current));
    const events: Array<{ kind: string; via?: string }> = [];
    session.subscribe(({ event }) => { events.push(event as never); });
    expect((await session.prompt("again")).status).toBe("completed");
    expect(events.some((event) => event.kind === "provider_reconnected" && event.via === "fresh")).toBe(true);
  }, 30_000);

  test("an internal prompt without prepareInternalPrompt fails with UnsupportedError before any operation is opened", async () => {
    const session = await openSession(LIFECYCLE);
    swapController(session, (current) => coreOnly(current));
    const events: string[] = [];
    session.subscribe(({ event }) => { events.push(event.kind); });
    const internals = session as unknown as { meteredInternalPrompt(...args: unknown[]): Promise<unknown> };
    await expect(internals.meteredInternalPrompt("op-1", "handoff_summary", "summarize", [])).rejects.toThrow(UnsupportedError);
    expect(events.filter((kind) => kind === "metering_recorded" || kind.startsWith("operation_"))).toEqual([]);
  }, 20_000);

  test("a handoff with a generated summary skips the summary when the controller can't run internal prompts", async () => {
    const session = await openSession(LIFECYCLE);
    await session.prompt("remember kiwi");
    swapController(session, (current) => coreOnly(current));
    const events: Array<{ kind: string; [key: string]: unknown }> = [];
    session.subscribe(({ event }) => { events.push(event as never); });
    const result = await session.handoff({ continuation: { kind: "generated" } });
    expect(result.summary).toBe("");
    const meteredOperations = events.filter((event) => event.kind === "metering_recorded").map((event) => (event.record as { operationId: string }).operationId);
    expect(meteredOperations.filter((id) => id.endsWith(":summary"))).toEqual([]);
  }, 30_000);
});
