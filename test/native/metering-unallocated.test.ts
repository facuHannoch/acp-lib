import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { MeteringEngine } from "../../src/metering/engine.ts";
import { DurableNativeMetering, withNativeAccounting } from "../../src/metering/native/durability.ts";
import { NativeUsageLedger } from "../../src/metering/native/ledger.ts";
import { MAX_NATIVE_PROOF_BYTES, MAX_NATIVE_PROOF_IDS } from "../../src/metering/native/proof.ts";
import { NativeInferenceSource } from "../../src/metering/native/source.ts";
import type { ModelCallSummary } from "../../src/native-harness/src/client.ts";
import { nativeRig, reply, type NativeRig } from "./support.ts";

const rigs: NativeRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.clean(); });
async function usageRig() {
  const rig = await nativeRig();
  rigs.push(rig);
  return rig;
}

const retainAll = { meteringPersistence: { meteringRecords: "all" } } as const;
const prune = { meteringPersistence: { meteringRecords: "none" } } as const;
const counts = (inputTokens: number, outputTokens: number) =>
  ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });

function updateDb(path: string, sql: string) {
  const db = new Database(path);
  try { db.exec(sql); } finally { db.close(); }
}

test("earlier native usage accrues once through a failed retirement save and two reopens", async () => {
  const rig = await usageRig();
  rig.script([{ ...reply("first"), usage: counts(100, 10) }, { ...reply("second"), usage: counts(200, 20) },
    { ...reply("third"), usage: counts(30, 3) }]);
  const started = await rig.open(retainAll);
  const first = await started.conversations.create();
  const path = join(rig.directory, "agent.sqlite");
  updateDb(path, `CREATE TRIGGER refuse_stage BEFORE INSERT ON conversation_metering_state
    WHEN json_type(NEW.state_json, '$.pendingNativeMetering') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'fixture staging failure'); END;
    CREATE TRIGGER refuse_final BEFORE INSERT ON metering_records
    BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;`);

  await expect(first.prompt("first paid turn")).rejects.toThrow("fixture staging failure");
  expect(await started.persistence.metering.state(first.id)).toBeNull();
  updateDb(path, "DROP TRIGGER refuse_stage");
  await expect(first.prompt("retire the first turn")).rejects.toThrow("fixture commit failure");
  const failed = (await started.persistence.metering.state(first.id))!.state;
  expect(failed.operationCount).toBe(0);
  expect(failed.nativeCursor).toBeUndefined();
  expect(failed.unallocatedUsage.recordCount).toBe(0);
  expect(failed.pendingNativeMetering?.nextState.unallocatedUsage).toMatchObject({
    recordCount: 1, knownTokens: counts(100, 10),
  });
  expect(failed.pendingNativeMetering?.nextState.nativeCursor?.after).toBe("2");
  await started.close();
  updateDb(path, "DROP TRIGGER refuse_final");

  const reopened = await rig.open(retainAll);
  const second = (await reopened.conversations.open(first.id)).conversation;
  expect(reopened.nativeHarness?.launches).toBe(0);
  const recovered = (await reopened.persistence.metering.state(first.id))!.state;
  expect(recovered.operationCount).toBe(1);
  expect(recovered.pendingNativeMetering).toBeUndefined();
  expect(recovered.totals.total).toMatchObject({ knownTokens: 220, coverage: "partial" });
  expect(recovered.unallocatedUsage).toMatchObject({ recordCount: 1, knownTokens: counts(100, 10), ratedCosts: { unaccounted: 1 } });
  expect(recovered.totals.total.knownTokens + recovered.unallocatedUsage.knownTokens.totalTokens!).toBe(330);
  const retirement = await reopened.persistence.metering.get(first.id, "native-turn-2");
  expect(retirement?.nativeUsage?.unaccountedEarlierCalls).toEqual([{
    callId: "1", turnId: "1", attemptCount: 1, attemptIds: ["1:0"], unmeasured: 0, tokens: counts(100, 10),
  }]);
  const later = (await second.prompt("after adoption")).metering!;
  expect(later.nativeUsage?.unaccountedEarlierCalls).toBeUndefined();
  expect(later.nextState.unallocatedUsage).toEqual(recovered.unallocatedUsage);
  await reopened.close();

  const again = await rig.open(retainAll);
  await again.conversations.open(first.id);
  expect(again.nativeHarness?.launches).toBe(0);
  const final = (await again.persistence.metering.state(first.id))!.state;
  expect(final.operationCount).toBe(2);
  expect(final.pendingNativeMetering).toBeUndefined();
  expect(final.nativeCursor?.after).toBe("3");
  expect(final.totals.total).toMatchObject({ knownTokens: 253, coverage: "partial" });
  expect(final.unallocatedUsage).toEqual(recovered.unallocatedUsage);
  expect(final.totals.total.knownTokens + final.unallocatedUsage.knownTokens.totalTokens!).toBe(363);
  expect((await again.persistence.metering.list(first.id)).records.map(record => record.operationId))
    .toEqual(["native-turn-2", "native-turn-3"]);
  expect(await again.persistence.metering.get(first.id, "native-turn-2")).toEqual(retirement);
}, 20_000);

