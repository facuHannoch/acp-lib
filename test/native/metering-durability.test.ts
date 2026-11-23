import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { terminalNativeTurns } from "../../src/native/metering.ts";
import { NativeUsageLedger } from "../../src/metering/native/ledger.ts";
import { NativeInferenceSource } from "../../src/metering/native/source.ts";
import { emptyMeteringState } from "../../src/metering/state.ts";
import { MeteringEngine } from "../../src/metering/engine.ts";
import { DurableNativeMetering, recoverNativeClose } from "../../src/metering/native/durability.ts";
import { MeteringPreflightError } from "../../src/metering/record.ts";
import type { HarnessClient, ModelCallSummary } from "../../src/native-harness/src/client.ts";
import { managedSessionPaths } from "../../src/native-harness/src/runtime/config/paths.ts";
import { spawnHarness } from "../../src/native-harness/test/helpers/stdio.ts";
import { nativeRig, reply, type NativeRig } from "./support.ts";

const rigs: NativeRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.clean(); });
async function usageRig() {
  const rig = await nativeRig();
  rigs.push(rig);
  return rig;
}
const counts = (inputTokens: number, outputTokens: number) =>
  ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
const echo = (index: number) => ({
  content: null,
  calls: [{ id: `echo-${index}`, name: "echo", arguments: { text: "hello" } }],
  usage: counts(3, 1),
});
const retainAll = { meteringPersistence: { meteringRecords: "all" } } as const;
const prune = { meteringPersistence: { meteringRecords: "none" } } as const;

function traceCursors(rig: NativeRig, intercept?: (client: HarnessClient) => void) {
  const cursors: Array<string | undefined> = [];
  rig.harness.connect = async () => {
    const child = spawnHarness({ home: rig.home });
    intercept?.(child.client);
    const read = child.client.modelCalls.bind(child.client);
    child.client.modelCalls = (query, signal) => {
      cursors.push(query?.after);
      return read(query, signal);
    };
    return { client: child.client, closed: child.child.exited.then(() => undefined), kill: () => child.close() };
  };
  return cursors;
}

test("native close after restart starts at the committed cursor after hundreds of pruned calls", async () => {
  const rig = await usageRig();
  const cursors = traceCursors(rig);
  rig.script([
    { ...reply("baseline"), usage: { inputTokens: 9 } },
    { ...reply("historical end"), usage: counts(9, 1) },
    { ...reply("new tail"), usage: counts(14, 6) },
  ]);
  const started = await rig.open(prune);
  const original = await started.conversations.create();
  await original.prompt("baseline");
  const [seed] = (await started.nativeHarness!.modelCalls()).calls;
  if (!seed) throw new Error("No baseline model call");
  await started.close();

  // Seed a long interleaved history in the stopped harness's fixture database.
  // The real stdio server still implements pagination, ownership and cursor lookup.
  const db = new Database(managedSessionPaths(started.id, rig.home).database);
  try {
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'modelState'").get();
    const historical = JSON.parse(row!.value) as { calls: ModelCallSummary[]; nextCall: number };
    for (let id = 2; id <= 321; id++) {
      historical.calls.push({ ...seed, callId: String(id), channel: "foreign-fixture", turnId: String(id),
        messageId: `fixture-${id}`, attempts: seed.attempts.map(attempt => ({ ...attempt, attemptId: `${id}:0` })) });
    }
    historical.nextCall = 322;
    db.query("UPDATE meta SET value = ? WHERE key = 'modelState'").run(JSON.stringify(historical));
  } finally { db.close(); }

  const withHistory = await rig.open(prune);
  const historical = (await withHistory.conversations.open(original.id)).conversation;
  cursors.length = 0;
  const retired = await historical.prompt("observe long history");
  expect(retired.text).toBe("historical end");
  expect(retired.metering?.nativeUsage?.unaccountedEarlierCalls).toMatchObject([{ callId: "1", unmeasured: 1 }]);
  expect(cursors).toEqual([undefined, "100", "200", "300"]);
  const initial = await withHistory.persistence.metering.state(original.id);
  expect(initial?.state.nativeCursor).toEqual({ channelKey: `${started.id}/${original.id}`, after: "322" });
  expect(initial?.state.totals.total.knownTokens).toBe(10);
  expect((await withHistory.persistence.metering.list(original.id)).records).toEqual([]);
  await withHistory.close();

  const reopened = await rig.open(prune);
  const conversation = (await reopened.conversations.open(original.id)).conversation;
  cursors.length = 0;
  const tail = await conversation.prompt("new");
  expect(tail.text).toBe("new tail");
  expect(tail.metering?.usage).toMatchObject({ status: "metered", reportedCumulative: counts(14, 6) });
  expect(cursors).toEqual(["322"]);
  const stored = await reopened.persistence.metering.state(original.id);
  expect(stored?.state.operationCount).toBe(3);
  expect(stored?.state.totals.total.knownTokens).toBe(30);
  expect(stored?.state.nativeCursor?.after).toBe("323");
}, 30_000);

