#!/usr/bin/env bun
// Steering feasibility probe. See README.md and .res/somelogs.md/9-22+/10-2-SPEC-steer-pending-messages.md.
//
// Drives the library's steering (`delivery: "steer"`, `interrupt()`, `withdraw()`, the message events)
// against a real harness and measures what the harness does around a cancel: how fast it stops, what it
// keeps, what usage and metering it reports. See the spec for what steering promises.
//
// Like smoke-tests/end-to-end: run it, and `agent.sqlite` appears in this directory with one
// conversation per scenario, so what is STORED can be studied, not only what the API returned.
//
//   bun smoke-tests/test11-steerTurn/index.ts
//
// Configuration (environment variables, all optional):
//   ACP_TEST11_ADAPTER=codex|opencode|mock   default codex. codex and opencode spend real tokens.
//   ACP_TEST11_MODEL=ID                      set the model on the adapter; otherwise its own config is used
//   ACP_TEST11_DATA_DIR=PATH                 where agent.sqlite and results.json go (default: this directory)
//   ACP_TEST11_ONLY=s1,s2,s2b,s3,s4,s5,s6,s7,s8,s9 run only these (s7 runs with s2)
//   ACP_TEST11_RUNS=N                        repetitions for s3 and s6 (default 5)
//   ACP_TEST11_SLEEP_WAIT=SECONDS            how long s5 waits to see if the tool survived (default 22)
//   ACP_TEST11_TURN_TIMEOUT=SECONDS          fail a turn that has not finished after this long (default 240)
//   ACP_TEST11_CHECKPOINT=1                  also enable checkpointing and report whether one is produced
//   ACP_TEST11_QUIET=1                       no live progress lines
//   ACP_TEST11_MOCK_CANCEL_USAGE=none|partial   mock agent only
//
// The previous agent.sqlite in the data directory is replaced on every run. The adapter must already
// be authenticated, and a preflight prompt checks it answers normally before any scenario runs.

import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  Agent,
  createOpencodeMetering,
  formatResponseMessages,
  type Adapter,
  type AgentConversation,
} from "../../src/index.ts";

type AgentSession = AgentConversation;

