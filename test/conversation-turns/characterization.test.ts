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
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "../../src/agent.ts";
import { AgentSession, type AgentSessionConfig } from "../../src/agent-session.ts";
import { AgentController, type AgentControllerStartEvent } from "../../src/controller.ts";
import { PtyClient } from "../../src/degraded/index.ts";
import type { AgentSessionNotification } from "../../src/agent-conversation-contracts.ts";
import type { OperationLifecycleConfig } from "../../src/operations/contracts.ts";
import { FileAgentSessionStore } from "../../src/persistence/file-registry-store.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { normalize } from "./normalize.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");
const ECHO = join(FIXTURES, "echo-prompt-agent.ts");
const STEER = join(FIXTURES, "steer-agent.ts");
const LIFECYCLE = join(FIXTURES, "lifecycle-agent.ts");
const IDLE_PTY = join(FIXTURES, "idle-pty-agent.ts");
const AUTH_REQUIRED = join(FIXTURES, "auth-required-agent.ts");
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
  /** Agent-owned only: observe each record once it is committed (the committed-record bus). */
  onCommitted?(listener: (record: Record<string, unknown>) => void): void;
  /** The contractual-order checks for this conversation (asserted by `snapshot`). */
  readonly contract: ContractWatch;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Contractual orders (spec, "Which orders are contractual"), asserted explicitly for every case:
// - each stream keeps its own order (records by sequence number, transcript lines by `seq`);
// - a turn's records and metering belong to it, each appears once, record ids are stable;
// - metering is recorded after the provider's result;
// - the final assistant message is recorded before the turn is announced complete;
// - `turn_completed` comes only after metering, the transcript and `afterPrompt` are done.
// They are observed on a separate timeline that is never snapshotted.
// ---------------------------------------------------------------------------------------------

interface ContractWatch {
  /** Violations seen while the conversation ran (checked at the moment of `turn_completed`). */
  readonly violations: string[];
  /** Checks over the whole run: per-stream order, once-only records, metering after the provider. */
  assertRun(mode: Mode, run: Record<string, unknown>): void;
}