test("native metering replays a failed SQLite save once after restart with detail pruned", async () => {
  const rig = await usageRig();
  const cursors = traceCursors(rig);
  rig.script([{ ...reply("original"), usage: counts(100, 10) }, { ...reply("later"), usage: counts(200, 20) }]);
  const started = await rig.open(prune);
  const original = await started.conversations.create();
  const path = join(rig.directory, "agent.sqlite");
  const write = (sql: string) => { const db = new Database(path); try { db.exec(sql); } finally { db.close(); } };
  write(`CREATE TRIGGER fail_native_metering_commit BEFORE INSERT ON metering_records
    WHEN NEW.operation_id LIKE 'native-turn-%'
    BEGIN SELECT RAISE(ABORT, 'fixture failed native metering commit'); END`);
  await expect(original.prompt("one paid turn")).rejects.toThrow("fixture failed native metering commit");
  const atFailure = await started.persistence.metering.state(original.id);
  expect(atFailure?.state.operationCount).toBe(0);
  expect(atFailure?.state.nativeCursor).toBeUndefined();
  expect(atFailure?.state.pendingNativeMetering).toMatchObject({ operationId: "native-turn-1",
    usage: { status: "metered", reportedCumulative: counts(100, 10) } });
  expect(await started.persistence.metering.operationIdentity!(original.id, "native-turn-1")).toBeNull();
  await started.close();
  write("DROP TRIGGER fail_native_metering_commit");

  const reopened = await rig.open(prune), host = reopened.nativeHarness!;
  const conversation = (await reopened.conversations.open(original.id)).conversation;
  expect(host.launches).toBe(0);
  const replayed = await reopened.persistence.metering.state(original.id);
  expect(replayed?.state.pendingNativeMetering).toBeUndefined();
  expect(replayed?.state.operationCount).toBe(1);
  expect(replayed?.state.totals.total.knownTokens).toBe(110);
  expect(replayed?.state.nativeCursor?.after).toBe("1");
  expect(await reopened.persistence.metering.get(original.id, "native-turn-1")).toBeNull();
  expect(await reopened.persistence.metering.operationIdentity!(original.id, "native-turn-1")).toMatchObject({ outcome: "completed" });

  let extraCommits = 0;
  const recovery = new DurableNativeMetering(reopened.persistence, original.id, reopened.id, async () => { extraCommits++; });
  const engine = new MeteringEngine({ agentSessionId: reopened.id, adapterId: "main",
    enforcement: "best_effort", pricing: false, initialState: replayed?.state, createdActiveThread: true });
  const duplicate = await engine.open({ operationId: "native-turn-1", operationKind: "prompt", internalSessionId: reopened.id,
    providerId: null, model: null, degraded: false, native: { host, channelId: original.id } });
  const found = await recoverNativeClose(recovery, engine, duplicate);
  expect(found?.usage).toMatchObject({ status: "usage_unavailable", reason: expect.stringContaining("already committed") });
  expect(engine.currentState.operationCount).toBe(1);
  await recovery.record(found!);
  expect(extraCommits).toBe(0);

  cursors.length = 0;
  expect((await conversation.prompt("second paid turn")).text).toBe("later");
  expect(cursors).toEqual(["1"]);
  const final = await reopened.persistence.metering.state(original.id);
  expect(final?.state.operationCount).toBe(2);
  expect(final?.state.totals.total.knownTokens).toBe(330);
  expect(final?.state.pendingNativeMetering).toBeUndefined();
}, 20_000);