const here = dirname(fileURLToPath(import.meta.url));
/** ACP_TEST11_<NAME> environment variables, read like flags. */
const env = (key: string): string | undefined => process.env[`ACP_TEST11_${key.toUpperCase().replace(/-/g, "_")}`]?.trim() || undefined;
const args = {
  get: env,
  has: (key: string): boolean => {
    const value = env(key);
    return value !== undefined && value !== "0" && value.toLowerCase() !== "false";
  },
};
const adapterNames = (args.get("adapter") ?? "codex").split(",");
const only = args.get("only") ? new Set(args.get("only")!.split(",")) : null;
const runs = Number(args.get("runs") ?? 5);
const sleepWait = Number(args.get("sleep-wait") ?? 22);
const wants = (id: string): boolean => !only || only.has(id);
const turnTimeoutMs = Number(args.get("turn-timeout") ?? 240) * 1000;
const t0 = Date.now();
/** Live progress, so a slow real harness is visibly working and a hang is visibly a hang. */
const progress = (message: string): void => {
  if (!args.has("quiet")) console.log(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${message}`);
};

const P_SEQUENTIAL =
  "Read a.txt, then b.txt, then c.txt, each with its own tool call, one at a time. Then tell me the three words in order.";
const P_PARALLEL =
  "Read a.txt, b.txt and c.txt in a single step using parallel tool calls, then list the words.";
const P_STORY =
  "Write a detailed 400-word story about a lighthouse keeper named Ottoline. Start with the sentence 'The fog came early.'";
const P_SLEEP = "Run `sleep 20 && echo done > done.txt` in the shell, then tell me the contents of done.txt.";
const P_OK = "Reply with just the word OK.";
const F_LENGTHS = "Also include the length of each word in your final answer.";
const F_LONGEST = "No, actually, only report the length of the longest word.";

interface Check {
  readonly name: string;
  /** null means informational: a measurement, not a pass/fail. */
  readonly ok: boolean | null;
  readonly detail: string;
}
interface Outcome {
  readonly id: string;
  readonly title: string;
  readonly checks: Check[];
  readonly data: Record<string, unknown>;
}

const now = (): number => Math.round(performance.now());
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(["completed", "failed"]);

// --- turn instrumentation ----------------------------------------------------------------

interface TurnLog {
  readonly startedAt: number;
  endedAt: number | null;
  text: string;
  readonly tools: Map<string, string>;
  /** Tool ids first seen after the cancel was issued: the boundary race. */
  readonly announcedAfterCancel: Set<string>;
  chunksAfterCancel: number;
  announcedBeforeFirstSettle: number;
  firstSettleAt: number | null;
  cancelIssuedAt: number | null;
}

interface TurnHooks {
  /** Called when a tool call reaches a terminal status; `inFlight` counts the others. */
  onSettle?: (log: TurnLog, inFlight: number) => void;
  onToolStart?: (log: TurnLog) => void;
  onText?: (log: TurnLog) => void;
}

function startTurn(session: AgentSession, text: string, hooks: TurnHooks = {}) {
  const log: TurnLog = {
    startedAt: now(),
    endedAt: null,
    text: "",
    tools: new Map(),
    announcedAfterCancel: new Set(),
    chunksAfterCancel: 0,
    announcedBeforeFirstSettle: 0,
    firstSettleAt: null,
    cancelIssuedAt: null,
  };
  const inFlight = (): number => [...log.tools.values()].filter((status) => !TERMINAL.has(status)).length;
  const track = (id: string, status: string | undefined): void => {
    const known = log.tools.has(id);
    const previous = log.tools.get(id);
    if (!known) {
      if (log.cancelIssuedAt !== null) log.announcedAfterCancel.add(id);
      if (log.firstSettleAt === null) log.announcedBeforeFirstSettle += 1;
    }
    const next = status ?? previous ?? "pending";
    log.tools.set(id, next);
    if (!known || next !== previous) progress(`tool ${id.slice(0, 18)} ${next}`);
    if (!known) hooks.onToolStart?.(log);
    if (TERMINAL.has(next) && !(previous && TERMINAL.has(previous))) {
      log.firstSettleAt ??= now();
      hooks.onSettle?.(log, inFlight());
    }
  };
  progress(`prompt: ${text.replace(/\s+/g, " ").slice(0, 70)}`);
  const run = session
    .prompt(text, {
      onChunk: (chunk: string) => {
        log.text += chunk;
        if (log.cancelIssuedAt !== null) log.chunksAfterCancel += 1;
        hooks.onText?.(log);
      },
      onActivity: (event: any) => {
        if (event.kind === "tool") track(event.toolCallId, event.status);
        else if (event.kind === "tool_update") track(event.toolCallId, event.status);
      },
    })
    .then((result) => {
      log.endedAt = now();
      progress(`turn ended: ${result.stopReason} after ${log.endedAt - log.startedAt}ms`);
      return result;
    });
  // A harness that never answers must fail the scenario, not hang the whole run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        session.interrupt();
      } catch {}
      reject(new Error(`turn did not finish within ${turnTimeoutMs / 1000}s (text so far: ${log.text.length} chars, tools: ${log.tools.size})`));
    }, turnTimeoutMs);
  });
  const done = Promise.race([run, timeout]).finally(() => clearTimeout(timer));
  done.catch(() => {});
  return { log, done };
}

function cancel(session: AgentSession, log: TurnLog): void {
  // Never cancel a turn that already ended: a late timer would hit the NEXT prompt.
  if (log.cancelIssuedAt !== null || log.endedAt !== null) return;
  log.cancelIssuedAt = now();
  progress("interrupt()");
  session.interrupt();
}

function meterLine(result: { usage?: any; metering?: any } | null): string {
  if (!result) return "—";
  const usage = result.usage ? `reported=${result.usage.totalTokens ?? "?"}` : "reported=none";
  const record = result.metering;
  if (!record) return `${usage} metering=none`;
  const metered = record.usage?.status === "metered"
    ? `tokens=${record.usage.attributable?.totalTokens}`
    : `status=${record.usage?.status}`;
  return `${usage} metering(${metered}, recon=${record.costReconciliation?.status ?? "—"})`;
}

/** The canonical response is `result.messages`; `result.text` is a deprecated projection. */
const textOf = (result: { messages: readonly any[] }): string => formatResponseMessages(result.messages, "\n\n");

const includesAll = (text: string, parts: readonly string[]): boolean =>
  parts.every((part) => text.toLowerCase().includes(part.toLowerCase()));

// --- environment ----------------------------------------------------------------------------

interface Opened {
  readonly session: AgentSession;
  /** Conversation events, in order (message_pending, message_delivered, ...). */
  readonly events: ConversationEvent[];
  /** The persisted records of this conversation, summarized. */
  records(): Promise<RecordLine[]>;
  readonly conversationId: string;
  stop(): Promise<void>;
}
type ConversationEvent = { readonly kind: string; readonly [key: string]: any };

/** One Agent (one agent.sqlite) per adapter run; every scenario is a conversation inside it. */
interface Target {
  readonly name: string;
  readonly databasePath: string;
  open(): Promise<Opened>;
  close(): Promise<void>;
}
interface RecordLine {
  readonly seq: number;
  readonly kind: string;
  readonly role?: string;
  readonly status?: string;
  readonly state?: string;
  readonly action?: string;
  readonly chars?: number;
  readonly preview?: string;
}

/** Plain text of a stored message's content (a string, or text blocks). */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("");
}

const CAPTURE = {
  message: "content",
  tool_call: "content",
  permission: "content",
  configuration: "content",
  native_action: "content",
  protocol: "metadata",
} as const;

const dataDirectory = resolve(args.get("data-dir") ?? here);
const databasePath = join(dataDirectory, "agent.sqlite");

async function openTarget(name: string, cwd: string): Promise<Target> {
  await mkdir(dataDirectory, { recursive: true });
  // Start from an empty database so the file holds exactly this run.
  for (const suffix of ["", "-wal", "-shm", ".agent-owner.sqlite"]) await rm(`${databasePath}${suffix}`, { force: true });

  let adapter: Adapter;
  let defaults: Record<string, unknown> = {};
  let stopExtra: () => Promise<void> = async () => {};
  let afterOpen: (session: AgentSession) => Promise<void> = async (session) => {
    if (args.get("model")) await session.setConfig("model", args.get("model")!);
  };

  if (name === "mock") {
    adapter = { command: ["bun", join(here, "../../test/fixtures/steer-agent.ts")], displayName: "Steer mock" };
    process.env.STEER_AGENT_CANCEL_USAGE = args.get("mock-cancel-usage") ?? "none";
  } else if (name === "opencode") {
    adapter = ADAPTERS.opencode;
    const metering = await createOpencodeMetering({ onWarning: (message) => console.log(`  ! ${message}`) });
    defaults = { env: metering.env, metering: { enforcement: "billing_required", inferenceSource: metering.inferenceSource } };
    stopExtra = () => metering.stop();
    const setModel = afterOpen;
    afterOpen = async (session) => {
      if (!(await metering.waitForPlugin())) throw new Error("metering plugin did not load");
      await setModel(session);
      console.log(`  opencode export ${session.internalSessionId ?? "<unavailable>"}`);
    };
  } else {
    const preset = (ADAPTERS as Record<string, Adapter>)[name];
    if (!preset) throw new Error(`unknown adapter: ${name}`);
    adapter = preset;
  }

  const agent = await Agent.open({
    persistence: { kind: "sqlite", path: databasePath },
    adapters: { [name]: adapter },
    defaultAdapterId: name,
    capture: CAPTURE as any,
    conversationDefaults: { cwd, defaultPermission: "approve", ...defaults } as any,
    ...(args.has("checkpoint") ? { checkpointing: { schedule: { milestones: [1], everyAfterMilestones: 50 } } } : {}),
  });

  return {
    name,
    databasePath,
    async open() {
      const session = await agent.conversations.create();
      await afterOpen(session);
      const events: ConversationEvent[] = [];
      session.subscribe((notification) => events.push(notification.event as ConversationEvent));
      return {
        session,
        events,
        conversationId: session.id,
        async records() {
          const page = await agent.persistence.records.list(session.id, { limit: 1000 });
          return page.records.map((record: any): RecordLine => {
            const text = record.kind === "message" ? contentText(record.content) : undefined;
            return {
              seq: record.sequence,
              kind: record.kind,
              ...(record.role ? { role: record.role } : {}),
              ...(record.status ? { status: record.status } : {}),
              ...(record.state ? { state: record.state } : {}),
              ...(record.action ? { action: record.action } : {}),
              ...(text !== undefined ? { chars: text.length, preview: text.slice(0, 40).replace(/\s+/g, " ") } : {}),
            };
          });
        },
        stop: () => session.stop().catch(() => {}),
      };
    },
    async close() {
      await agent.close().catch(() => {});
      await stopExtra().catch(() => {});
    },
  };
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "acp-steer-smoke-"));
  await writeFile(join(root, "a.txt"), "kiwi\n");
  await writeFile(join(root, "b.txt"), "banana\n");
  await writeFile(join(root, "c.txt"), "fig\n");
  await writeFile(join(root, "notes.md"), "# Notes\nNothing to see here.\n");
  return root;
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// --- scenarios --------------------------------------------------------------------------------

async function withSession<T>(t: Target, root: string, fn: (opened: Opened) => Promise<T>): Promise<T> {
  progress("opening a conversation...");
  const opened = await t.open();
  progress("conversation ready");
  try {
    return await fn(opened);
  } finally {
    await opened.stop().catch(() => {});
  }
}

/** One line per kind (and role/status), so a scenario's stored shape is readable at a glance. */
function storedShape(lines: readonly RecordLine[]): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = [line.kind, line.role, line.status ?? line.state].filter(Boolean).join(":");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key}×${count}`).join(" ");
}

