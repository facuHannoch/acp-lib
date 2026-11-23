import { deepEqual, rejects } from "node:assert/strict";
import { NativeUsageLedger } from "../../../src/metering/native/ledger.ts";
import type { ModelCallSummary } from "../../../src/native-harness/src/client.ts";
import { recoverStoppedReplies } from "../../../src/native/recovery.ts";
import { controlledHarnessPeer } from "../controlled-peer.ts";

async function checkLedger(): Promise<void> {
  const call: ModelCallSummary = {
    callId: "1", channel: "alpha", turnId: "7", messageId: "model:1",
    startedAt: "2026-11-23T00:00:00Z", outcome: "running", attempts: [],
  };
  const full = new NativeUsageLedger(() => async query =>
    query.after ? { calls: [] } : { calls: [call], next: call.callId });
  deepEqual((await full.readTurn("alpha", "7")).calls, [call]);
  const empty = new NativeUsageLedger(() => async () => ({ calls: [] }));
  deepEqual((await empty.readTurn("alpha", "7")).calls, []);
  await rejects(empty.readTurn("alpha", "7", { signal: AbortSignal.abort() }), /read cancelled/);
  const failing = new NativeUsageLedger(() => async () => { throw new Error("page failed"); });
  await rejects(failing.readTurn("alpha", "7"), /page failed/);
}

async function checkRecovery(): Promise<void> {
  const page = { revision: 10, items: [], turns: [], unknownItemIds: [], unknownTurnIds: [], replies: [] };
  const { client } = controlledHarnessPeer(request => {
    if (request.method === "session/message/read") return { data: Buffer.from("Reply").toString("base64") };
    if (!("turnIds" in request.params)) throw new Error("expected turn IDs");
    switch (request.params.turnIds?.[0]) {
      case "full": return { ...page, replies: [{ messageId: "model:1", position: "1", turnId: "full" }] };
      case "unknown": return { ...page, unknownTurnIds: ["unknown"] };
      default: return page;
    }
  }, 30_000);
  try {
    deepEqual(await recoverStoppedReplies(client, "alpha", "full", []), [{ messageId: "model:1", text: "Reply" }]);
    deepEqual(await recoverStoppedReplies(client, "alpha", "empty", []), []);
    await rejects(recoverStoppedReplies(client, "alpha", "unknown", []), /could not find turn unknown/);
  } finally {
    client.close();
  }
}

if (process.argv[2] === "ledger") await checkLedger();
else if (process.argv[2] === "recovery") await checkRecovery();
else throw new Error("expected ledger or recovery");
console.log("finished");
