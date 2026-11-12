/**
 * Characterization of the turn path as it is before the controller-interface refactor
 * (`.res/somelogs.md/11-11+/library/11-11-SPEC-controller-interface.md`, Brief A1).
 *
 * Each case drives a real conversation on an offline fixture agent and snapshots, after
 * `normalize`: the conversation's turn, message and record events (kind, ids, order), the records
 * written as each persistence mode stores them, and the prompt results. A snapshot that changes in
 * order or ids during the refactor is a regression in the code, never a reason to update it.
 *
 * Cases that write records run in all three persistence modes:
 * - Agent-owned: a conversation of an `Agent` with SQLite persistence (records read back through
 *   `agent.persistence.records`, plus the committed-record bus);
 * - managed: a `SessionManager` session with a v2 transcript (the JSONL transcript read back);
 * - detached: an `AgentSession` with a legacy JSONL transcript (read back as written).
 * The rest run once, in an Agent-owned conversation unless noted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import { AgentSession, type AgentSessionConfig } from "../../src/agent-session.ts";
import type { AgentSessionNotification } from "../../src/agent-conversation-contracts.ts";
import type { OperationLifecycleConfig } from "../../src/operations/contracts.ts";
import { FileAgentSessionStore } from "../../src/persistence/file-registry-store.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { normalize } from "./normalize.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");
const ECHO = join(FIXTURES, "echo-prompt-agent.ts");
const STEER = join(FIXTURES, "steer-agent.ts");
const LIFECYCLE = join(FIXTURES, "lifecycle-agent.ts");
const OPERATIONS = resolve(import.meta.dir, "../../smoke-tests/test5-operations/operations-agent.ts");

type Mode = "agent-owned" | "managed" | "detached";
const MODES: readonly Mode[] = ["agent-owned", "managed", "detached"];

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean().catch(() => undefined);
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-characterization-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

interface OpenOptions {
  readonly fixture: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cancelGraceMs?: number;
  readonly operationLifecycle?: OperationLifecycleConfig;
  readonly defaultPermission?: "approve" | "cancel";
}

interface Opened {
  readonly mode: Mode;
  readonly conversation: AgentSession;
  readonly directory: string;
  /** Records as the mode stores them. Read before `close`. */
  records(): Promise<unknown>;
  close(): Promise<void>;
}

const EVENT_KINDS = new Set([
  "turn_started",
  "turn_completed",
  "turn_failed",
  "message_pending",
  "message_delivered",
  "message_withdrawn",
  "message_held",
  "presentation_recorded",
  "metering_recorded",
  "handoff_started",
  "handoff_completed",
  "handoff_failed",
  "provider_reconnected",
]);

/** An event reduced to its kind, ids and order-relevant fields. */
function compact(event: AgentSessionNotification["event"], stages: boolean): unknown {
  const e = event as Record<string, any>;
  switch (event.kind) {
    case "turn_completed":
      return { kind: e.kind, turnId: e.turnId, status: e.result?.status, stopReason: e.result?.stopReason };
    case "presentation_recorded":
      return { kind: e.kind, id: e.item?.id, itemKind: e.item?.kind, role: e.item?.role, status: e.item?.status };
    case "metering_recorded":
      return { kind: e.kind, operationId: e.record?.operationId, operationKind: e.record?.operationKind, outcome: e.record?.outcome };
    case "handoff_completed":
      return { kind: e.kind, handoffId: e.result?.handoffId, summary: e.result?.summary, providerAttachment: e.result?.providerAttachment };
    case "operation_stage_changed":
      return stages ? { kind: e.kind, operationId: e.activity?.operationId, operationKind: e.activity?.kind, stage: e.activity?.stage } : undefined;
    default:
      return event;
  }
}