/** The stored messages in order: who, status, length. This is where a partial output shows up. */
function storedMessages(lines: readonly RecordLine[]): string {
  return lines
    .filter((line) => line.kind === "message")
    .map((line) => `${line.role}(${line.status ?? "—"},${line.chars ?? 0}ch${line.preview ? `,"${line.preview}"` : ""})`)
    .join(" → ");
}

async function checkpointCheck(opened: Opened): Promise<Check[]> {
  if (!args.has("checkpoint")) return [];
  const deadline = Date.now() + 15_000;
  let found: RecordLine | undefined;
  while (Date.now() < deadline && !found) {
    found = (await opened.records()).find((line) => line.kind === "native_action" && line.action === "conversation_checkpoint");
    if (!found) await sleep(1000);
  }
  return [{ name: "checkpoint produced after the cancelled turn", ok: null, detail: found ? `state=${found.state}` : "none within 15s" }];
}

async function s1Control(t: Target, root: string): Promise<Outcome> {
  return withSession(t, root, async (opened) => {
    const session = opened.session;
    const turn = startTurn(session, P_SEQUENTIAL);
    const result = await turn.done;
    const records = await opened.records();
    return {
      id: "s1",
      title: "Control: tool task run to completion",
      checks: [
        { name: "completed", ok: result.stopReason === "end_turn", detail: `stopReason=${result.stopReason}` },
        { name: "answer has the three words", ok: includesAll(textOf(result), ["kiwi", "banana", "fig"]), detail: textOf(result).slice(0, 120) },
        { name: "tool calls", ok: null, detail: String(turn.log.tools.size) },
        { name: "duration ms", ok: null, detail: String((turn.log.endedAt ?? 0) - turn.log.startedAt) },
        { name: "metering", ok: null, detail: meterLine(result) },
        { name: "stored records", ok: null, detail: storedShape(records) },
        { name: "conversation id (look it up in agent.sqlite)", ok: null, detail: opened.conversationId },
      ],
      data: { tools: turn.log.tools.size, records },
    };
  });
}

