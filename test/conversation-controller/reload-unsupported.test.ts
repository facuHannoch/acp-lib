/**
 * A controller without `reconnect` (controller-interface spec, capabilities table: "recovery paths skip it,
 * gated with continuation"). The session can't reload the provider session, so it treats that as a session
 * the provider no longer has and the conversation's own continuation rule decides, in each persistence mode
 * (review of 5b311b5). The real controller is wrapped to hide only `reconnect`, and its `reconnect` is
 * spied on to show it is never called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import { AgentSession } from "../../src/agent-session.ts";
import { createConversationRecoveryCheckpointId } from "../../src/checkpointing/ids.ts";
import { ProviderSessionReloadUnsupportedError, UnsupportedError } from "../../src/errors.ts";
import { isMissingProviderSessionError } from "../../src/checkpointing/recovery.ts";
import type { ConversationController } from "../../src/conversation-controller/index.ts";

const LIFECYCLE = resolve(import.meta.dir, "../fixtures/lifecycle-agent.ts");
const command = [process.execPath, LIFECYCLE];

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const events = (value: { subscribe(listener: (notification: { event: any }) => unknown): unknown }) => {
  const seen: any[] = [];
  value.subscribe(({ event }) => { seen.push(event); });
  return seen;
};

/** Hides `reconnect` on the session's live controller, counting the calls the real one would have received. */
function hideReconnect(session: AgentSession): { reconnectCalls(): number; startFreshCalls(): number } {
  const internals = session as unknown as { controller: ConversationController; bindController(controller: ConversationController): void };
  const real = internals.controller;
  let reconnects = 0;
  let fresh = 0;
  const realReconnect = real.reconnect!.bind(real);
  real.reconnect = (id: string) => { reconnects += 1; return realReconnect(id); };
  const realStartFresh = real.startFresh.bind(real);
  real.startFresh = (...args: Parameters<typeof realStartFresh>) => { fresh += 1; return realStartFresh(...args); };
  internals.controller = new Proxy(real, {
    get(target, key) {
      if (key === "reconnect") return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, key) { return key !== "reconnect" && Reflect.has(target, key); },
  });
  internals.bindController(internals.controller);
  return { reconnectCalls: () => reconnects, startFreshCalls: () => fresh };
}