/** Collects compact events from a conversation. */
function capture(conversation: AgentSession, options: { stages?: boolean } = {}) {
  const events: unknown[] = [];
  const raw: AgentSessionNotification["event"][] = [];
  conversation.subscribe(({ event }) => {
    raw.push(event);
    if (!EVENT_KINDS.has(event.kind) && !(options.stages && event.kind === "operation_stage_changed")) return;
    const value = compact(event, options.stages ?? false);
    if (value !== undefined) events.push(value);
  });
  return { events, raw };
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function openMode(mode: Mode, options: OpenOptions): Promise<Opened> {
  const directory = await tempDir();
  const adapter = {
    command: ["bun", options.fixture, ...(options.args ?? [])],
    ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
  };
  const env = { ...(options.env ?? {}) };
  const shared = {
    env,
    cwd: directory,
    metering: { pricing: false },
    ...(options.operationLifecycle ? { operationLifecycle: options.operationLifecycle } : {}),
    ...(options.defaultPermission ? { defaultPermission: options.defaultPermission } : {}),
  } satisfies Partial<AgentSessionConfig>;

  if (mode === "agent-owned") {
    const agent = await Agent.open({
      persistence: { kind: "sqlite", path: join(directory, "agent.sqlite") },
      adapters: { fixture: adapter },
      defaultAdapterId: "fixture",
      capture: { message: "content", error: "raw" },
      conversationDefaults: {
        metering: { pricing: false },
        env,
        cwd: directory,
        ...(options.defaultPermission ? { defaultPermission: options.defaultPermission } : {}),
      },
      ...(options.operationLifecycle ? { operationLifecycle: options.operationLifecycle } : {}),
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await agent.close();
    };
    cleanups.push(close);
    const bus: unknown[] = [];
    agent.events.subscribe((notification) => {
      const record = notification.event.record as unknown as Record<string, unknown>;
      bus.push({ kind: record.kind, recordId: record.recordId, operationId: record.operationId });
    });
    const conversation = await agent.conversations.create();
    return {
      mode,
      conversation,
      directory,
      records: async () => ({
        records: (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records,
        committedBus: bus,
      }),
      close,
    };
  }

  if (mode === "managed") {
    const store = new FileAgentSessionStore({ root: directory });
    const manager = await SessionManager.open({ root: directory, store });
    const conversation = await manager.createAgentSession({
      ...shared,
      adapter,
      adapterId: "fixture",
      agentSessionId: "managed-characterization",
      creationId: "managed-characterization-creation",
      persistence: { transcript: { preset: "activity" } },
    });
    cleanups.push(() => conversation.stop());
    return {
      mode,
      conversation,
      directory,
      records: async () => ({ transcript: await readJsonl(conversation.transcriptPath!) }),
      close: () => conversation.stop(),
    };
  }

  const transcriptPath = join(directory, "detached.jsonl");
  const conversation = await AgentSession.create({
    ...shared,
    adapter,
    adapterId: "fixture",
    agentSessionId: "detached-characterization",
    transcriptPath,
  });
  cleanups.push(() => conversation.stop());
  return {
    mode,
    conversation,
    directory,
    records: async () => ({ transcript: await readJsonl(transcriptPath) }),
    close: () => conversation.stop(),
  };
}

/** Settles a promise into a snapshot-friendly value. */
async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: error };
  }
}

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}

const has = (raw: readonly { kind: string }[], kind: string, count = 1) =>
  () => raw.filter((event) => event.kind === kind).length >= count;

/** Normalizes a run against its own temporary directory and snapshots it. */
function snapshot(opened: { directory: string }, run: Record<string, unknown>): void {
  expect(normalize(run, { paths: [opened.directory, tmpdir()] })).toMatchSnapshot();
}

const SEQUENTIAL = "Read a.txt, then b.txt, then c.txt, each with its own tool call, one at a time. Then tell me the three words in order.";
const LENGTHS = "Also include the length of each word in your final answer.";
const LONGEST = "No, actually, only report the length of the longest word.";

// ---------------------------------------------------------------------------------------------
// Cases that write records: all three modes.
// ---------------------------------------------------------------------------------------------