test("native usage explains a partial total and leaves the cursor before the gap", async () => {
  const rig = await usageRig();
  const cursors = traceCursors(rig);
  rig.script([
    { ...reply("baseline"), usage: counts(5, 1) },
    echo(0),
    { ...reply("partial"), usage: { inputTokens: 10 } },
    { ...reply("complete later"), usage: counts(8, 2) },
  ]);
  const agent = await rig.open(retainAll);
  const conversation = await agent.conversations.create();
  await conversation.prompt("baseline");
  const partial = (await conversation.prompt("a partial turn")).metering!;
  expect(partial.usage).toMatchObject({ status: "metered", reason: "some native model-call attempts could not be measured",
    reportedCumulative: counts(3, 1) });
  expect(partial.nativeUsage).toMatchObject({ status: "observed", unmeasured: 1 });
  expect(partial.nextState.nativeCursor?.after).toBe("1");
  expect(partial.nextState.totals.total.coverage).toBe("partial");
  cursors.length = 0;
  const later = (await conversation.prompt("another turn")).metering!;
  expect(later.usage).toMatchObject({ status: "metered", reportedCumulative: counts(8, 2) });
  expect(cursors).toEqual(["1"]);
  expect(later.nextState.nativeCursor?.after).toBe("4");
  expect(later.nativeUsage?.unaccountedEarlierCalls).toMatchObject([{ callId: "3", attemptIds: ["3:0"], unmeasured: 1 }]);
  expect(later.nextState.totals.total.knownTokens).toBe(20);
}, 20_000);

test("native billing refusal names the sealed accounting capability before admission", async () => {
  const rig = await usageRig();
  const agent = await rig.open();
  const strict = { runtime: { metering: { enforcement: "billing_required" as const } } };
  const refused = agent.conversations.create(strict).catch(error => error);
  const error = await refused;
  expect(error).toBeInstanceOf(MeteringPreflightError);
  expect(error.message).toContain("native-harness@1 sealed per-turn accounting capability");
  expect((await agent.conversations.list()).conversations).toEqual([]);
  const existing = await agent.conversations.create();
  await existing.stop();
  await expect(agent.conversations.open(existing.id, strict)).rejects.toThrow("native-harness@1");
  expect(agent.nativeHarness?.launches).toBe(0);
}, 15_000);


for (const reopen of [false, true]) {
  test(`a double SQLite write failure leaves earlier usage visible ${reopen ? "after reopen" : "in process"}`, async () => {
    const rig = await usageRig();
    const cursors = traceCursors(rig);
    rig.script([{ ...reply("first"), usage: counts(100, 10) }, { ...reply("second"), usage: counts(200, 20) },
      { ...reply("third"), usage: counts(30, 3) }]);
    const started = await rig.open(retainAll);
    const first = await started.conversations.create();
    const db = new Database(join(rig.directory, "agent.sqlite"));
    try {
      db.exec(`CREATE TRIGGER refuse_stage BEFORE INSERT ON conversation_metering_state
        WHEN json_type(NEW.state_json, '$.pendingNativeMetering') IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'cannot stage'); END;
        CREATE TRIGGER refuse_final BEFORE INSERT ON metering_records
        BEGIN SELECT RAISE(ABORT, 'cannot commit'); END;`);
      await expect(first.prompt("first paid operation")).rejects.toThrow("cannot stage");
      expect(await started.persistence.metering.state(first.id)).toBeNull();
      expect(await started.persistence.metering.operationIdentity!(first.id, "native-turn-1")).toBeNull();
      if (reopen) await started.close();
      db.exec("DROP TRIGGER refuse_stage; DROP TRIGGER refuse_final;");
    } finally { db.close(); }

    const agent = reopen ? await rig.open(retainAll) : started;
    const session = reopen ? (await agent.conversations.open(first.id)).conversation : first;
    const second = (await session.prompt("next operation")).metering!;
    const stored = await agent.persistence.metering.get(first.id, second.operationId);
    expect(stored?.nativeUsage?.unaccountedEarlierCalls).toEqual([{
      turnId: "1", callId: "1", attemptIds: ["1:0"], attemptCount: 1, unmeasured: 0, tokens: counts(100, 10),
    }]);
    expect(stored?.usage).toMatchObject({ status: "metered", reportedCumulative: counts(200, 20) });
    expect(stored?.nextState.operationCount).toBe(1);
    expect(stored?.nextState.totals.total).toMatchObject({ knownTokens: 220, coverage: "partial" });
    expect(stored?.nextState.nativeCursor?.after).toBe("2");
    cursors.length = 0;
    const third = (await session.prompt("later operation")).metering!;
    expect(cursors).toEqual(["2"]);
    expect(third.nativeUsage?.unaccountedEarlierCalls).toBeUndefined();
    expect(third.nextState.totals.total.knownTokens).toBe(253);
  }, 20_000);
}

