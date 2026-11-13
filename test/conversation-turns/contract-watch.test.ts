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
import { type Mode, watchContract } from "./contract-watch.ts";

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

const metering = (turnId: string) => ({ kind: "metering_recorded", record: { operationId: turnId } });
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

  test("opened but not dispatched is undecided: it fails unless declared, whatever its error says (the reviewer's probe)", async () => {
    for (const error of ["Error: beginOperation failed", "ProviderSessionError: x", RECORD_ERROR]) {
      for (const metered of [false, true]) {
        const w = await openedNotDispatched({ metering: metered, error });
        expect(() => w.contract.assertRun("detached", {})).toThrow("open question 5");
      }
    }
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
    conversation.subscribe(({ event }) => {
      kinds.push(event.kind);
      if (event.kind === "turn_failed") failedTurn = event.turnId;
    });
    let providerCalls = 0;
    const prompt = conversation.connection.prompt.bind(conversation.connection);
    conversation.connection.prompt = ((...args: Parameters<typeof prompt>) => { providerCalls += 1; return prompt(...args); }) as typeof prompt;
    let outcome = "resolved";
    try { await conversation.prompt("hello"); } catch (error) { outcome = String(error); }
    const metering = kinds.filter((kind) => kind === "metering_recorded").length;
    return { contract, providerCalls, outcome, metering, failedTurn };
  };

  test("managed: beginOperation failing after the open: not dispatched, not metered; undeclared fails, declared 0 passes", async () => {
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
      expect(() => contract.assertRun("managed", {})).toThrow("open question 5");
      contract.expectOpenedNotDispatched(failedTurn, { metering: 1 });
      expect(() => contract.assertRun("managed", {})).toThrow();
      contract.expectOpenedNotDispatched(failedTurn, { metering: 0 });
      expect(() => contract.assertRun("managed", {})).not.toThrow();
    } finally {
      await conversation.stop();
    }
  }, 20_000);

  test("detached: prepareTurn failing after the open: not dispatched, metered once; undeclared fails, declared 1 passes", async () => {
    const { AgentSession } = await import("../../src/agent-session.ts");
    const transcriptPath = join(directory, `detached-${files++}.jsonl`);
    const conversation = await AgentSession.create({
      ...shared, adapter, adapterId: "fixture", agentSessionId: "watch-boundary-detached", transcriptPath,
    });
    try {
      const controller = conversation.connection as unknown as { prepareTurn: (...args: unknown[]) => unknown };
      controller.prepareTurn = () => { throw new Error("prepareTurn failed (injected)"); };
      const { contract, providerCalls, outcome, metering, failedTurn } = await run("detached", conversation, transcriptPath);
      expect({ outcome, providerCalls, metering, failed: failedTurn !== "" })
        .toEqual({ outcome: "AgentSessionOperationError: prepareTurn failed (injected)", providerCalls: 0, metering: 1, failed: true });
      expect(() => contract.assertRun("detached", {})).toThrow("open question 5");
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