describe("the recovery rule treats a controller that can't reload as a provider that lost the session", () => {
  test("the predicate: the typed error is 'missing' ahead of any caller-supplied classifier; other errors are unchanged", () => {
    const error = new ProviderSessionReloadUnsupportedError();
    expect(error).toBeInstanceOf(UnsupportedError);
    expect(error.name).toBe("ProviderSessionReloadUnsupportedError");
    expect(isMissingProviderSessionError(error)).toBe(true);
    expect(isMissingProviderSessionError(error, () => false)).toBe(true);
    expect(isMissingProviderSessionError(new Error("boom"))).toBe(false);
    expect(isMissingProviderSessionError(new Error("boom"), () => true)).toBe(true);
  });

  test("detached, default rule (start a new session): the prompt runs on a fresh session; reconnect is never called", async () => {
    const directory = await tempDir("acp-reload-detached-");
    const session = await AgentSession.create({
      adapterId: "mock", adapter: { command, cancelGraceMs: 80 }, env: { LIFECYCLE_STATE: join(directory, "sessions.json") }, metering: { pricing: false },
    });
    cleanups.push(() => session.stop());
    const seen = events(session);
    await session.prompt("remember guava");
    const previous = session.internalSessionId;
    await session.connection.forceStop();
    const spy = hideReconnect(session);
    const result = await session.prompt("after");
    expect(result.status).toBe("completed");
    expect(result.text).not.toContain("guava"); // a new session: the continuation rule here starts fresh
    expect(session.internalSessionId).not.toBe(previous);
    expect(spy.reconnectCalls()).toBe(0);
    expect(spy.startFreshCalls()).toBeGreaterThan(0);
    expect(seen.some((event) => event.kind === "provider_reconnected" && event.via === "fresh")).toBe(true);
  }, 30_000);

  test("detached, onFailure 'error': the conversation stops accepting prompts, exactly as for a lost session", async () => {
    const directory = await tempDir("acp-reload-strict-");
    const state = join(directory, "sessions.json");
    const first = await AgentSession.create({ adapterId: "mock", adapter: { command, cancelGraceMs: 80 }, env: { LIFECYCLE_STATE: state }, metering: { pricing: false } });
    await first.prompt("remember plum");
    const id = first.internalSessionId!;
    const strict = await AgentSession.create({
      adapterId: "mock", adapter: { command, cancelGraceMs: 80 }, env: { LIFECYCLE_STATE: state }, metering: { pricing: false },
      providerSession: { kind: "load", internalSessionId: id, onFailure: "error" },
    });
    cleanups.push(() => strict.stop(), () => first.stop());
    await strict.connection.forceStop();
    const spy = hideReconnect(strict);
    expect((await strict.prompt("again").catch((error) => error)).code).toBe("provider_session_missing");
    expect(strict.promptability.blockers).toContain("continuation_unavailable");
    expect(spy.reconnectCalls()).toBe(0);
  }, 30_000);

  test("managed: the configured strategy is reached (the transcript builder runs once) and the prompt completes on a recovered session", async () => {
    const root = await tempDir("acp-reload-managed-");
    const base = {
      adapterId: "mock", adapter: { command, cancelGraceMs: 80 }, env: { LIFECYCLE_STATE: join(root, "sessions.json") },
      metering: { pricing: false as const }, persistence: { root }, agentSessionId: "reload-unsupported-managed",
    };
    const created = await AgentSession.create({ ...base, creationId: "reload-unsupported-1" });
    await created.prompt("remember quince");
    await created.stop();
    let built = 0;
    const session = (await AgentSession.open({
      ...base,
      continuation: {
        strategies: [
          { kind: "load_internal_session" },
          { kind: "new_from_transcript", strategyId: "test-v1", buildContinuation: async () => { built++; return { continuation: "The user asked to remember quince." }; } },
        ],
      },
    })).session;
    cleanups.push(() => session.stop());
    const seen = events(session);
    const previous = session.internalSessionId;
    await session.connection.forceStop();
    const spy = hideReconnect(session);
    expect((await session.prompt("what fruit?")).text).toContain("quince");
    expect(built).toBe(1);
    expect(session.internalSessionId).not.toBe(previous);
    expect(spy.reconnectCalls()).toBe(0);
    expect(seen.some((event) => event.kind === "provider_reconnected" && event.via === "recovered")).toBe(true);
  }, 30_000);

  test("managed with only the load strategy: nothing is left, so ContinuationUnavailableError, as for a lost session", async () => {
    const root = await tempDir("acp-reload-managed-load-");
    const base = {
      adapterId: "mock", adapter: { command, cancelGraceMs: 80 }, env: { LIFECYCLE_STATE: join(root, "sessions.json") },
      metering: { pricing: false as const }, persistence: { root }, agentSessionId: "reload-unsupported-load-only",
    };
    const created = await AgentSession.create({ ...base, creationId: "reload-unsupported-2" });
    await created.prompt("remember quince"); // there is history to continue, so "nothing left" is an error
    await created.stop();
    const session = (await AgentSession.open(base)).session;
    cleanups.push(() => session.stop());
    await session.connection.forceStop();
    hideReconnect(session);
    expect((await session.prompt("after").catch((error) => error)).name).toBe("ContinuationUnavailableError");
    expect(session.promptability.blockers).toContain("continuation_unavailable");
  }, 30_000);

  test("Agent-owned with recovery configured: the conversation recovers in place from its checkpoint", async () => {
    const directory = await tempDir("acp-reload-owned-");
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { mock: { command, cancelGraceMs: 30 } },
      defaultAdapterId: "mock",
      conversationDefaults: { metering: { pricing: false }, env: { LIFECYCLE_STATE: join(directory, "sessions.json") } },
      checkpointing: { schedule: { milestones: [100], everyAfterMilestones: 100 }, recovery: { onLoadFailure: "recover" } },
    });
    cleanups.push(() => agent.close());
    const value = await agent.conversations.create();
    const seen = events(value);
    await value.prompt("remember nectarines");
    const previous = value.internalSessionId;
    const sequence = await agent.persistence.recoveryCheckpoints!.latestMessageSequence(value.id);
    await agent.persistence.recoveryCheckpoints!.publish({
      checkpointId: createConversationRecoveryCheckpointId(),
      agentConversationId: value.id,
      source: "adoption_recap",
      summary: "The user asked to remember nectarines.",
      coveredSequence: sequence,
    });
    await value.connection.forceStop();
    const spy = hideReconnect(value);
    expect((await value.prompt("what fruit?")).text).toContain("nectarines");
    expect(value.internalSessionId).not.toBe(previous);
    expect(spy.reconnectCalls()).toBe(0);
    expect(seen.some((event) => event.kind === "provider_reconnected" && event.via === "recovered")).toBe(true);
  }, 30_000);
});