for (const mode of MODES) {
  describe(`characterization, ${mode}`, () => {
    test("a plain prompt", async () => {
      const opened = await openMode(mode, { fixture: ECHO });
      const { events } = capture(opened.conversation);
      const handle = opened.conversation.prompt("hello");
      const result = await settle(handle);
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { handleId: handle.id, events, results: [result], records });
    }, 20_000);

    test("a second prompt queued behind a running one", async () => {
      const opened = await openMode(mode, { fixture: ECHO });
      const { events, raw } = capture(opened.conversation);
      const first = opened.conversation.prompt("SLOW_TURN first");
      await until(has(raw, "turn_started"));
      const second = opened.conversation.prompt({ text: "second", delivery: "queue" });
      const results = [await settle(first), await settle(second)];
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { handleIds: [first.id, second.id], events, results, records });
    }, 20_000);

    test("two steer messages combined into one run", async () => {
      const opened = await openMode(mode, { fixture: STEER, defaultPermission: "approve" });
      const { events } = capture(opened.conversation);
      let a!: ReturnType<AgentSession["prompt"]>;
      let b!: ReturnType<AgentSession["prompt"]>;
      let fired = false;
      const first = opened.conversation.prompt(SEQUENTIAL, {
        onActivity: (event) => {
          if (event.kind !== "tool" || fired) return;
          fired = true;
          a = opened.conversation.prompt({ text: LENGTHS, delivery: "steer" });
          b = opened.conversation.prompt({ text: LONGEST, delivery: "steer" });
        },
      });
      const firstResult = await settle(first);
      const results = [firstResult, await settle(a), await settle(b)];
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { handleIds: [first.id, a.id, b.id], events, results, records });
    }, 20_000);

    test("an interrupt of the running turn", async () => {
      const opened = await openMode(mode, {
        fixture: LIFECYCLE,
        env: { LIFECYCLE_TOOL_MS: "5000" },
        cancelGraceMs: 80,
      });
      const { events } = capture(opened.conversation);
      const pending = opened.conversation.prompt("[lifecycle:tool]");
      await until(() => opened.conversation.state.operation?.stage === "tool_running");
      opened.conversation.interrupt();
      const result = await settle(pending);
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { handleId: pending.id, events, results: [result], records });
    }, 20_000);

    test("a stalled prompt", async () => {
      const opened = await openMode(mode, {
        fixture: LIFECYCLE,
        cancelGraceMs: 50,
        operationLifecycle: { turns: { firstOutputMs: 30, nextOutputMs: 30 } },
      });
      const { events } = capture(opened.conversation);
      const pending = opened.conversation.prompt("[lifecycle:partial]");
      const result = await settle(pending);
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { handleId: pending.id, events, results: [result], records });
    }, 20_000);

    test("a permission request answered through the handler", async () => {
      const opened = await openMode(mode, { fixture: LIFECYCLE });
      const { events } = capture(opened.conversation);
      const requests: unknown[] = [];
      const pending = opened.conversation.prompt("[lifecycle:permission]", {
        onPermissionRequest: (request) => {
          requests.push(request);
          return { outcome: "selected", optionId: "allow" };
        },
      });
      const result = await settle(pending);
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { handleId: pending.id, events, requests, results: [result], records });
    }, 20_000);

    test("an internal command", async () => {
      const opened = await openMode(mode, { fixture: OPERATIONS, args: ["characterization"] });
      const { events } = capture(opened.conversation);
      const result = await settle(opened.conversation.executeInternalSessionCommand("status"));
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { events, results: [result], records });
    }, 20_000);

    if (mode !== "detached") {
      test("a handoff with a summary", async () => {
        const opened = await openMode(mode, { fixture: LIFECYCLE });
        const { events } = capture(opened.conversation);
        const before = await settle(opened.conversation.prompt("remember kiwi"));
        const handoff = await settle(opened.conversation.handoff({ continuation: { kind: "generated" } }));
        const after = await settle(opened.conversation.prompt("what did I ask?"));
        const records = await opened.records();
        await opened.close();
        snapshot(opened, { events, results: [before, handoff, after], records });
      }, 20_000);
    }
  });
}