test("a late-sealed attempt is recorded once while pruned accounting proof excludes the already measured attempt", async () => {
  const rig = await usageRig();
  let hideSeal = true;
  const cursors = traceCursors(rig, client => {
    const read = client.modelCalls.bind(client);
    client.modelCalls = async (...args) => {
      const page = await read(...args);
      if (!hideSeal) return page;
      return { ...page, calls: page.calls.map(call => call.callId === "2"
        ? { ...call, outcome: "running", endedAt: undefined }
        : call) };
    };
  });
  rig.script([echo(0), { ...reply("first"), usage: counts(28, 2) },
    { ...reply("second"), usage: counts(7, 3) }, { ...reply("later"), usage: counts(2, 1) }]);
  const started = await rig.open(prune);
  const first = await started.conversations.create();
  const partial = (await first.prompt("first operation")).metering!;
  expect(partial.nativeUsage).toMatchObject({ unmeasured: 1, accountedAttemptIds: ["1:0"] });
  expect(partial.nextState.nativeCursor).toBeUndefined();
  expect(await started.persistence.metering.get(first.id, partial.operationId)).toBeNull();
  expect(await started.persistence.metering.operationIdentity!(first.id, partial.operationId))
    .toMatchObject({ nativeAccountedAttemptIds: ["1:0"] });
  await started.close();
  hideSeal = false;

  const reopened = await rig.open(prune);
  const session = (await reopened.conversations.open(first.id)).conversation;
  const second = (await session.prompt("second operation")).metering!;
  expect(second.nativeUsage?.unaccountedEarlierCalls).toEqual([{
    turnId: "1", callId: "2", attemptIds: ["2:0"], attemptCount: 1, unmeasured: 0, tokens: counts(28, 2),
  }]);
  expect(await reopened.persistence.metering.get(first.id, second.operationId)).toBeNull();
  expect(await reopened.persistence.metering.operationIdentity!(first.id, second.operationId))
    .toMatchObject({ unaccountedEarlierCalls: second.nativeUsage!.unaccountedEarlierCalls });
  expect(second.nextState.totals.total.knownTokens).toBe(14);
  expect(second.nextState.nativeCursor?.after).toBe("3");
  cursors.length = 0;
  const third = (await session.prompt("later operation")).metering!;
  expect(cursors).toEqual(["3"]);
  expect(third.nativeUsage?.unaccountedEarlierCalls).toBeUndefined();
}, 20_000);

test("an earlier running row is retired as unmeasured only after its turn is confirmed terminal", async () => {
  const rig = await usageRig();
  let terminal = false;
  const cursors = traceCursors(rig, client => {
    const read = client.modelCalls.bind(client);
    const reconcile = client.reconcileChannel.bind(client);
    client.modelCalls = async (...args) => {
      const page = await read(...args);
      return { ...page, calls: page.calls.map(call => call.callId === "1"
        ? { ...call, outcome: "running", endedAt: undefined }
        : call) };
    };
    client.reconcileChannel = async params => {
      const result = await reconcile(params);
      if (terminal || !params.turnIds?.includes("1")) return result;
      return { ...result, turns: result.turns.map(turn => turn.turnId === "1" ? { ...turn, state: "running" } : turn) };
    };
  });
  rig.script(Array.from({ length: 4 }, (_, index) => ({ ...reply(`reply ${index}`), usage: counts(8, 2) })));
  const agent = await rig.open(retainAll);
  const session = await agent.conversations.create();
  const first = (await session.prompt("unsealed")).metering!;
  expect(first.usage.status).toBe("usage_unavailable");
  const pending = (await session.prompt("cannot retire yet")).metering!;
  expect(pending.nativeUsage?.unaccountedEarlierCalls).toBeUndefined();
  expect(pending.nativeUsage?.earlierEvidencePending).toBe(true);
  expect(pending.nextState.nativeCursor).toBeUndefined();

  terminal = true;
  const retired = (await session.prompt("terminal is confirmed")).metering!;
  expect(retired.nativeUsage?.unaccountedEarlierCalls).toEqual([{
    turnId: "1", callId: "1", attemptIds: ["1:0"], attemptCount: 1, unmeasured: 1,
    reason: "the earlier turn ended with an unsealed model call",
  }]);
  expect(retired.nextState.nativeCursor?.after).toBe("3");
  cursors.length = 0;
  expect((await session.prompt("after retirement")).metering?.nativeUsage?.unaccountedEarlierCalls).toBeUndefined();
  expect(cursors).toEqual(["3"]);
  const retiredChannel = terminalNativeTurns({
    channel: () => ({ channel: session.id, lifecycle: "retired", pending: [], waitingForResume: false }),
    async reconcileChannel() { throw new Error("a retired channel needs no turn read"); },
  }, session.id);
  expect(await retiredChannel(["1", "2"])).toEqual(new Set(["1", "2"]));
}, 20_000);