const eventLine = (events: readonly ConversationEvent[]): string =>
  events
    .filter((event) => event.kind.startsWith("message_"))
    .map((event) => (event.kind === "message_delivered" ? `delivered(${event.ids.length} via ${event.via})` : event.kind.replace("message_", "")))
    .join(" → ") || "none";

/** A message handle's promise, bounded so a stuck delivery fails the scenario instead of hanging it. */
function settled<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`steered message was not answered within ${turnTimeoutMs / 1000}s`)), turnTimeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function boundarySteer(t: Target, root: string, combined: boolean): Promise<Outcome[]> {
  return withSession(t, root, async (opened) => {
    const session = opened.session;
    let steered: ReturnType<AgentSession["prompt"]>[] = [];
    // The message is sent while the turn runs, at its first tool call. The library decides when it lands.
    const first = startTurn(session, P_SEQUENTIAL, {
      onToolStart: () => {
        if (steered.length > 0) return;
        steered = combined
          ? [session.prompt({ text: F_LENGTHS, delivery: "steer" }), session.prompt({ text: F_LONGEST, delivery: "steer" })]
          : [session.prompt({ text: F_LENGTHS, delivery: "steer" })];
        progress(`sent ${steered.length} steer message(s)`);
      },
    });
    const r1 = await first.done;
    const answers = await settled(Promise.all(steered));
    const r2 = answers[0]!;
    const records = await opened.records();
    const checkpoint = await checkpointCheck(opened);

    const outcomes: Outcome[] = [];
    const answerOk = combined
      ? /6/.test(textOf(r2)) && /banana/i.test(textOf(r2))
      : includesAll(textOf(r2), ["kiwi", "banana", "fig"]) && /4/.test(textOf(r2)) && /6/.test(textOf(r2)) && /3/.test(textOf(r2));
    const userRecords = records.filter((line) => line.kind === "message" && line.role === "user").length;
    outcomes.push({
      id: combined ? "s2b" : "s2",
      title: combined ? "Two steer messages, delivered together" : "Steer message delivered at a tool boundary",
      checks: [
        { name: "steer message was sent", ok: steered.length > 0, detail: `${steered.length} message(s) after ${first.log.tools.size} tool call(s)` },
        { name: "first turn ended cancelled by the steer", ok: r1.stopReason === "cancelled" && r1.endedBy === "steer", detail: `stopReason=${r1.stopReason} endedBy=${r1.endedBy}` },
        { name: "followedBy lists the delivered messages", ok: JSON.stringify(r1.followedBy) === JSON.stringify(steered.map((handle) => handle.id)), detail: JSON.stringify(r1.followedBy) },
        { name: "follow-up turn completed", ok: r2.stopReason === "end_turn", detail: `stopReason=${r2.stopReason}` },
        ...(combined ? [{ name: "both messages went out as one operation", ok: answers.every((answer) => answer === r2), detail: `operationId=${r2.operationId}` }] : []),
        { name: combined ? "answer reflects the correction (longest only)" : "answer keeps the task and uses the new instruction", ok: answerOk, detail: textOf(r2).slice(0, 160) },
        { name: "message events", ok: null, detail: eventLine(opened.events) },
        { name: "metering, cancelled turn", ok: null, detail: meterLine(r1) },
        { name: "metering, follow-up turn", ok: null, detail: meterLine(r2) },
        { name: "session metering", ok: null, detail: `blocked=${session.meteringSnapshot.blocked} operations=${session.meteringSnapshot.operationCount}` },
        { name: "stored records", ok: null, detail: storedShape(records) },
        { name: "stored user messages (one per message sent)", ok: null, detail: String(userRecords) },
        { name: "stored messages (the cancelled turn's partial output?)", ok: null, detail: storedMessages(records) },
        ...checkpoint,
        { name: "conversation id (look it up in agent.sqlite)", ok: null, detail: opened.conversationId },
      ],
      data: { records, events: opened.events.filter((event) => event.kind.startsWith("message_")) },
    });

    if (!combined && wants("s7")) {
      const memory = startTurn(session, "What did a.txt contain? Answer from memory, do not use any tools.");
      const r3 = await memory.done;
      outcomes.push({
        id: "s7",
        title: "Continuity: completed work survives the cancel",
        checks: [
          { name: "answers correctly", ok: /kiwi/i.test(textOf(r3)), detail: textOf(r3).slice(0, 80) },
          { name: "no new tool calls", ok: memory.log.tools.size === 0, detail: String(memory.log.tools.size) },
        ],
        data: {},
      });
    }
    return outcomes;
  });
}

