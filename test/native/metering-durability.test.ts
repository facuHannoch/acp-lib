import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { MeteringEngine } from "../../src/metering/engine.ts";
import { DurableNativeMetering, recoverNativeClose } from "../../src/metering/native/durability.ts";
import { MeteringPreflightError } from "../../src/metering/record.ts";
import type { ModelCallSummary } from "../../src/native-harness/src/client.ts";
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

function traceCursors(rig: NativeRig) {
  const cursors: Array<string | undefined> = [];
  rig.harness.connect = async () => {
    const child = spawnHarness({ home: rig.home });
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
    { ...reply("baseline"), usage: counts(9, 1) },
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
  expect((await historical.prompt("observe long history")).text).toBe("historical end");
  expect(cursors).toEqual(["1", "101", "201", "301"]);
  const initial = await withHistory.persistence.metering.state(original.id);
  expect(initial?.state.nativeCursor).toEqual({ channelKey: `${started.id}/${original.id}`, after: "322" });
  expect(initial?.state.totals.total.knownTokens).toBe(20);
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
  expect(stored?.state.totals.total.knownTokens).toBe(40);
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
  expect(later.nextState.nativeCursor?.after).toBe("1");
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