function watchContract(
  mode: Mode,
  conversation: AgentSession,
  sources: { readonly transcriptPath?: string; readonly committed?: readonly Record<string, unknown>[] },
): ContractWatch {
  const violations: string[] = [];
  const timeline: string[] = [];
  const position = (entry: string) => timeline.indexOf(entry);
  let openTurn: string | null = null;
  let endedTurns = 0;
  const meteringCount = new Map<string, number>();
  const completed = new Set<string>();

  // The provider's result for the open turn: the controller's own prompt settling with a result.
  // The same promise is returned, so the turn path gains no scheduling point.
  const controller = conversation.connection;
  const prompt = controller.prompt.bind(controller);
  controller.prompt = ((...args: Parameters<typeof prompt>) => {
    const turn = openTurn;
    const result = prompt(...args);
    result.then(() => { if (turn) timeline.push(`provider_result:${turn}`); }, () => undefined);
    return result;
  }) as typeof controller.prompt;

  const transcript = (): Record<string, any>[] => {
    if (!sources.transcriptPath) return [];
    const text = (() => { try { return readFileSync(sources.transcriptPath, "utf8"); } catch { return ""; } })();
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };

  /** Each presentation item's statuses, in arrival order (in-progress may not follow completed). */
  const presentationStatuses = new Map<string, string[]>();
  conversation.subscribe(({ event }) => {
    const e = event as Record<string, any>;
    if (event.kind === "presentation_recorded") {
      const id = String(e.item?.id);
      const turn = id.split(":")[1];
      presentationStatuses.set(id, [...(presentationStatuses.get(id) ?? []), String(e.item?.status)]);
      timeline.push(`presentation:${turn}`);
    }
    if (event.kind === "turn_started") {
      openTurn = e.turnId;
      timeline.push(`turn_started:${e.turnId}`);
    } else if (event.kind === "metering_recorded") {
      const turn = e.record?.operationId as string;
      meteringCount.set(turn, (meteringCount.get(turn) ?? 0) + 1);
      timeline.push(`metering:${turn}`);
    } else if (event.kind === "turn_failed") {
      endedTurns += 1;
      if (openTurn === e.turnId) openTurn = null;
    } else if (event.kind === "turn_completed") {
      endedTurns += 1;
      const turn = e.turnId as string;
      completed.add(turn);
      timeline.push(`turn_completed:${turn}`);
      if (openTurn === turn) openTurn = null;
      if (position(`metering:${turn}`) < 0) violations.push(`turn ${turn} completed before its metering was recorded`);
      if (timeline.lastIndexOf(`presentation:${turn}`) > timeline.lastIndexOf(`turn_completed:${turn}`)) {
        violations.push(`turn ${turn} completed before its last presentation event`);
      }
      const hasMessages = (e.result?.messages?.length ?? 0) > 0;
      if (mode === "agent-owned") {
        // afterPrompt commits the final assistant message(s): they are on the bus before completion.
        const finalRecord = (sources.committed ?? []).some((record) =>
          typeof record.recordId === "string" && new RegExp(`^${turn}:assistant:\\d+$`).test(record.recordId));
        if (hasMessages && !finalRecord) violations.push(`turn ${turn} completed before its final assistant message was committed`);
      } else if (mode === "managed") {
        const lines = transcript().filter((line) => line.operationId === turn);
        if (hasMessages && !lines.some((line) => line.t === "message" && line.role === "assistant" && line.status !== "in_progress")) {
          violations.push(`turn ${turn} completed before its final assistant message was in the transcript`);
        }
        if (!lines.some((line) => line.t === "metering_reference")) violations.push(`turn ${turn} completed before its metering reference was in the transcript`);
        if (!lines.some((line) => line.t === "operation" && line.event !== "started")) violations.push(`turn ${turn} completed before its operation was closed in the transcript`);
      } else {
        const assistantLines = transcript().filter((line) => line.t === "msg" && line.role === "assistant").length;
        if (assistantLines < endedTurns) violations.push(`turn ${turn} completed before its assistant line was in the transcript`);
      }
    }
  });

  return {
    violations,
    assertRun(runMode, run) {
      expect(violations).toEqual([]);
      // Presentation events keep their own order: no item goes back to in progress once completed.
      for (const [id, statuses] of presentationStatuses) {
        const completedAt = statuses.findIndex((status) => status !== "in_progress");
        if (completedAt >= 0) expect({ id, after: statuses.slice(completedAt).filter((status) => status === "in_progress") }).toEqual({ id, after: [] });
      }
      // Managed bounds: each turn's metering sits after its turn_started and before its turn_completed.
      for (const turn of completed) {
        expect({ turn, inside: position(`turn_started:${turn}`) < position(`metering:${turn}`)
          && position(`metering:${turn}`) < position(`turn_completed:${turn}`) }).toEqual({ turn, inside: true });
      }
      for (const [turn, count] of meteringCount) expect({ turn, metering: count }).toEqual({ turn, metering: 1 });
      for (const turn of completed) expect({ turn, metered: meteringCount.get(turn) ?? 0 }).toEqual({ turn, metered: 1 });
      // Metering after the provider's result (turns whose result came from this controller).
      for (const entry of timeline.filter((value) => value.startsWith("provider_result:"))) {
        const turn = entry.slice("provider_result:".length);
        const metered = position(`metering:${turn}`);
        if (metered >= 0) expect({ turn, meteringAfterResult: metered > position(entry) }).toEqual({ turn, meteringAfterResult: true });
      }
      const records = run.records as Record<string, any> | undefined;
      if (runMode === "agent-owned" && records?.records) {
        const list = records.records as Record<string, any>[];
        const sequences = list.map((record) => record.sequence as number);
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        expect(new Set(sequences).size).toBe(sequences.length);
        const ids = list.map((record) => record.recordId as string);
        expect(new Set(ids).size).toBe(ids.length);
        const bus = (records.committedBus as Record<string, any>[]).map((record) => record.recordId as string);
        expect(new Set(bus).size).toBe(bus.length);
        for (const id of bus) expect(ids).toContain(id);
        for (const turn of meteringCount.keys()) {
          expect(list.filter((record) => record.kind === "metering" && record.operationId === turn).map((record) => record.recordId))
            .toEqual([`${turn}:metering`]);
        }
      }
      if (runMode === "managed" && records?.transcript) {
        const lines = records.transcript as Record<string, any>[];
        expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1));
        for (const turn of meteringCount.keys()) {
          expect(lines.filter((line) => line.t === "metering_reference" && line.operationId === turn)).toHaveLength(1);
        }
      }
    },
  };
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
      // Background recovery checkpoints (milestone 1 by default) run a second harness session
      // concurrently with each case; they are not the turn path, and one still running when the
      // Agent closes can outlive it (see the A1 report). Off, so each case is only its turn path.
      checkpointing: { enabled: false },
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
    const committed: Record<string, unknown>[] = [];
    const committedListeners: Array<(record: Record<string, unknown>) => void> = [];
    agent.events.subscribe((notification) => {
      const record = notification.event.record as unknown as Record<string, unknown>;
      bus.push({ kind: record.kind, recordId: record.recordId, operationId: record.operationId });
      committed.push(record);
      for (const listener of committedListeners) listener(record);
    });
    const conversation = await agent.conversations.create();
    const contract = watchContract(mode, conversation, { committed });
    return {
      contract,
      mode,
      conversation,
      directory,
      records: async () => ({
        records: (await agent.persistence.records.list(conversation.id, { limit: 1000 })).records,
        committedBus: bus,
      }),
      onCommitted: (listener) => { committedListeners.push(listener); },
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
    const contract = watchContract(mode, conversation, { transcriptPath: conversation.transcriptPath! });
    return {
      contract,
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
  const contract = watchContract(mode, conversation, { transcriptPath });
  return {
    contract,
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
function snapshot(
  opened: { directory: string; mode?: Mode; contract?: ContractWatch },
  run: Record<string, unknown>,
  extraPaths: readonly string[] = [],
): void {
  if (opened.contract && opened.mode) opened.contract.assertRun(opened.mode, run);
  const compared = opened.mode ? withNonContractualPairsInOneOrder(opened.mode, run) : run;
  expect(normalize(compared, { paths: [opened.directory, ...extraPaths, tmpdir()] })).toMatchSnapshot();
}

// ---------------------------------------------------------------------------------------------
// The one allowed snapshot exception (spec, Risks; decided 2026-11-13, managed mode widened the
// same day). Today's code writes these on separate paths with no fixed order
// (findings/11-13-FINDING-metering-vs-presentation-order.md):
//   - managed: a turn's metering event may sit anywhere among that turn's response presentation
//     events (its presentations other than its user messages, which are written before dispatch).
//     Canonical form: the metering event is moved before the contiguous same-turn response
//     presentations directly ahead of it. It never crosses another kind of event or another turn's
//     events, and the presentations keep their own order;
//   - Agent-owned: a turn's metering record and that turn's last in-progress assistant snapshot
//     record, either order (in the records and on the bus). When adjacent in the other order they
//     are put metering first, and the pair keeps its own two sequence numbers in ascending order.
//     The actual sequence numbers are checked before this, on the raw run (`assertRun`: strictly
//     increasing, unique), so the swap never hides a gap or a duplicate.
// Nothing else moves: everything else in every stream, all content, ids and sequence numbers stay
// strict. The bounds (metering after its turn_started, completion after metering and the last
// presentation, presentations in order) are asserted separately in `watchContract`.
// ---------------------------------------------------------------------------------------------

function withNonContractualPairsInOneOrder(mode: Mode, run: Record<string, unknown>): Record<string, unknown> {
  if (mode === "managed" && Array.isArray(run.events)) {
    return { ...run, events: meteringFirstAmongEvents(run.events as Record<string, any>[]) };
  }
  const records = run.records as Record<string, any> | undefined;
  if (mode === "agent-owned" && records && Array.isArray(records.records)) {
    return {
      ...run,
      records: {
        ...records,
        records: meteringFirstAmongRecords(records.records as Record<string, any>[], true),
        committedBus: meteringFirstAmongRecords(records.committedBus as Record<string, any>[], false),
      },
    };
  }
  return run;
}

/** The turn a presentation item belongs to: `message:<turn>:…` or `<item kind>:<turn>:…`. */
const presentationTurn = (event: Record<string, any>) => String(event.id ?? "").split(":")[1];

/** A presentation event of `turn` other than one of its user messages. */
const isResponsePresentation = (event: Record<string, any>, turn: unknown) =>
  event.kind === "presentation_recorded" && presentationTurn(event) === turn && event.role !== "user";

function meteringFirstAmongEvents(events: readonly Record<string, any>[]): Record<string, any>[] {
  const out = [...events];
  for (let index = 0; index < out.length; index += 1) {
    if (out[index]!.kind !== "metering_recorded") continue;
    const turn = out[index]!.operationId;
    let at = index;
    while (at > 0 && isResponsePresentation(out[at - 1]!, turn)) {
      [out[at - 1], out[at]] = [out[at]!, out[at - 1]!];
      at -= 1;
    }
  }
  return out;
}

function meteringFirstAmongRecords(records: readonly Record<string, any>[], sequenced: boolean): Record<string, any>[] {
  const out = [...records];
  for (let index = 1; index < out.length; index += 1) {
    const metering = out[index]!;
    if (metering.kind !== "metering") continue;
    const turn = metering.operationId;
    const lastSnapshot = out.reduce((last, record, at) =>
      record.kind === "message" && record.operationId === turn && String(record.recordId).includes(":snapshot:")
        && (!sequenced || (record.role === "assistant" && record.status === "in_progress")) ? at : last, -1);
    if (lastSnapshot !== index - 1) continue;
    const snapshotRecord = out[index - 1]!;
    if (sequenced) {
      out[index - 1] = { ...metering, sequence: snapshotRecord.sequence };
      out[index] = { ...snapshotRecord, sequence: metering.sequence };
    } else {
      [out[index - 1], out[index]] = [metering, snapshotRecord];
    }
  }
  return out;
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

// ---------------------------------------------------------------------------------------------
// Cases that run once, in an Agent-owned conversation unless noted.
// ---------------------------------------------------------------------------------------------

/** Settles a synchronous read that may throw. */
function read(fn: () => unknown): unknown {
  try {
    return { value: fn() };
  } catch (error) {
    return { threw: error };
  }
}

describe("characterization, once", () => {
  test("a queued message withdrawn, its promise awaited", async () => {
    const opened = await openMode("agent-owned", { fixture: ECHO });
    const { events, raw } = capture(opened.conversation);
    const first = opened.conversation.prompt("SLOW_TURN first");
    await until(has(raw, "turn_started"));
    const queued = opened.conversation.prompt({ text: "withdraw me", delivery: "queue" });
    const withdrew = [queued.withdraw(), queued.withdraw()];
    const results = [await settle(first), await settle(queued)];
    const records = await opened.records();
    await opened.close();
    snapshot(opened, { handleIds: [first.id, queued.id], withdrew, events, results, records });
  }, 20_000);

  test("an interrupt that drops queued messages, their promises awaited", async () => {
    const opened = await openMode("agent-owned", {
      fixture: LIFECYCLE,
      env: { LIFECYCLE_TOOL_MS: "5000" },
      cancelGraceMs: 80,
    });
    const { events } = capture(opened.conversation);
    const running = opened.conversation.prompt("[lifecycle:tool]");
    await until(() => opened.conversation.state.operation?.stage === "tool_running");
    const queuedA = opened.conversation.prompt({ text: "queued a", delivery: "queue" });
    const queuedB = opened.conversation.prompt({ text: "queued b", delivery: "steer" });
    opened.conversation.interrupt({ clearQueue: true });
    const results = [await settle(running), await settle(queuedA), await settle(queuedB)];
    const records = await opened.records();
    await opened.close();
    snapshot(opened, { handleIds: [running.id, queuedA.id, queuedB.id], events, results, records });
  }, 20_000);

  test("a provider that fails to start: the prompt rejects with turn_failed", async () => {
    const directory = await tempDir();
    const flag = join(directory, "fail-load");
    const opened = await openMode("agent-owned", {
      fixture: LIFECYCLE,
      env: { LIFECYCLE_STATE: join(directory, "sessions.json"), LIFECYCLE_FAIL_LOAD_FILE: flag },
    });
    const { events, raw } = capture(opened.conversation);
    const before = await settle(opened.conversation.prompt("hello"));
    await writeFile(flag, "1");
    await opened.conversation.connection.forceStop();
    const failing = opened.conversation.prompt("the provider cannot be reattached");
    const failed = await settle(failing);
    const records = await opened.records();
    await opened.close();
    expect(failed).toHaveProperty("rejected");
    expect(raw.some((event) => event.kind === "turn_failed" && event.turnId === failing.id)).toBe(true);
    snapshot(opened, { handleId: failing.id, events, results: [before, failed], records }, [directory]);
  }, 20_000);

  test("a PTY start resolves with an empty session id and no internal_session_acquired (controller)", async () => {
    const directory = await tempDir();
    const controller = new AgentController({
      adapter: { command: ["bun", ECHO], ptyCommand: ["bun", IDLE_PTY] },
      adapterId: "fixture",
      mode: "degraded",
      cwd: directory,
    });
    cleanups.push(() => controller.stop());
    const progress: AgentControllerStartEvent[] = [];
    const result = await controller.start((event) => progress.push(event));
    const again = await controller.start((event) => progress.push(event));
    const state = {
      isConnected: controller.isConnected,
      isDegraded: controller.isDegraded,
      currentSessionId: controller.currentSessionId,
      capabilities: read(() => controller.capabilities),
    };
    await controller.stop();
    snapshot({ directory }, { result, again, progress, state });
  }, 20_000);

  test("session creation refused for authentication: start resolves without a context, connection usable (controller)", async () => {
    const directory = await tempDir();
    const controller = new AgentController({
      adapter: { command: ["bun", AUTH_REQUIRED] },
      adapterId: "fixture",
      cwd: directory,
    });
    cleanups.push(() => controller.stop());
    const progress: AgentControllerStartEvent[] = [];
    const result = await controller.start((event) => progress.push(event));
    const afterStart = {
      isConnected: controller.isConnected,
      currentSessionId: controller.currentSessionId,
      authMethods: controller.authMethods,
    };
    const again = await controller.start((event) => progress.push(event));
    const authenticated = await settle(controller.authenticate("fixture-login"));
    const fresh = await settle(controller.startFresh((event) => progress.push(event)));
    const prompted = await settle(controller.prompt("after login"));
    const afterLogin = { isConnected: controller.isConnected, currentSessionId: controller.currentSessionId };
    await controller.stop();
    snapshot({ directory }, { result, afterStart, again, authenticated, fresh, prompted, afterLogin, progress });
  }, 20_000);

  test("session creation refused for authentication through a conversation (detached)", async () => {
    const directory = await tempDir();
    const outcome = await settle(AgentSession.create({
      adapter: { command: ["bun", AUTH_REQUIRED] },
      adapterId: "fixture",
      agentSessionId: "auth-detached",
      cwd: directory,
      transcriptPath: join(directory, "auth.jsonl"),
    }).then(async (conversation) => {
      cleanups.push(() => conversation.stop());
      const state = { internalSessionId: conversation.internalSessionId, providerConnection: conversation.state.providerConnection };
      const prompted = await settle(conversation.prompt("before login"));
      await conversation.stop();
      return { state, prompted };
    }));
    snapshot({ directory }, { outcome, transcript: await readJsonl(join(directory, "auth.jsonl")) });
  }, 20_000);

  test("bridge from degraded mode and from normal mode (the temporary PTY)", async () => {
    const start = spyOn(PtyClient.prototype, "start");
    const bridge = spyOn(PtyClient.prototype, "bridge");
    const stop = spyOn(PtyClient.prototype, "stop");
    cleanups.push(async () => { start.mockRestore(); bridge.mockRestore(); stop.mockRestore(); });
    const count = () => ({ start: start.mock.calls.length, bridge: bridge.mock.calls.length, stop: stop.mock.calls.length });

    /** Bridges, types a few bytes into the terminal, then the exit chord. */
    async function bridgeOnce(target: { bridge(options?: object): Promise<void> }) {
      const input = new PassThrough();
      const output = new PassThrough();
      let written = "";
      output.on("data", (chunk) => { written += String(chunk); });
      const status: string[] = [];
      const done = target.bridge({ input, output, onStatus: (message: string) => status.push(message.trim()) });
      await until(() => status.length > 0);
      input.write("typed\r");
      await Bun.sleep(50);
      input.write(Buffer.from([0x1d]));
      await done;
      return { status, wroteClearScreen: written.includes("\x1b[2J\x1b[H") };
    }

    // Degraded: the live PTY of the conversation is bridged; no other PTY starts.
    const directory = await tempDir();
    const degraded = new AgentController({
      adapter: { command: ["bun", ECHO], ptyCommand: ["bun", IDLE_PTY], displayName: "fixture" },
      adapterId: "fixture",
      mode: "degraded",
      cwd: directory,
    });
    cleanups.push(() => degraded.stop());
    await degraded.start();
    const beforeDegraded = count();
    const degradedRun = await bridgeOnce(degraded);
    const degradedCalls = { before: beforeDegraded, after: count(), stillConnected: degraded.isConnected };
    await degraded.stop();

    // Normal: a temporary PTY is started, bridged and stopped; the ACP session is untouched.
    const conversation = await AgentSession.create({
      adapter: { command: ["bun", ECHO], ptyCommand: ["bun", IDLE_PTY], displayName: "fixture" },
      adapterId: "fixture",
      agentSessionId: "bridge-normal",
      cwd: directory,
    });
    cleanups.push(() => conversation.stop());
    const sessionBefore = conversation.internalSessionId;
    const beforeNormal = count();
    const normalRun = await bridgeOnce(conversation);
    const normalCalls = { before: beforeNormal, after: count() };
    const after = await settle(conversation.prompt("after bridge"));
    const untouched = {
      sameInternalSession: conversation.internalSessionId === sessionBefore,
      providerConnection: conversation.state.providerConnection,
      mode: conversation.mode,
    };
    await conversation.stop();
    snapshot({ directory }, { degradedRun, degradedCalls, normalRun, normalCalls, untouched, after });
  }, 20_000);

  test("capabilities.agent.promptCapabilities before and after start", async () => {
    const directory = await tempDir();
    const controller = new AgentController({ adapter: { command: ["bun", ECHO] }, adapterId: "fixture", cwd: directory });
    cleanups.push(() => controller.stop());
    const controllerBeforeStart = read(() => controller.capabilities.agent.promptCapabilities);
    await controller.start();
    const controllerAfterStart = read(() => controller.capabilities.agent.promptCapabilities);
    await controller.stop();

    const opened = await openMode("agent-owned", { fixture: ECHO });
    const conversation = opened.conversation;
    const afterCreate = read(() => conversation.capabilities.agent.promptCapabilities);
    await conversation.connection.forceStop();
    const afterForceStop = read(() => conversation.capabilities.agent.promptCapabilities);
    await conversation.prompt("reconnect");
    const afterReconnect = read(() => conversation.capabilities.agent.promptCapabilities);
    await opened.close();
    snapshot(opened, { controllerBeforeStart, controllerAfterStart, afterCreate, afterForceStop, afterReconnect }, [directory]);
  }, 20_000);

  for (const [name, instruction] of [
    ["stalls in a tool and its cancel is acknowledged", "[lifecycle:tool]"],
    ["stalls silently and is cancelled by force", "[lifecycle:silent]"],
  ] as const) {
    test(`an internal prompt (handoff summary) that ${name}`, async () => {
      const opened = await openMode("agent-owned", {
        fixture: LIFECYCLE,
        env: { LIFECYCLE_TOOL_MS: "5000" },
        cancelGraceMs: 50,
        operationLifecycle: { internalInference: { firstOutputMs: 30, nextOutputMs: 30, toolMs: 30 } },
      });
      const { events, raw } = capture(opened.conversation, { stages: true });
      const before = await settle(opened.conversation.prompt("remember kiwi"));
      const turnEventsBefore = raw.filter((event) => event.kind.startsWith("turn_")).length;
      const handoff = await settle(opened.conversation.handoff({
        continuation: { kind: "generated", summaryInstructions: instruction },
      }));
      const turnEventsDuringHandoff = raw.filter((event) => event.kind.startsWith("turn_")).length - turnEventsBefore;
      const records = await opened.records();
      await opened.close();
      expect(turnEventsDuringHandoff).toBe(0);
      snapshot(opened, { events, results: [before, handoff], turnEventsDuringHandoff, records });
    }, 20_000);
  }

  for (const [name, prompt, env, gated] of [
    ["a permission request", "[lifecycle:permission]", {}, false],
    ["a tool start", "[lifecycle:tool]", { LIFECYCLE_TOOL_MS: "150" }, true],
  ] as const) {
    test(`${name} sent the instant the prompt reaches the agent shows in the operation's stages`, async () => {
      // Gated: the fixture ends the turn only after the last chunk's in-progress message snapshot
      // has been committed. In Agent-owned mode that snapshot is queued on the owned-record chain
      // while the metering record is written directly, so a chunk arriving in the same instant as
      // the end of the turn has no fixed order against it; the barrier pins the order the
      // snapshot shows (see the A1 report). The tool start itself still arrives immediately.
      const gate = gated ? join(await tempDir(), "release-end") : null;
      const opened = await openMode("agent-owned", {
        fixture: LIFECYCLE,
        env: { ...env, ...(gate ? { LIFECYCLE_END_GATE_FILE: gate } : {}) },
      });
      const { events } = capture(opened.conversation, { stages: true });
      let pending!: ReturnType<AgentSession["prompt"]>;
      if (gate) {
        opened.onCommitted!((record) => {
          if (record.kind === "message" && record.role === "assistant" && record.status === "in_progress"
            && record.operationId === pending.id) void writeFile(gate, "release\n");
        });
      }
      pending = opened.conversation.prompt(prompt, {
        onPermissionRequest: () => ({ outcome: "selected", optionId: "allow" }),
      });
      const result = await settle(pending);
      const records = await opened.records();
      await opened.close();
      snapshot(opened, { handleId: pending.id, events, results: [result], records });
    }, 20_000);
  }
});