async function raceScenario(t: Target, root: string, id: string, title: string, prompt: string): Promise<Outcome> {
  const stops: string[] = [];
  const endedBy: string[] = [];
  const tools: number[] = [];
  let answered = 0;
  for (let run = 0; run < runs; run += 1) {
    await withSession(t, root, async ({ session }) => {
      let steered: ReturnType<AgentSession["prompt"]> | undefined;
      const turn = startTurn(session, prompt, {
        onToolStart: () => {
          steered ??= session.prompt({ text: "Also list the file names.", delivery: "steer" });
        },
      });
      const result = await turn.done;
      stops.push(result.stopReason);
      endedBy.push(result.endedBy ?? "-");
      tools.push(turn.log.tools.size);
      if (steered) {
        await settled(steered);
        answered += 1;
      }
    });
  }
  return {
    id,
    title,
    checks: [
      { name: "runs", ok: null, detail: String(runs) },
      { name: "tool calls in the first turn, per run", ok: null, detail: tools.join(",") },
      { name: "first turn stop reason, per run", ok: null, detail: stops.join(",") },
      { name: "first turn endedBy, per run", ok: null, detail: endedBy.join(",") },
      { name: "steer message answered", ok: null, detail: `${answered}/${runs}` },
    ],
    data: { stops, endedBy, tools, answered },
  };
}

