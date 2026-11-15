/**
 * Runs the conformance suite (`conformance.ts`) on the core-only fake controller and on the real
 * `HarnessController` (lifecycle fixture agent), both in an Agent-owned conversation.
 */
import { afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import type { AgentSession } from "../../src/agent-session.ts";
import type { ConversationController } from "../../src/conversation-controller/index.ts";
import { runConformance, type OpenConversation, type Seen, type Subject } from "./conformance.ts";
import { FakeController } from "./fake-controller.ts";

const LIFECYCLE = resolve(import.meta.dir, "../fixtures/lifecycle-agent.ts");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

/** An Agent-owned conversation, its events and records on one timeline, and a hold on its finalization. */
async function openOwned(options: { stale?: boolean; env?: Record<string, string>; fake?: FakeController }) {
  const directory = await mkdtemp(join(tmpdir(), "acp-conformance-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
    adapters: { mock: { command: ["bun", LIFECYCLE], cancelGraceMs: 80 } },
    defaultAdapterId: "mock",
    capture: { message: "content", error: "raw" },
    checkpointing: { enabled: false },
    conversationDefaults: {
      metering: { pricing: false },
      cwd: directory,
      env: { LIFECYCLE_STATE: join(directory, "sessions.json"), LIFECYCLE_TOOL_MS: "5000", ...options.env },
    },
    ...(options.stale ? { operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } } } : {}),
  });
  cleanups.push(() => agent.close());
  const timeline: string[] = [];
  agent.events.subscribe((notification) => {
    timeline.push(`record:${(notification.event.record as unknown as { recordId: string }).recordId}`);
  });
  const session = await agent.conversations.create();
  const events: Seen[] = [];
  session.subscribe(({ event }) => {
    events.push(event as Seen);
    if (event.kind.startsWith("turn_")) timeline.push(`event:${event.kind}:${(event as { turnId: string }).turnId}`);
  });
  const internals = session as unknown as {
    controller: ConversationController;
    bindController(controller: ConversationController): void;
    ownerLifecycle: { afterPrompt: (input: { operationId: string }) => Promise<unknown> };
  };
  if (options.fake) {
    const real = internals.controller;
    internals.controller = options.fake;
    internals.bindController(options.fake);
    cleanups.push(() => real.stop());
  }
  let gate: Promise<void> = Promise.resolve();
  const afterPrompt = internals.ownerLifecycle.afterPrompt.bind(internals.ownerLifecycle);
  internals.ownerLifecycle.afterPrompt = async (input) => {
    timeline.push(`afterPrompt_held:${input.operationId}`);
    await gate;
    const result = await afterPrompt(input);
    timeline.push(`afterPrompt:${input.operationId}`);
    return result;
  };
  const holdFinalization = () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    return { release };
  };
  return { agent, session: session as AgentSession, events, timeline, holdFinalization, directory };
}

const fakeSubject: Subject = {
  name: "the core-only fake controller",
  async open(options): Promise<OpenConversation> {
    const fake = new FakeController({ scheduling: "session" });
    const owned = await openOwned({ ...options, fake });
    return {
      ...owned,
      isRunning: () => owned.session.state.operation !== null,
      slow() {
        let release!: () => void;
        fake.queueScript({ chunks: ["slow reply"], hold: new Promise<void>((resolve) => { release = resolve; }) });
        return { text: "slow", release: () => release() };
      },
      silent() {
        fake.queueScript({ hold: new Promise<void>(() => undefined) }); // answers only once cancelled
        return "silent";
      },
      async breakProvider() { fake.breakBackend(new Error("backend unreachable")); },
      abandoned: () => fake.abandoned.map((entry) => entry.turnId),
    };
  },
};

const harnessSubject: Subject = {
  name: "the HarnessController (lifecycle fixture agent)",
  async open(options): Promise<OpenConversation> {
    const directory = await mkdtemp(join(tmpdir(), "acp-conformance-flag-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const flag = join(directory, "fail-load");
    const owned = await openOwned({ ...options, env: { LIFECYCLE_FAIL_LOAD_FILE: flag } });
    return {
      ...owned,
      isRunning: () => owned.session.state.operation?.stage === "tool_running",
      slow: () => ({ text: "[lifecycle:tool]", release: () => owned.session.interrupt() }),
      silent: () => "[lifecycle:silent]",
      async breakProvider() {
        await owned.session.connection.forceStop();
        await writeFile(flag, "fail");
      },
    };
  },
};

runConformance(fakeSubject);
runConformance(harnessSubject);

// ---------------------------------------------------------------------------------------------
// HarnessController-only cases (the fake is core-only: it has no optional member, no turnId rule).
// ---------------------------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { HarnessController } from "../../src/controller.ts";

describe("conformance: HarnessController only", () => {
  test("a run without a turn id is an error (a session-scheduled controller reports the turn under the session's id)", async () => {
    const owned = await openOwned({});
    const harness = owned.session.harnessConnection() as HarnessController;
    // `send` checks its run synchronously (as it always has), so it throws rather than returns a rejected promise.
    expect(() => harness.send({ messageIds: ["m1"], operationKind: "prompt" })).toThrow("requires its turnId");
    expect(() => harness.send({ turnId: "t1", messageIds: ["m1", "m1"], operationKind: "prompt" })).toThrow(); // a repeated id too
    expect(owned.events.filter((event) => event.kind === "turn_started")).toHaveLength(0); // neither reported a turn
  }, 30_000);

  test("an internal prompt (a handoff's generated summary) is supervised and metered under its own operation and emits no turn events", async () => {
    const owned = await openOwned({});
    await owned.session.prompt("remember kiwi");
    const turnsBefore = owned.events.filter((event) => event.kind.startsWith("turn_")).length;
    const result = await owned.session.handoff({ continuation: { kind: "generated" } });
    const summaryMetering = owned.events.filter((event) => event.kind === "metering_recorded" && String(event.record.operationId).endsWith(":summary"));
    expect(summaryMetering).toHaveLength(1);
    expect(summaryMetering[0]!.record.operationKind).toBe("handoff_summary");
    expect(owned.events.filter((event) => event.kind.startsWith("turn_"))).toHaveLength(turnsBefore); // the summary is not a turn
    expect(owned.events.some((event) => event.kind === "operation_stage_changed" && event.activity.kind === "handoff_summary" || String(event.activity?.operationId).endsWith(":summary"))).toBe(true);
    expect(result.summary.length).toBeGreaterThan(0);
  }, 30_000);
});