test("native cursor requires channel ownership and a confirmed terminal turn", async () => {
  const began = "2026-11-23T00:00:00.000Z";
  const queries: (string | undefined)[] = [];
  const ledger = new NativeUsageLedger(() => async ({ after }) => {
    queries.push(after);
    return { calls: [{
      callId: "1", channel: "here", turnId: "1", messageId: "message", outcome: "succeeded",
      startedAt: began, endedAt: began, attempts: [{
        ordinal: 0, attemptId: "1:0", outcome: "succeeded", startedAt: began, endedAt: began, usage: counts(8, 2),
      }],
    }] };
  });
  const source = new NativeInferenceSource("agent", "here", ledger);
  const foreign = { channelKey: "agent/elsewhere", after: "400" };
  const engine = new MeteringEngine({ agentSessionId: "agent", adapterId: "main", enforcement: "best_effort",
    pricing: false, createdActiveThread: true, initialState: { ...emptyMeteringState("agent"), nativeCursor: foreign } });
  const open = await engine.open({ operationId: "native-turn-1", operationKind: "prompt", internalSessionId: "agent",
    providerId: null, model: null, degraded: false, native: { host: { sessionId: "agent" }, channelId: "here" } });
  const args = { outcome: "completed", reportedCumulative: null, contextAfter: null, providerCostAfter: null } as const;
  const read = (position?: Parameters<typeof source.readTurn>[1]) => source.readTurn("1", position);
  const unconfirmed = await engine.close(open, { ...args, nativeMetering: { turnId: "1", read, isTerminal: () => false } });
  expect(queries).toEqual([undefined]);
  expect(unconfirmed.usage).toMatchObject({ status: "metered", reason: "the native turn's terminal outcome was not confirmed" });
  expect(unconfirmed.nextState.nativeCursor).toEqual(foreign);
  const confirmed = await engine.close(open, { ...args, nativeMetering: { turnId: "1", read, isTerminal: () => true } });
  expect(confirmed.nextState.nativeCursor).toEqual({ channelKey: "agent/here", after: "1" });
});

test("SQLite v20 upgrades native metering proof without inventing proof for old rows", async () => {
  const rig = await usageRig();
  const started = await rig.open(prune);
  const first = await started.conversations.create();
  rig.script([{ ...reply("legacy"), usage: counts(10, 1) }, { ...reply("new"), usage: counts(20, 2) }]);
  await first.prompt("legacy operation");
  await started.close();
  const db = new Database(join(rig.directory, "agent.sqlite"));
  try {
    db.exec(`ALTER TABLE metering_records DROP COLUMN native_metering_proof_json;
      DELETE FROM schema_migrations WHERE version > 20;
      UPDATE conversation_metering_state SET state_json = json_remove(state_json, '$.nativeCursor');
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (20, '2026-11-23T00:00:00.000Z');`);
  } finally { db.close(); }

  const reopened = await rig.open(prune);
  const legacy = await reopened.persistence.metering.operationIdentity!(first.id, "native-turn-1");
  expect(legacy?.nativeAccountedAttemptIds).toBeUndefined();
  const session = (await reopened.conversations.open(first.id)).conversation;
  const modern = (await session.prompt("modern operation")).metering!;
  const proof = await reopened.persistence.metering.operationIdentity!(first.id, modern.operationId);
  expect(proof?.nativeAccountedAttemptIds).toEqual(["2:0"]);
  expect(proof?.unaccountedEarlierCalls).toEqual([{
    callId: "1", turnId: "1", attemptIds: ["1:0"], attemptCount: 1, unmeasured: 1,
    reason: "the earlier operation's retained accounting proof is unavailable",
  }]);
  expect(modern.nextState.nativeCursor?.after).toBe("2");
  expect(modern.nextState.totals.total.knownTokens).toBe(33);
}, 20_000);