const s3Race = (t: Target, root: string): Promise<Outcome> =>
  raceScenario(t, root, "s3", "Several tool calls in one response, with a steer message", P_PARALLEL);

async function s4Text(t: Target, root: string): Promise<Outcome> {
  return withSession(t, root, async (opened) => {
    const session = opened.session;
    let steered: ReturnType<AgentSession["prompt"]> | undefined;
    const first = startTurn(session, P_STORY, {
      onText: (log) => {
        if (steered || log.text.length < 300) return;
        steered = session.prompt({ text: "Stop. Summarize in one sentence what you wrote so far.", delivery: "steer" });
        log.cancelIssuedAt = now();
        session.interrupt();
      },
    });
    const r1 = await first.done;
    const partial = first.log.text.length;
    const r2 = await settled(steered!);
    const records = await opened.records();
    return {
      id: "s4",
      title: "Text-only turn: steer message plus interrupt() mid-generation",
      checks: [
        { name: "interrupted after streaming", ok: steered !== undefined, detail: `after ${partial} chars` },
        { name: "turn ended cancelled by interrupt()", ok: r1.stopReason === "cancelled" && r1.endedBy === "interrupt", detail: `stopReason=${r1.stopReason} endedBy=${r1.endedBy}` },
        { name: "summary reflects the partial story", ok: /ottoline|fog/i.test(textOf(r2)), detail: textOf(r2).slice(0, 160) },
        { name: "message events", ok: null, detail: eventLine(opened.events) },
        { name: "metering, cancelled turn", ok: null, detail: meterLine(r1) },
        { name: "metering, follow-up turn", ok: null, detail: meterLine(r2) },
        { name: "stored records", ok: null, detail: storedShape(records) },
        { name: "stored messages (was the partial story kept?)", ok: null, detail: storedMessages(records) },
        { name: "conversation id (look it up in agent.sqlite)", ok: null, detail: opened.conversationId },
      ],
      data: { partialChars: partial, records },
    };
  });
}

