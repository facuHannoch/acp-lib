/**
 * The contractual watcher (`contract-watch.ts`) against synthetic conversations: each check
 * catches the failure it names, and accepts the correct timeline (A2 review, final-fixes
 * findings: failed-turn metering, last assistant message, synchronous provider throw).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeteringPreflightError } from "../../src/metering/record.ts";
import { ForcedStopError } from "../../src/operations/errors.ts";
import { attributedUsageProblem, type Mode, watchContract } from "./contract-watch.ts";

type Item = Record<string, any>;

const directory = mkdtempSync(join(tmpdir(), "acp-contract-watch-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;
const transcriptFile = (lines: readonly Item[]) => {
  const path = join(directory, `transcript-${files++}.jsonl`);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
  return path;
};

/**
 * A synthetic conversation: its provider `prompt` does what `respond` says, and its metering
 * engine's `open` what `opening` says (resolves by default).
 */
function setup(mode: Mode, sources: { transcriptPath?: string; committed?: Item[] } = {}) {
  let respond: () => Promise<unknown> = () => Promise.resolve({ status: "completed" });
  const listeners: Array<(notification: { event: Item & { kind: string } }) => unknown> = [];
  let opening: () => Promise<unknown> = () => Promise.resolve({});
  const ownerLifecycle = { afterPrompt: (_input: { operationId: string }) => Promise.resolve({}) };
  const conversation = {
    connection: { prompt: (..._args: unknown[]) => respond() },
    metering: { open: (_input: { operationId: string }) => opening() },
    subscribe(listener: (notification: { event: Item & { kind: string } }) => unknown) { listeners.push(listener); },
    ownerLifecycle,
  };
  const contract = watchContract(mode, conversation, sources);
  const emit = (event: Item & { kind: string }) => { for (const listener of listeners) listener({ event }); };
  return {
    contract,
    emit,
    provider: conversation.connection,
    respondWith(next: () => Promise<unknown>) { respond = next; },
    openWith(next: () => Promise<unknown>) { opening = next; },
    /** The session opening the turn's metered operation (as `runTurn` does before dispatch). */
    open: (operationId: string) => conversation.metering.open({ operationId }),
    afterPrompt: (operationId: string) => ownerLifecycle.afterPrompt({ operationId }),
  };
}

/** A record with no attributed usage (the representation today's code uses when none is reported). */
const NO_USAGE = { status: "usage_unavailable", reason: "no usage reported" };
const metering = (turnId: string, usage: Item = NO_USAGE) => ({ kind: "metering_recorded", record: { operationId: turnId, usage } });
/** A `metered` usage result with the given attributed token total (and a rated amount). */
const meteredUsage = (totalTokens: number, amount = "0") => ({
  status: "metered",
  reportedCumulative: { totalTokens: 50_000, inputTokens: 40_000, outputTokens: 10_000 },
  attributable: {
    totalTokens,
    reportedDelta: { totalTokens, inputTokens: totalTokens, outputTokens: 0 },
    input: { reportedTokens: totalTokens, pricedTokens: null, pricing: null },
    output: { reportedTokens: 0, pricedTokens: null, pricing: null },
    ratedTotal: { amounts: [{ amount, currency: "USD" }], unaccounted: 0 },
  },
});
const failedWith = (turnId: string, error: string) => ({ kind: "turn_failed", turnId, error });
const completedWith = (turnId: string, texts: readonly string[]) =>
  ({ kind: "turn_completed", turnId, result: { status: "completed", messages: texts.map((text) => ({ text })) } });
const RECORD_ERROR = "AgentSessionOperationError: provider failed";

/** The turn starts and opens its metered operation, as `runTurn` does before dispatch. */
async function start(w: ReturnType<typeof setup>, turnId = "t1") {
  w.emit({ kind: "turn_started", turnId });
  await w.open(turnId);
}

/** A dispatched turn whose provider rejects; metering, when given, after the rejection settles. */
async function dispatchedRejection(mode: Mode, steps: { metering?: number; meteringFirst?: boolean; error?: string } = {}) {
  const w = setup(mode);
  let reject!: (error: unknown) => void;
  w.respondWith(() => new Promise((_, no) => { reject = no; }));
  w.emit({ kind: "turn_started", turnId: "t1" });
  await w.open("t1");
  const call = w.provider.prompt();
  if (steps.meteringFirst) w.emit(metering("t1"));
  reject(new Error("provider failed"));
  await call.catch(() => undefined);
  for (let index = 0; index < (steps.metering ?? 0); index += 1) w.emit(metering("t1"));
  w.emit(failedWith("t1", steps.error ?? RECORD_ERROR));
  return w;
}

