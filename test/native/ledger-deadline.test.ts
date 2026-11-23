import { expect, test } from "bun:test";
import { NativeUsageLedger } from "../../src/metering/native/ledger.ts";
import type { ModelCallSummary } from "../../src/native-harness/src/client.ts";
import { controlledHarnessPeer } from "./controlled-peer.ts";

test("native usage ledger budget survives a successful first page and a silent second page", async () => {
  const call: ModelCallSummary = {
    callId: "1", channel: "alpha", turnId: "7", messageId: "model:1",
    startedAt: "2026-11-23T00:00:00Z", outcome: "running", attempts: [],
  };
  let pages = 0;
  const { client, requests } = controlledHarnessPeer(() =>
    ++pages === 1 ? { calls: [call], next: call.callId } : undefined, 30_000);
  const budget = 250;
  const ledger = new NativeUsageLedger(() => (query, signal) => client.modelCalls(query, signal), {
    timeoutMs: budget, maxPages: 2,
  });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = performance.now();
    const read = ledger.readTurn("alpha", "7");
    const failed = await Promise.race([
      read.catch(error => error),
      new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("the two-page read outlived the ledger budget")), 3_500);
      }),
    ]);
    expect(failed).toMatchObject({ message: "Native usage ledger read timed out" });
    expect(performance.now() - started).toBeGreaterThan(budget - 30);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "session/model-calls", params: {} },
      { method: "session/model-calls", params: { after: "1" } },
    ]);
  } finally {
    clearTimeout(guard);
    client.close();
  }
});