async function s5MidTool(t: Target, root: string): Promise<Outcome> {
  const marker = join(root, "done.txt");
  await rm(marker, { force: true });
  return withSession(t, root, async (opened) => {
    const session = opened.session;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let steered: ReturnType<AgentSession["prompt"]> | undefined;
    const first = startTurn(session, P_SLEEP, {
      onToolStart: (log) => {
        timer ??= setTimeout(() => {
          steered = session.prompt({ text: "Does done.txt exist? Check.", delivery: "steer" });
          log.cancelIssuedAt = now();
          session.interrupt();
        }, 3000);
      },
    });
    const r1 = await first.done;
    if (timer) clearTimeout(timer);
    const r2 = await settled(steered!);
    const existsNow = await exists(marker);
    await sleep(sleepWait * 1000);
    const existsLater = await exists(marker);
    const records = await opened.records();
    return {
      id: "s5",
      title: "interrupt() while a tool is running",
      checks: [
        { name: "interrupt was issued", ok: steered !== undefined, detail: `tools=${first.log.tools.size}` },
        { name: "turn ended cancelled by interrupt()", ok: r1.stopReason === "cancelled" && r1.endedBy === "interrupt", detail: `stopReason=${r1.stopReason} endedBy=${r1.endedBy}` },
        { name: "done.txt right after the cancel", ok: null, detail: String(existsNow) },
        { name: `done.txt after waiting ${sleepWait}s (tool survived the cancel?)`, ok: null, detail: String(existsLater) },
        { name: "agent's own answer", ok: null, detail: textOf(r2).slice(0, 160) },
        { name: "metering, cancelled turn", ok: null, detail: meterLine(r1) },
        { name: "stored records", ok: null, detail: storedShape(records) },
        { name: "conversation id (look it up in agent.sqlite)", ok: null, detail: opened.conversationId },
      ],
      data: { existsNow, existsLater, records },
    };
  });
}

/** withdraw(): a pending message is taken back and its promise settles as cancelled. */
async function s8Withdraw(t: Target, root: string): Promise<Outcome> {
  return withSession(t, root, async (opened) => {
    const session = opened.session;
    let pending: ReturnType<AgentSession["prompt"]> | undefined;
    let withdrew = false;
    let listed = 0;
    const first = startTurn(session, P_SEQUENTIAL, {
      onToolStart: () => {
        if (pending) return;
        pending = session.prompt({ text: F_LENGTHS, delivery: "steer" });
        listed = session.pendingMessages.length;
        withdrew = pending.withdraw();
      },
    });
    const r1 = await first.done;
    const r2 = await settled(pending!);
    return {
      id: "s8",
      title: "withdraw(): a pending message is taken back",
      checks: [
        { name: "message was pending", ok: listed === 1, detail: `pendingMessages=${listed}` },
        { name: "withdraw() returned true", ok: withdrew, detail: String(withdrew) },
        { name: "the running turn was not cancelled", ok: r1.stopReason === "end_turn" && r1.endedBy === undefined, detail: `stopReason=${r1.stopReason}` },
        { name: "withdrawn promise settled as cancelled, no metering", ok: r2.stopReason === "cancelled" && r2.metering === null, detail: `stopReason=${r2.stopReason}` },
        { name: "message events", ok: null, detail: eventLine(opened.events) },
      ],
      data: {},
    };
  });
}

async function s6EndRace(t: Target, root: string): Promise<Outcome> {
  const counts: Record<string, number> = {};
  let stored = "";
  await withSession(t, root, async (opened) => {
    const session = opened.session;
    for (let run = 0; run < runs; run += 1) {
      const turn = startTurn(session, P_OK, { onText: (log) => cancel(session, log) });
      const result = await turn.done;
      counts[result.stopReason] = (counts[result.stopReason] ?? 0) + 1;
    }
    stored = storedMessages(await opened.records());
  });
  return {
    id: "s6",
    title: "Cancel on the first text chunk of a one-word reply",
    checks: [
      { name: "runs", ok: null, detail: String(runs) },
      { name: "stop reasons", ok: null, detail: JSON.stringify(counts) },
      { name: "stored messages", ok: null, detail: stored },
    ],
    data: { counts },
  };
}

/**
 * One tiny prompt before the real scenarios. A harness that answers with an API error (a model its
 * account cannot use, an expired login) still ends the turn normally, with the error as the reply,
 * so without this every scenario would "run" and measure nothing.
 */
async function preflight(t: Target, root: string): Promise<string | null> {
  progress("preflight: one short prompt to check the harness answers normally");
  try {
    return await withSession(t, root, async ({ session }) => {
      const turn = startTurn(session, P_OK);
      const result = await turn.done;
      const text = textOf(result);
      if (/"type"\s*:\s*"error"|invalid_request_error|not supported|unauthori[sz]ed|rate.?limit/i.test(text)) {
        return `the harness replied with an error instead of an answer: ${text.replace(/\s+/g, " ").slice(0, 400)}`;
      }
      if (!/ok/i.test(text)) return `unexpected reply to a one-word prompt: ${text.slice(0, 200)}`;
      return null;
    });
  } catch (error) {
    return String(error);
  }
}