describe("failed turns: metering exactly once after the provider outcome", () => {
  test("a dispatched failed turn with one metering after its outcome passes", async () => {
    const w = await dispatchedRejection("detached", { metering: 1 });
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("a dispatched failed turn with no metering fails (the reviewer's probe)", async () => {
    const w = await dispatchedRejection("detached");
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a dispatched failed turn metered twice fails", async () => {
    const w = await dispatchedRejection("detached", { metering: 2 });
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a dispatched failed turn metered before its outcome fails", async () => {
    const w = await dispatchedRejection("detached", { meteringFirst: true });
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a dispatched failed turn metered after its failure fails", async () => {
    const w = setup("detached");
    w.respondWith(() => Promise.reject(new Error("provider failed")));
    await start(w);
    await w.provider.prompt().catch(() => undefined);
    w.emit(failedWith("t1", RECORD_ERROR));
    w.emit(metering("t1"));
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a dispatched failed turn whose error does not carry the record fails", async () => {
    const w = await dispatchedRejection("detached", { metering: 1, error: "Error: provider failed" });
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a metering preflight rejection, observed as the open's rejection, has no metering", async () => {
    const w = setup("detached");
    w.openWith(() => Promise.reject(new MeteringPreflightError("pricing unavailable: no price")));
    w.emit({ kind: "turn_started", turnId: "t1" });
    await w.open("t1").catch(() => undefined);
    w.emit(failedWith("t1", "AgentSessionOperationError: wrapped elsewhere"));
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
    w.emit(metering("t1"));
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("an open that throws synchronously is a failed open, and the same error is rethrown", () => {
    const w = setup("detached");
    const thrown = new MeteringPreflightError("pricing is disabled but this mode requires rating");
    w.openWith(() => { throw thrown; });
    w.emit({ kind: "turn_started", turnId: "t1" });
    let caught: unknown;
    try { void w.open("t1"); } catch (error) { caught = error; }
    expect(caught).toBe(thrown);
    w.emit(failedWith("t1", String(thrown)));
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("a failure before the open was reached has no metering, whatever its error says", () => {
    for (const error of ["ProviderSessionError: The provider session could not be loaded", RECORD_ERROR]) {
      const w = setup("agent-owned");
      w.emit({ kind: "turn_started", turnId: "t1" });
      w.emit(failedWith("t1", error));
      expect(() => w.contract.assertRun("agent-owned", { records: { records: [], committedBus: [] } })).not.toThrow();
      w.emit(metering("t1"));
      expect(() => w.contract.assertRun("agent-owned", { records: { records: [], committedBus: [] } })).toThrow();
    }
  });

  /** A turn that opened its metered operation and failed before dispatch. */
  async function openedNotDispatched(steps: { metering: boolean; error: string; declared?: 0 | 1 }) {
    const w = setup("detached");
    await start(w);
    if (steps.metering) w.emit(metering("t1"));
    w.emit(failedWith("t1", steps.error));
    if (steps.declared !== undefined) w.contract.expectOpenedNotDispatched("t1", { metering: steps.declared });
    return w;
  }

  test("opened but not dispatched, undeclared: none or one accepted (spec 0013b0f), one checked like any metering", async () => {
    // None: accepted, whatever the error says.
    for (const error of ["Error: beginOperation failed", "ProviderSessionError: x", RECORD_ERROR]) {
      const w = await openedNotDispatched({ metering: false, error });
      expect(() => w.contract.assertRun("detached", {})).not.toThrow();
    }
    // One: accepted before the failure with a record-carrying error; not with a plain error.
    const one = await openedNotDispatched({ metering: true, error: RECORD_ERROR });
    expect(() => one.contract.assertRun("detached", {})).not.toThrow();
    const plain = await openedNotDispatched({ metering: true, error: "Error: plain" });
    expect(() => plain.contract.assertRun("detached", {})).toThrow();
    // Two: never.
    const twice = setup("detached");
    await start(twice);
    twice.emit(metering("t1"));
    twice.emit(metering("t1"));
    twice.emit(failedWith("t1", RECORD_ERROR));
    expect(() => twice.contract.assertRun("detached", {})).toThrow();
  });


  test("opened but not dispatched: its one record must attribute no usage (the reviewer's probe: 999 tokens)", async () => {
    const run = async (usage: Item, declared?: 0 | 1) => {
      const w = setup("detached");
      await start(w);
      w.emit(metering("t1", usage));
      w.emit(failedWith("t1", RECORD_ERROR));
      if (declared !== undefined) w.contract.expectOpenedNotDispatched("t1", { metering: declared });
      return () => w.contract.assertRun("detached", {});
    };
    expect(await run(meteredUsage(999))).toThrow();
    expect(await run(meteredUsage(999), 1)).toThrow();
    expect(await run(meteredUsage(0, "0.01"))).toThrow();
    expect(await run(meteredUsage(0))).not.toThrow();
    expect(await run(NO_USAGE, 1)).not.toThrow();
  });

  test("a dispatched turn's record may attribute usage (only the undispatched one must not)", async () => {
    const w = setup("detached");
    w.respondWith(() => Promise.reject(new Error("provider failed")));
    await start(w);
    await w.provider.prompt().catch(() => undefined);
    w.emit(metering("t1", meteredUsage(999, "0.02")));
    w.emit(failedWith("t1", RECORD_ERROR));
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  const assertOpened = async (steps: { metering: boolean; error: string; declared: 0 | 1 }) => {
    const w = await openedNotDispatched(steps);
    return () => w.contract.assertRun("detached", {});
  };

  test("opened but not dispatched, declared metered once: needs the metering, before the failure, with a record-carrying error", async () => {
    expect(await assertOpened({ metering: true, error: RECORD_ERROR, declared: 1 })).not.toThrow();
    expect(await assertOpened({ metering: false, error: RECORD_ERROR, declared: 1 })).toThrow();
    expect(await assertOpened({ metering: true, error: "Error: plain", declared: 1 })).toThrow();
  });

  test("opened but not dispatched, declared unmetered: no metering allowed", async () => {
    expect(await assertOpened({ metering: false, error: "Error: beginOperation failed", declared: 0 })).not.toThrow();
    expect(await assertOpened({ metering: true, error: RECORD_ERROR, declared: 0 })).toThrow();
  });

  test("a declared metering-close failure has no metering, and only when declared", async () => {
    const undeclared = await dispatchedRejection("detached", { error: "Error: database is locked" });
    expect(() => undeclared.contract.assertRun("detached", {})).toThrow();
    const declared = await dispatchedRejection("detached", { error: "Error: database is locked" });
    declared.contract.expectMeteringWriteFailure("t1", "close");
    expect(() => declared.contract.assertRun("detached", {})).not.toThrow();
    const meteredAnyway = await dispatchedRejection("detached", { metering: 1, error: "Error: database is locked" });
    meteredAnyway.contract.expectMeteringWriteFailure("t1", "close");
    expect(() => meteredAnyway.contract.assertRun("detached", {})).toThrow();
  });

  test("a declared metering-record failure (Agent-owned) has the event but not the record, and only when declared", async () => {
    const noRecord = { records: { records: [], committedBus: [] } };
    const undeclared = await dispatchedRejection("agent-owned", { metering: 1 });
    expect(() => undeclared.contract.assertRun("agent-owned", noRecord)).toThrow();
    const declared = await dispatchedRejection("agent-owned", { metering: 1 });
    declared.contract.expectMeteringWriteFailure("t1", "record");
    expect(() => declared.contract.assertRun("agent-owned", noRecord)).not.toThrow();
    const record = { kind: "metering", operationId: "t1", recordId: "t1:metering", sequence: 1 };
    const withRecord = { records: { records: [record], committedBus: [record] } };
    const recorded = await dispatchedRejection("agent-owned", { metering: 1 });
    expect(() => recorded.contract.assertRun("agent-owned", withRecord)).not.toThrow();
  });

  test("managed: a failed turn's metering reference is required once", async () => {
    const reference = { t: "metering_reference", operationId: "t1", seq: 1 };
    const w = await dispatchedRejection("managed", { metering: 1 });
    expect(() => w.contract.assertRun("managed", { records: { transcript: [reference] } })).not.toThrow();
    expect(() => w.contract.assertRun("managed", { records: { transcript: [] } })).toThrow();
    expect(() => w.contract.assertRun("managed", { records: { transcript: [reference, { ...reference, seq: 2 }] } })).toThrow();
  });
});

describe("completed turns: the expected last assistant message, per mode", () => {
  const TEXTS = ["first message", "second message"];

  /**
   * A completed turn: start and open, `during` (what the turn appends), provider result, metering,
   * (Agent-owned) afterPrompt, then completion.
   */
  async function complete(w: ReturnType<typeof setup>, mode: Mode, texts: readonly string[] = TEXTS, turnId = "t1", during?: () => void) {
    await start(w, turnId);
    during?.();
    await w.provider.prompt();
    w.emit(metering(turnId));
    if (mode === "agent-owned") await w.afterPrompt(turnId);
    w.emit(completedWith(turnId, texts));
  }

  const ownedFinal = (n: number, content: string) => ({ recordId: `t1:assistant:${n}`, content });

  test("Agent-owned: the turn's last final record, with the last message's content, passes", async () => {
    const committed = [ownedFinal(1, TEXTS[0]!), ownedFinal(2, TEXTS[1]!)];
    const w = setup("agent-owned", { committed });
    await complete(w, "agent-owned");
    expect(w.contract.violations).toEqual([]);
    expect(() => w.contract.assertRun("agent-owned", {})).not.toThrow();
  });

  test("Agent-owned: only the earlier message committed fails", async () => {
    const w = setup("agent-owned", { committed: [ownedFinal(1, TEXTS[0]!)] });
    await complete(w, "agent-owned");
    expect(w.contract.violations).toEqual(["turn t1 completed, but its final assistant message t1:assistant:2 was not committed"]);
  });

  test("Agent-owned: a last record with other content, or a record beyond the last, fails", async () => {
    const other = setup("agent-owned", { committed: [ownedFinal(1, TEXTS[0]!), ownedFinal(2, "something else")] });
    await complete(other, "agent-owned");
    expect(other.contract.violations).toHaveLength(1);
    const beyond = setup("agent-owned", { committed: [ownedFinal(1, TEXTS[0]!), ownedFinal(2, TEXTS[1]!), ownedFinal(3, "x")] });
    await complete(beyond, "agent-owned");
    expect(beyond.contract.violations).toHaveLength(1);
  });

  test("Agent-owned: the completion must also come after afterPrompt settled", async () => {
    const w = setup("agent-owned", { committed: [ownedFinal(1, TEXTS[0]!), ownedFinal(2, TEXTS[1]!)] });
    await start(w);
    await w.provider.prompt();
    w.emit(metering("t1"));
    w.emit(completedWith("t1", TEXTS));
    expect(() => w.contract.assertRun("agent-owned", {})).toThrow();
  });

  const managedLine = (n: number, text: string, status = "completed") => ({
    t: "message", role: "assistant", operationId: "t1", status,
    presentation: { id: `message:t1:assistant:${n}`, revision: 1 },
    text, structured: { version: 1, messages: [{ text }] },
  });
  const managedClose = [
    { t: "metering_reference", operationId: "t1" },
    { t: "operation", operationId: "t1", event: "completed" },
  ];

  test("managed: the turn's last message, terminal and with the last text, passes", async () => {
    const w = setup("managed", { transcriptPath: transcriptFile([managedLine(1, TEXTS[0]!), managedLine(2, TEXTS[1]!), ...managedClose]) });
    await complete(w, "managed");
    expect(w.contract.violations).toEqual([]);
  });

  test("managed: only the earlier message terminal fails", async () => {
    const w = setup("managed", { transcriptPath: transcriptFile([managedLine(1, TEXTS[0]!), ...managedClose]) });
    await complete(w, "managed");
    expect(w.contract.violations).toEqual(["turn t1 completed, but its final assistant message message:t1:assistant:2 was not in the transcript as terminal"]);
  });

  test("managed: the last message only in progress, or with other text, fails", async () => {
    const open = setup("managed", { transcriptPath: transcriptFile([managedLine(1, TEXTS[0]!), managedLine(2, TEXTS[1]!, "in_progress"), ...managedClose]) });
    await complete(open, "managed");
    expect(open.contract.violations).toHaveLength(1);
    const other = setup("managed", { transcriptPath: transcriptFile([managedLine(1, TEXTS[0]!), managedLine(2, "partial"), ...managedClose]) });
    await complete(other, "managed");
    expect(other.contract.violations).toHaveLength(1);
  });

  const detachedUser = { t: "msg", role: "user", text: "question" };
  const detachedLine = (texts: readonly string[]) => ({ t: "msg", role: "assistant", messages: texts.map((text) => ({ text })) });
  /** Appends lines to the detached transcript, as the turn does while it runs. */
  const append = (path: string, ...lines: Item[]) => () => appendFileSync(path, lines.map((line) => `\n${JSON.stringify(line)}`).join(""));

  test("detached: the turn's segment, its user line then its one assistant line with its messages, passes", async () => {
    const path = transcriptFile([]);
    const w = setup("detached", { transcriptPath: path });
    await complete(w, "detached", TEXTS, "t1", append(path, detachedUser, detachedLine(TEXTS)));
    expect(w.contract.violations).toEqual([]);
  });

  test("detached: two turns with the same text, each with its own lines, pass", async () => {
    const path = transcriptFile([]);
    const w = setup("detached", { transcriptPath: path });
    await complete(w, "detached", ["same"], "t1", append(path, detachedUser, detachedLine(["same"])));
    await complete(w, "detached", ["same"], "t2", append(path, detachedUser, detachedLine(["same"])));
    expect(w.contract.violations).toEqual([]);
  });

  test("detached: a previous turn's identical line does not stand in for the current turn's (the reviewer's probe)", async () => {
    const path = transcriptFile([detachedUser, detachedLine(["same"])]);
    const w = setup("detached", { transcriptPath: path });
    await complete(w, "detached", ["same"], "t2", append(path, detachedUser));
    expect(w.contract.violations).toEqual(["turn t2 completed, but its transcript segment has 0 assistant lines, not 1"]);
  });

  test("detached: an assistant line holding only the earlier message fails", async () => {
    const path = transcriptFile([]);
    const w = setup("detached", { transcriptPath: path });
    await complete(w, "detached", TEXTS, "t1", append(path, detachedUser, detachedLine([TEXTS[0]!])));
    expect(w.contract.violations).toEqual(["turn t1 completed, but its assistant line does not hold its messages (last message missing or other)"]);
  });

  test("detached: no user line, two assistant lines, or a line after the assistant line, fails", async () => {
    for (const lines of [
      [detachedLine(TEXTS)],
      [detachedUser, detachedLine([TEXTS[0]!]), detachedLine(TEXTS)],
      [detachedUser, detachedLine(TEXTS), detachedUser],
    ]) {
      const path = transcriptFile([]);
      const w = setup("detached", { transcriptPath: path });
      await complete(w, "detached", TEXTS, "t1", append(path, ...lines));
      expect(w.contract.violations).toHaveLength(1);
    }
  });
});

describe("the provider outcome: resolved, rejected, forced, or a synchronous throw", () => {
  const ending = (w: ReturnType<typeof setup>, turnId: string) => {
    w.emit(metering(turnId));
    w.emit(failedWith(turnId, RECORD_ERROR));
  };

  test("a synchronous throw is the outcome, and the same error is rethrown", async () => {
    const w = setup("detached");
    const thrown = new Error("not connected");
    w.respondWith(() => { throw thrown; });
    await start(w);
    let caught: unknown;
    try { void w.provider.prompt(); } catch (error) { caught = error; }
    expect(caught).toBe(thrown);
    ending(w, "t1");
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("a rejected promise is the outcome, and the same promise is returned", async () => {
    const w = setup("detached");
    const rejection = Promise.reject(new Error("transport closed"));
    rejection.catch(() => undefined);
    w.respondWith(() => rejection);
    await start(w);
    const returned = w.provider.prompt();
    expect(returned).toBe(rejection);
    await returned.catch(() => undefined);
    ending(w, "t1");
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("a forced stop is the outcome", async () => {
    const w = setup("detached");
    const forced = new ForcedStopError();
    w.respondWith(() => Promise.reject(forced));
    await start(w);
    await expect(w.provider.prompt()).rejects.toBe(forced);
    w.emit(metering("t1"));
    w.emit(failedWith("t1", `AgentSessionOperationError: ${forced.message}`));
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("a resolved result is the outcome, and the same promise is returned", async () => {
    const w = setup("detached");
    const result = Promise.resolve({ status: "completed" });
    w.respondWith(() => result);
    await start(w);
    expect(w.provider.prompt()).toBe(result);
    await result;
    w.emit(metering("t1"));
    w.emit({ kind: "turn_completed", turnId: "t1", result: { status: "completed", messages: [] } });
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("metering before a still-pending outcome fails, for a completed turn too", async () => {
    const w = setup("detached");
    let resolve!: (value: unknown) => void;
    w.respondWith(() => new Promise((yes) => { resolve = yes; }));
    await start(w);
    const call = w.provider.prompt();
    w.emit(metering("t1"));
    resolve({ status: "completed" });
    await call;
    w.emit({ kind: "turn_completed", turnId: "t1", result: { status: "completed", messages: [] } });
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });
});

describe("the metered-operation boundary", () => {
  /** An open whose settling the test controls. */
  const controlledOpen = (w: ReturnType<typeof setup>) => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    w.openWith(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    return { resolve: (value: unknown = {}) => resolve(value), reject: (error: unknown) => reject(error) };
  };
  const settle = () => new Promise((done) => setTimeout(done, 0));

  test("an open still pending when the turn fails is not 'never opened' (the reviewer's probe)", async () => {
    const w = setup("detached");
    controlledOpen(w);
    w.emit({ kind: "turn_started", turnId: "t1" });
    void w.open("t1");
    w.emit(failedWith("t1", "Error: failed"));
    expect(w.contract.violations).toEqual(["turn t1 ended with its metering open still pending"]);
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a late success, after the turn ended, still fails", async () => {
    const w = setup("detached");
    const open = controlledOpen(w);
    w.emit({ kind: "turn_started", turnId: "t1" });
    const call = w.open("t1");
    w.emit(failedWith("t1", "Error: failed"));
    open.resolve();
    await call;
    expect(w.contract.violations).toEqual(["turn t1 ended with its metering open still pending"]);
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a late rejection, after the turn ended, still fails", async () => {
    const w = setup("detached");
    const open = controlledOpen(w);
    w.emit({ kind: "turn_started", turnId: "t1" });
    const call = w.open("t1");
    w.emit(failedWith("t1", "Error: failed"));
    open.reject(new MeteringPreflightError("late"));
    await call.catch(() => undefined);
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a pending open settled before the turn ends is classified as settled", async () => {
    const w = setup("detached");
    const open = controlledOpen(w);
    w.emit({ kind: "turn_started", turnId: "t1" });
    const call = w.open("t1");
    open.reject(new MeteringPreflightError("pricing unavailable"));
    await call.catch(() => undefined);
    await settle();
    w.emit(failedWith("t1", "MeteringPreflightError: pricing unavailable"));
    expect(w.contract.violations).toEqual([]);
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("a rejected open followed by a successful one, dispatched and completed, fails (the reviewer's probe)", async () => {
    const w = setup("detached");
    let attempts = 0;
    w.openWith(() => (attempts++ === 0 ? Promise.reject(new MeteringPreflightError("first")) : Promise.resolve({})));
    w.emit({ kind: "turn_started", turnId: "t1" });
    await w.open("t1").catch(() => undefined);
    await w.open("t1");
    await w.provider.prompt();
    w.emit(metering("t1"));
    w.emit({ kind: "turn_completed", turnId: "t1", result: { status: "completed", messages: [] } });
    expect(() => w.contract.assertRun("detached", {})).toThrow("opened 2 times (rejected, opened)");
  });

  test("a repeated open passes only with exactly the declared history (no open() retry rule assumed)", async () => {
    const run = async (declared?: readonly ("opened" | "rejected")[]) => {
      const w = setup("detached");
      let attempts = 0;
      w.openWith(() => (attempts++ === 0 ? Promise.reject(new MeteringPreflightError("first")) : Promise.resolve({})));
      w.emit({ kind: "turn_started", turnId: "t1" });
      await w.open("t1").catch(() => undefined);
      await w.open("t1");
      await w.provider.prompt();
      w.emit(metering("t1"));
      w.emit({ kind: "turn_completed", turnId: "t1", result: { status: "completed", messages: [] } });
      if (declared) w.contract.expectOpenAttempts("t1", declared);
      return () => w.contract.assertRun("detached", {});
    };
    expect(await run(["rejected", "opened"])).not.toThrow();
    expect(await run(["opened"])).toThrow("not the declared ones");
    expect(await run(["rejected", "opened", "opened"])).toThrow("not the declared ones");
    expect(await run()).toThrow("must declare the history it expects");
  });

  test("two opens of one operation fail, whether both succeeded or the turn then failed undispatched", async () => {
    const both = setup("detached");
    await start(both);
    await both.open("t1");
    await both.provider.prompt();
    both.emit(metering("t1"));
    both.emit({ kind: "turn_completed", turnId: "t1", result: { status: "completed", messages: [] } });
    expect(() => both.contract.assertRun("detached", {})).toThrow();
    const undispatched = setup("detached");
    let attempts = 0;
    undispatched.openWith(() => (attempts++ === 0 ? Promise.reject(new MeteringPreflightError("first")) : Promise.resolve({})));
    undispatched.emit({ kind: "turn_started", turnId: "t1" });
    await undispatched.open("t1").catch(() => undefined);
    await undispatched.open("t1");
    undispatched.emit(failedWith("t1", "Error: failed"));
    undispatched.contract.expectOpenedNotDispatched("t1", { metering: 0 });
    expect(() => undispatched.contract.assertRun("detached", {})).toThrow();
  });

  test("continuing after a single rejected open fails: to the provider, or to metering", async () => {
    for (const continuation of ["provider", "metering"] as const) {
      const w = setup("detached");
      w.openWith(() => Promise.reject(new MeteringPreflightError("rejected")));
      w.emit({ kind: "turn_started", turnId: "t1" });
      await w.open("t1").catch(() => undefined);
      if (continuation === "provider") await w.provider.prompt();
      w.emit(metering("t1"));
      w.emit(failedWith("t1", RECORD_ERROR));
      expect(() => w.contract.assertRun("detached", {})).toThrow();
    }
  });

  test("a dispatched turn that never opened its metered operation fails", async () => {
    const w = setup("detached");
    w.respondWith(() => Promise.reject(new Error("provider failed")));
    w.emit({ kind: "turn_started", turnId: "t1" });
    await w.provider.prompt().catch(() => undefined);
    w.emit(metering("t1"));
    w.emit(failedWith("t1", RECORD_ERROR));
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });
});

describe("attributed usage of a metering record (the no-usage check)", () => {
  test("no usage: a result other than metered, whatever session-cumulative counter it carries", () => {
    for (const status of ["usage_unavailable", "baseline_required", "counter_reset"]) {
      expect(attributedUsageProblem({ usage: { status, reason: "r" } })).toBeNull();
      expect(attributedUsageProblem({ usage: { status, reason: "r", reportedCumulative: { totalTokens: 9_999, inputTokens: 9_000, outputTokens: 999 } } })).toBeNull();
    }
  });

  test("no usage: metered with every attributed count and the rated total zero (any zero spelling)", () => {
    expect(attributedUsageProblem({ usage: meteredUsage(0) })).toBeNull();
    expect(attributedUsageProblem({ usage: meteredUsage(0, "0.000000") })).toBeNull();
    expect(attributedUsageProblem({ usage: { ...meteredUsage(0), attributable: { ...meteredUsage(0).attributable, ratedTotal: { amounts: [], unaccounted: 0 } } } })).toBeNull();
  });

  test("usage: any non-zero attributed count, a non-zero or incomplete rated total, line items, or no usage result", () => {
    expect(attributedUsageProblem({ usage: meteredUsage(999) })).toContain("totalTokens=999");
    const output = meteredUsage(0);
    expect(attributedUsageProblem({ usage: { ...output, attributable: { ...output.attributable, output: { reportedTokens: 7, pricedTokens: null, pricing: null } } } })).toContain("output.reportedTokens=7");
    expect(attributedUsageProblem({ usage: { ...output, attributable: { ...output.attributable, reportedDelta: { totalTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 3 } } } })).toContain("reportedDelta.thoughtTokens=3");
    expect(attributedUsageProblem({ usage: meteredUsage(0, "0.01") })).toContain("ratedTotal amounts other than zero");
    expect(attributedUsageProblem({ usage: { ...output, attributable: { ...output.attributable, ratedTotal: { amounts: [], unaccounted: 1 } } } })).toContain("ratedTotal.unaccounted=1");
    expect(attributedUsageProblem({ usage: { ...output, attributable: { ...output.attributable, lineItems: [{}] } } })).toContain("line items");
    expect(attributedUsageProblem({})).toContain("no usage result");
    expect(attributedUsageProblem({ usage: { status: "metered" } })).toContain("without attributable usage");
  });
});

describe("usage shapes: only recognized, complete shapes establish no usage (review 5305c43)", () => {
  const zeroAttributable = meteredUsage(0).attributable;
  const withAttributable = (patch: Item) => ({ usage: { ...meteredUsage(0), attributable: { ...zeroAttributable, ...patch } } });
  const without = (key: string) => {
    const { [key]: _dropped, ...rest } = zeroAttributable as Item;
    return { usage: { ...meteredUsage(0), attributable: rest } };
  };

  test("the reviewer's probes fail: an unknown status, an empty attributable, an empty rated total", () => {
    expect(attributedUsageProblem({ usage: { status: "unknown_future_status", attributable: { totalTokens: 999 } } })).toContain("unrecognized usage status");
    expect(attributedUsageProblem({ usage: { status: "unknown_future_status", reason: "r" } })).toContain("unrecognized usage status");
    expect(attributedUsageProblem({ usage: { status: "metered", attributable: {} } })).toContain("not established");
    expect(attributedUsageProblem(withAttributable({ ratedTotal: {} }))).toContain("ratedTotal missing");
  });

  test("a known non-metered result must be complete and carry no attributable usage", () => {
    expect(attributedUsageProblem({ usage: { status: "usage_unavailable" } })).toContain("without a string reason");
    expect(attributedUsageProblem({ usage: { status: "counter_reset", reason: "r", attributable: { totalTokens: 999 } } })).toContain("carrying attributable usage");
  });

  test("a metered result missing any required field fails", () => {
    for (const key of ["totalTokens", "reportedDelta", "input", "output", "ratedTotal"]) {
      expect({ key, problem: attributedUsageProblem(without(key)) ?? "accepted" }).not.toEqual({ key, problem: "accepted" });
    }
    expect(attributedUsageProblem(withAttributable({ reportedDelta: { totalTokens: 0, inputTokens: 0 } }))).toContain("reportedDelta.outputTokens missing");
    expect(attributedUsageProblem(withAttributable({ ratedTotal: { amounts: [] } }))).toContain("ratedTotal.unaccounted missing");
    expect(attributedUsageProblem(withAttributable({ output: {} }))).toContain("output.reportedTokens missing");
  });

  test("ill-typed or non-zero fields fail", () => {
    expect(attributedUsageProblem(withAttributable({ totalTokens: "0" }))).toContain("totalTokens missing or not a number");
    expect(attributedUsageProblem(withAttributable({ reportedDelta: { totalTokens: 0, inputTokens: 0, outputTokens: 0, tokens: 5 } }))).toContain("not a TokenUsage field");
    expect(attributedUsageProblem(withAttributable({ input: { reportedTokens: 0, pricedTokens: 5, pricing: null } }))).toContain("input.pricedTokens=5");
    expect(attributedUsageProblem(withAttributable({ input: { reportedTokens: 0, pricedTokens: 0, pricing: { ratedCost: { amount: "0.5", currency: "USD" } } } }))).toContain("input.pricing without a zero ratedCost");
    expect(attributedUsageProblem(withAttributable({ input: { reportedTokens: 0, pricedTokens: 0, pricing: {} } }))).toContain("input.pricing without a zero ratedCost");
    expect(attributedUsageProblem(withAttributable({ thought: { reportedTokens: 3, pricedTokens: null, pricing: null } }))).toContain("thought.reportedTokens=3");
    expect(attributedUsageProblem(withAttributable({ ratedTotal: { amounts: [{ amount: "abc", currency: "USD" }], unaccounted: 0 } }))).toContain("ratedTotal amounts");
    expect(attributedUsageProblem(withAttributable({ ratedTotal: { amounts: [{ amount: "0" }], unaccounted: 0 } }))).toContain("ratedTotal amounts");
    expect(attributedUsageProblem(withAttributable({ lineItems: [{ totalTokens: 0 }] }))).toContain("line items");
  });

  test("recognized, complete zero shapes pass, with optional parts present or absent, cumulative counters ignored", () => {
    for (const status of ["usage_unavailable", "baseline_required", "counter_reset"]) {
      expect(attributedUsageProblem({ usage: { status, reason: "r" } })).toBeNull();
      expect(attributedUsageProblem({ usage: { status, reason: "r", reportedCumulative: { totalTokens: 9, inputTokens: 9, outputTokens: 0 } } })).toBeNull();
    }
    expect(attributedUsageProblem({ usage: meteredUsage(0) })).toBeNull();
    expect(attributedUsageProblem(withAttributable({
      reportedDelta: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 },
      input: { reportedTokens: 0, pricedTokens: 0, pricing: { unitPrice: { amount: "3", currency: "USD", perTokens: 1_000_000 }, ratedCost: { amount: "0.000000", currency: "USD" } } },
      cachedRead: { reportedTokens: 0, pricedTokens: null, pricing: null },
      cachedWrite: { reportedTokens: 0, pricedTokens: null, pricing: null },
      thought: { reportedTokens: 0, pricedTokens: null, pricing: null },
      ratedTotal: { amounts: [], unaccounted: 0 },
      lineItems: [],
    }))).toBeNull();
  });

  test("through the watcher: an undispatched turn with any of the reviewer's probe records fails", async () => {
    for (const usage of [
      { status: "unknown_future_status", attributable: { totalTokens: 999 } },
      { status: "metered", attributable: {} },
      { ...meteredUsage(0), attributable: { ...zeroAttributable, ratedTotal: {} } },
    ]) {
      const w = setup("detached");
      await start(w);
      w.emit(metering("t1", usage));
      w.emit(failedWith("t1", RECORD_ERROR));
      expect(() => w.contract.assertRun("detached", {})).toThrow();
    }
  });
});

// Real sessions on the offline echo fixture, with one runtime method of the test's own session
// made to fail right after the metered operation opened. They establish today's behaviour on each
// side of the boundary and that the watcher refuses the undecided class until it is declared.
describe("opened but not dispatched, on real sessions (today's behaviour)", () => {
  const ECHO = join(import.meta.dir, "../fixtures/echo-prompt-agent.ts");
  const adapter = { command: ["bun", ECHO] };
  const shared = { cwd: directory, metering: { pricing: false } } as const;
  type Session = import("../../src/agent-session.ts").AgentSession;

  const run = async (mode: Mode, conversation: Session, transcriptPath: string) => {
    const contract = watchContract(mode, conversation, { transcriptPath });
    const kinds: string[] = [];
    let failedTurn = "";
    const records: Item[] = [];
    conversation.subscribe(({ event }) => {
      kinds.push(event.kind);
      if (event.kind === "turn_failed") failedTurn = event.turnId;
      if (event.kind === "metering_recorded") records.push(event.record as unknown as Item);
    });
    let providerCalls = 0;
    const prompt = conversation.connection.prompt.bind(conversation.connection);
    conversation.connection.prompt = ((...args: Parameters<typeof prompt>) => { providerCalls += 1; return prompt(...args); }) as typeof prompt;
    let outcome = "resolved";
    try { await conversation.prompt("hello"); } catch (error) { outcome = String(error); }
    const metering = kinds.filter((kind) => kind === "metering_recorded").length;
    return { contract, providerCalls, outcome, metering, failedTurn, records };
  };

  test("managed: beginOperation failing after the open: not dispatched, not metered (today's managed outcome, pinned); declared 0 passes, 1 fails", async () => {
    const { SessionManager } = await import("../../src/session-manager.ts");
    const { FileAgentSessionStore } = await import("../../src/persistence/file-registry-store.ts");
    const root = mkdtempSync(join(directory, "managed-"));
    const manager = await SessionManager.open({ root, store: new FileAgentSessionStore({ root }) });
    const conversation = await manager.createAgentSession({
      ...shared, cwd: root, adapter, adapterId: "fixture",
      agentSessionId: "watch-boundary", creationId: "watch-boundary-creation",
      persistence: { transcript: { preset: "activity" } },
    });
    try {
      const runtime = (conversation as unknown as { v2Transcript: { beginOperation: (...args: unknown[]) => Promise<unknown> } }).v2Transcript;
      runtime.beginOperation = () => Promise.reject(new Error("beginOperation failed (injected)"));
      const { contract, providerCalls, outcome, metering, failedTurn } = await run("managed", conversation, conversation.transcriptPath!);
      expect({ outcome, providerCalls, metering, failed: failedTurn !== "" })
        .toEqual({ outcome: "Error: beginOperation failed (injected)", providerCalls: 0, metering: 0, failed: true });
      expect(() => contract.assertRun("managed", {})).not.toThrow(); // none or one accepted
      contract.expectOpenedNotDispatched(failedTurn, { metering: 1 });
      expect(() => contract.assertRun("managed", {})).toThrow();
      contract.expectOpenedNotDispatched(failedTurn, { metering: 0 });
      expect(() => contract.assertRun("managed", {})).not.toThrow();
    } finally {
      await conversation.stop();
    }
  }, 20_000);

  test("detached: prepareTurn failing after the open: not dispatched, metered once with a no-usage record (today's detached outcome, pinned); declared 1 passes, 0 fails", async () => {
    const { AgentSession } = await import("../../src/agent-session.ts");
    const transcriptPath = join(directory, `detached-${files++}.jsonl`);
    const conversation = await AgentSession.create({
      ...shared, adapter, adapterId: "fixture", agentSessionId: "watch-boundary-detached", transcriptPath,
    });
    try {
      const controller = conversation.connection as unknown as { prepareTurn: (...args: unknown[]) => unknown };
      controller.prepareTurn = () => { throw new Error("prepareTurn failed (injected)"); };
      const { contract, providerCalls, outcome, metering, failedTurn, records } = await run("detached", conversation, transcriptPath);
      // The one record is a no-usage record, exactly as today's code writes it.
      expect({ usage: records[0]?.usage, outcome: records[0]?.outcome, pricingStatus: records[0]?.pricingStatus, source: records[0]?.provenance?.source })
        .toEqual({ usage: { status: "usage_unavailable", reason: "Error: prepareTurn failed (injected)" }, outcome: "error", pricingStatus: "not_attributable", source: "none" });
      expect(attributedUsageProblem(records[0])).toBeNull();
      expect({ outcome, providerCalls, metering, failed: failedTurn !== "" })
        .toEqual({ outcome: "AgentSessionOperationError: prepareTurn failed (injected)", providerCalls: 0, metering: 1, failed: true });
      expect(() => contract.assertRun("detached", {})).not.toThrow(); // none or one accepted
      contract.expectOpenedNotDispatched(failedTurn, { metering: 0 });
      expect(() => contract.assertRun("detached", {})).toThrow();
      contract.expectOpenedNotDispatched(failedTurn, { metering: 1 });
      expect(() => contract.assertRun("detached", {})).not.toThrow();
    } finally {
      await conversation.stop();
    }
  }, 20_000);

  test("detached: the user line failing before the open: not metered, no declaration needed", async () => {
    const { AgentSession } = await import("../../src/agent-session.ts");
    const transcriptPath = join(directory, `detached-${files++}.jsonl`);
    const conversation = await AgentSession.create({
      ...shared, adapter, adapterId: "fixture", agentSessionId: "watch-boundary-before", transcriptPath,
    });
    try {
      const appended = (conversation as unknown as { appendTranscript: (...args: unknown[]) => Promise<void> });
      appended.appendTranscript = () => Promise.reject(new Error("user line failed (injected)"));
      const { contract, providerCalls, outcome, metering, failedTurn } = await run("detached", conversation, transcriptPath);
      expect({ outcome, providerCalls, metering, failed: failedTurn !== "" })
        .toEqual({ outcome: "Error: user line failed (injected)", providerCalls: 0, metering: 0, failed: true });
      expect(() => contract.assertRun("detached", {})).not.toThrow();
    } finally {
      await conversation.stop();
    }
  }, 20_000);
});
