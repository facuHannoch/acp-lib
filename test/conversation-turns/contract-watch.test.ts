/**
 * The contractual watcher (`contract-watch.ts`) against synthetic conversations: each check
 * catches the failure it names, and accepts the correct timeline (A2 review, final-fixes
 * findings: failed-turn metering, last assistant message, synchronous provider throw).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A synthetic conversation: its provider `prompt` does what `respond` says. */
function setup(mode: Mode, sources: { transcriptPath?: string; committed?: Item[] } = {}) {
  let respond: () => Promise<unknown> = () => Promise.resolve({ status: "completed" });
  const listeners: Array<(notification: { event: Item & { kind: string } }) => unknown> = [];
  const ownerLifecycle = { afterPrompt: (_input: { operationId: string }) => Promise.resolve({}) };
  const conversation = {
    connection: { prompt: (..._args: unknown[]) => respond() },
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
    afterPrompt: (operationId: string) => ownerLifecycle.afterPrompt({ operationId }),
  };
}

const metering = (turnId: string) => ({ kind: "metering_recorded", record: { operationId: turnId } });
const failedWith = (turnId: string, error: string) => ({ kind: "turn_failed", turnId, error });
const completedWith = (turnId: string, texts: readonly string[]) =>
  ({ kind: "turn_completed", turnId, result: { status: "completed", messages: texts.map((text) => ({ text })) } });
const RECORD_ERROR = "AgentSessionOperationError: provider failed";

/** A dispatched turn whose provider rejects; metering, when given, after the rejection settles. */
async function dispatchedRejection(mode: Mode, steps: { metering?: number; meteringFirst?: boolean; error?: string } = {}) {
  const w = setup(mode);
  let reject!: (error: unknown) => void;
  w.respondWith(() => new Promise((_, no) => { reject = no; }));
  w.emit({ kind: "turn_started", turnId: "t1" });
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
    w.emit({ kind: "turn_started", turnId: "t1" });
    await w.provider.prompt().catch(() => undefined);
    w.emit(failedWith("t1", RECORD_ERROR));
    w.emit(metering("t1"));
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a dispatched failed turn whose error does not carry the record fails", async () => {
    const w = await dispatchedRejection("detached", { metering: 1, error: "Error: provider failed" });
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a metering preflight rejection (never dispatched) needs no metering, and may have none", () => {
    const w = setup("detached");
    w.emit({ kind: "turn_started", turnId: "t1" });
    w.emit(failedWith("t1", "MeteringPreflightError: pricing unavailable: no price"));
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
    w.emit(metering("t1"));
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });

  test("a failure before the metered operation opened (never dispatched) may have no metering", () => {
    const w = setup("agent-owned");
    w.emit({ kind: "turn_started", turnId: "t1" });
    w.emit(failedWith("t1", "ProviderSessionError: The provider session could not be loaded"));
    expect(() => w.contract.assertRun("agent-owned", { records: { records: [], committedBus: [] } })).not.toThrow();
    w.emit(metering("t1"));
    expect(() => w.contract.assertRun("agent-owned", { records: { records: [], committedBus: [] } })).toThrow();
  });

  test("an operation closed before the provider call (error carries the record) needs its metering", () => {
    const missing = setup("detached");
    missing.emit({ kind: "turn_started", turnId: "t1" });
    missing.emit(failedWith("t1", RECORD_ERROR));
    expect(() => missing.contract.assertRun("detached", {})).toThrow();
    const metered = setup("detached");
    metered.emit({ kind: "turn_started", turnId: "t1" });
    metered.emit(metering("t1"));
    metered.emit(failedWith("t1", RECORD_ERROR));
    expect(() => metered.contract.assertRun("detached", {})).not.toThrow();
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

  /** A completed turn: provider result, metering, (Agent-owned) afterPrompt, then completion. */
  async function complete(w: ReturnType<typeof setup>, mode: Mode, texts: readonly string[] = TEXTS, turnId = "t1") {
    w.emit({ kind: "turn_started", turnId });
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
    w.emit({ kind: "turn_started", turnId: "t1" });
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

  const detachedLine = (texts: readonly string[]) => ({ t: "msg", role: "assistant", messages: texts.map((text) => ({ text })) });

  test("detached: the last assistant line holding the turn's messages passes", async () => {
    const w = setup("detached", { transcriptPath: transcriptFile([{ t: "msg", role: "user" }, detachedLine(TEXTS)]) });
    await complete(w, "detached");
    expect(w.contract.violations).toEqual([]);
  });

  test("detached: a last line holding only the earlier message fails", async () => {
    const w = setup("detached", { transcriptPath: transcriptFile([{ t: "msg", role: "user" }, detachedLine([TEXTS[0]!])]) });
    await complete(w, "detached");
    expect(w.contract.violations).toEqual(["turn t1 completed, but the last assistant line does not hold its messages (last message missing or other)"]);
  });

  test("detached: an earlier turn's line as the last one fails", async () => {
    const w = setup("detached", { transcriptPath: transcriptFile([detachedLine(["earlier turn"])]) });
    await complete(w, "detached");
    expect(w.contract.violations).toHaveLength(1);
  });
});

describe("the provider outcome: resolved, rejected, forced, or a synchronous throw", () => {
  const ending = (w: ReturnType<typeof setup>, turnId: string) => {
    w.emit(metering(turnId));
    w.emit(failedWith(turnId, RECORD_ERROR));
  };

  test("a synchronous throw is the outcome, and the same error is rethrown", () => {
    const w = setup("detached");
    const thrown = new Error("not connected");
    w.respondWith(() => { throw thrown; });
    w.emit({ kind: "turn_started", turnId: "t1" });
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
    w.emit({ kind: "turn_started", turnId: "t1" });
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
    w.emit({ kind: "turn_started", turnId: "t1" });
    await expect(w.provider.prompt()).rejects.toBe(forced);
    w.emit(metering("t1"));
    w.emit(failedWith("t1", `AgentSessionOperationError: ${forced.message}`));
    expect(() => w.contract.assertRun("detached", {})).not.toThrow();
  });

  test("a resolved result is the outcome, and the same promise is returned", async () => {
    const w = setup("detached");
    const result = Promise.resolve({ status: "completed" });
    w.respondWith(() => result);
    w.emit({ kind: "turn_started", turnId: "t1" });
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
    w.emit({ kind: "turn_started", turnId: "t1" });
    const call = w.provider.prompt();
    w.emit(metering("t1"));
    resolve({ status: "completed" });
    await call;
    w.emit({ kind: "turn_completed", turnId: "t1", result: { status: "completed", messages: [] } });
    expect(() => w.contract.assertRun("detached", {})).toThrow();
  });
});