/**
 * Control for the metering findings: two ordinary turns, no cancel and no steering. If the second turn is
 * not metered here either, a `counter_reset` after a steer is not caused by steering.
 */
async function s9PlainTurns(t: Target, root: string): Promise<Outcome> {
  return withSession(t, root, async (opened) => {
    const first = await startTurn(opened.session, "Read a.txt and tell me what it contains. Use your tools.").done;
    const second = await startTurn(opened.session, "Now read b.txt and tell me what it contains. Use your tools.").done;
    const statusOf = (result: { metering?: any }): string => result.metering?.usage?.status ?? "none";
    return {
      id: "s9",
      title: "Control: two plain turns, no cancel (does metering hold?)",
      checks: [
        { name: "first turn metered", ok: statusOf(first) === "metered", detail: `${statusOf(first)} (${meterLine(first)})` },
        { name: "second turn metered", ok: statusOf(second) === "metered", detail: `${statusOf(second)} (${meterLine(second)})` },
        { name: "session metering", ok: null, detail: `blocked=${opened.session.meteringSnapshot.blocked} operations=${opened.session.meteringSnapshot.operationCount}` },
      ],
      data: { first: statusOf(first), second: statusOf(second) },
    };
  });
}

// --- main ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const root = await makeWorkspace();
  const all: Record<string, Outcome[]> = {};
  let failed = 0;

  for (const name of adapterNames) {
    const t = await openTarget(name, root);
    console.log(`\n=== ${name} (workspace ${root}) ===\ndatabase: ${t.databasePath}`);
    if (name !== "mock") {
      const problem = await preflight(t, root);
      if (problem) {
        console.log(`\nPREFLIGHT FAILED for ${name}: ${problem}\nNo scenario was run: the harness is not answering normally, so any result would be meaningless.`);
        failed += 1;
        all[name] = [{ id: "preflight", title: "preflight", checks: [{ name: "harness answers", ok: false, detail: problem }], data: {} }];
        await t.close();
        continue;
      }
      console.log("preflight ok");
    }
    const outcomes: Outcome[] = [];
    const report = (outcome: Outcome): void => {
      console.log(`\n[${outcome.id}] ${outcome.title}`);
      for (const check of outcome.checks) {
        const mark = check.ok === null ? "  ·" : check.ok ? "PASS" : "FAIL";
        if (check.ok === false) failed += 1;
        console.log(`  ${mark} ${check.name}: ${check.detail}`);
      }
    };
    const run = async (id: string, fn: () => Promise<Outcome | Outcome[]>): Promise<void> => {
      if (!wants(id)) return;
      console.log(`\n--- running ${id} ---`);
      let produced: Outcome[];
      try {
        const out = await fn();
        produced = Array.isArray(out) ? out : [out];
      } catch (error) {
        produced = [{ id, title: "scenario error", checks: [{ name: "ran", ok: false, detail: String(error) }], data: {} }];
      }
      for (const outcome of produced) report(outcome);
      outcomes.push(...produced);
    };
    await run("s1", () => s1Control(t, root));
    if (wants("s2") || wants("s7")) await run(wants("s2") ? "s2" : "s7", () => boundarySteer(t, root, false));
    await run("s2b", () => boundarySteer(t, root, true));
    await run("s3", () => s3Race(t, root));
    await run("s4", () => s4Text(t, root));
    await run("s5", () => s5MidTool(t, root));
    await run("s6", () => s6EndRace(t, root));
    await run("s8", () => s8Withdraw(t, root));
    await run("s9", () => s9PlainTurns(t, root));

    all[name] = outcomes;
    await t.close();
  }

  const out = join(dataDirectory, "results.json");
  await writeFile(out, JSON.stringify(all, null, 2));
  console.log(`\nresults: ${out}\ndatabase: ${databasePath}`);
  if (!args.has("keep")) await rm(root, { recursive: true, force: true });
  // Findings on a real harness are measurements; only the mock must pass outright.
  process.exit(adapterNames.includes("mock") && failed > 0 ? 1 : 0);
}

await main();