const time = "2026-11-23T00:00:00.000Z";
function observation(callId: number, channel: string, turnId: string): ModelCallSummary {
  return {
    callId: String(callId), channel, turnId, messageId: `model-${callId}`,
    outcome: "succeeded", startedAt: time, endedAt: time, attempts: [{
      attemptId: `${callId}:0`, ordinal: 0, outcome: "succeeded", startedAt: time, endedAt: time, usage: counts(2, 1),
    }],
  };
}

for (const limit of ["count", "bytes"] as const) {
  test(`bounded SQLite native proof preserves counts and prevents accrual from omitted attempt IDs (${limit})`, async () => {
    const rig = await usageRig();
    const agent = await rig.open(prune);
    const session = await agent.conversations.create();
    const earlierCount = limit === "bytes" ? MAX_NATIVE_PROOF_IDS : MAX_NATIVE_PROOF_IDS + 8;
    const ownCount = MAX_NATIVE_PROOF_IDS + 3;
    const observations = [
      ...Array.from({ length: earlierCount }, (_, index) => {
        const call = observation(index + 1, session.id, "1");
        if (limit === "count") return call;
        const id = call.callId.padStart(90, "0");
        return { ...call, callId: id, attempts: [{ ...call.attempts[0]!, attemptId: `${id}:0` }] };
      }),
      ...Array.from({ length: ownCount }, (_, index) => observation(earlierCount + index + 1, session.id, "2")),
    ];
    const ledger = new NativeUsageLedger(() => async ({ after }) => ({ calls: observations.slice(Number(after ?? 0)) }));
    const source = new NativeInferenceSource(agent.id, session.id, ledger);
    const recovery = new DurableNativeMetering(agent.persistence, session.id, agent.id, async () => {
      throw new Error("fixture writes completed records directly");
    });
    const engine = new MeteringEngine({ agentSessionId: agent.id, adapterId: "main", enforcement: "best_effort",
      pricing: false, createdActiveThread: true });
    const close = async (turnId: string, terminal: boolean) => {
      const operation = await engine.open({ operationId: `native-turn-${turnId}`, operationKind: "prompt",
        internalSessionId: agent.id, providerId: null, model: null, degraded: false,
        native: { host: { sessionId: agent.id }, channelId: session.id } });
      return engine.close(operation, { outcome: "completed", reportedCumulative: null,
        contextAfter: null, providerCostAfter: null, nativeMetering: withNativeAccounting({
          turnId, read: position => source.readTurn(turnId, position), isTerminal: () => terminal,
          terminalEarlierTurns: async ids => new Set(ids),
        }, recovery) });
    };
    const original = await close("2", false);
    expect(original.nextState.nativeCursor?.after).toBe(observations[earlierCount - 1]!.callId);
    expect(original.nextState.unallocatedUsage.knownTokens.totalTokens).toBe(earlierCount * 3);
    await agent.persistence.metering.commit({ agentConversationId: session.id, record: original, meteringRecords: "none" });

    const proof = await agent.persistence.metering.operationIdentity!(session.id, original.operationId);
    expect(proof?.nativeAccountedAttemptIds).toHaveLength(MAX_NATIVE_PROOF_IDS);
    expect(proof?.nativeAccountedAttemptCount).toBe(ownCount);
    expect(proof?.nativeAccountedAttemptsTruncated).toBe(true);
    expect(proof?.unaccountedEarlierCalls).toBeUndefined();
    expect(proof?.unaccountedEarlierSummary).toEqual({
      truncated: true, callCount: earlierCount, attemptCount: earlierCount, unmeasured: 0,
      tokens: counts(earlierCount * 2, earlierCount),
    });
    expect(await agent.persistence.metering.get(session.id, original.operationId)).toBeNull();
    const db = new Database(join(rig.directory, "agent.sqlite"), { readonly: true });
    try {
      const stored = db.query<{ bytes: number }, [string]>(`SELECT length(CAST(native_metering_proof_json AS BLOB)) AS bytes
        FROM metering_records WHERE operation_id = ?`).get(original.operationId);
      expect(stored?.bytes).toBeGreaterThan(0);
      expect(stored?.bytes).toBeLessThanOrEqual(MAX_NATIVE_PROOF_BYTES);
    } finally { db.close(); }

    observations.push(observation(observations.length + 1, session.id, "2"));
    observations.push(observation(observations.length + 1, session.id, "3"));
    const after = await close("3", true);
    expect(after.nativeUsage?.unaccountedEarlierCalls).toHaveLength(ownCount - MAX_NATIVE_PROOF_IDS + 1);
    for (const evidence of after.nativeUsage!.unaccountedEarlierCalls!) {
      expect(evidence.reason).toBe("the earlier operation's retained accounting proof was truncated");
      expect(evidence.unmeasured).toBe(1);
      expect(evidence.tokens).toBeUndefined();
    }
    expect(after.nextState.unallocatedUsage).toEqual(original.nextState.unallocatedUsage);
    expect(after.nextState.totals.total).toMatchObject({ knownTokens: (ownCount + 1) * 3, coverage: "partial" });
    expect(after.nextState.nativeCursor?.after).toBe(String(observations.length));
  });
}
