import { expect, test } from "bun:test";
import { NativeUsageLedger } from "../src/metering/native/ledger.ts";
import { NativeInferenceSource } from "../src/metering/native/source.ts";
import type { ModelAttemptSummary, ModelCallSummary, ModelUsage } from "../src/native-harness/src/client.ts";

const startedAt = "2026-11-23T00:00:00.000Z";
const endedAt = "2026-11-23T00:00:01.000Z";
const firstUsage = { inputTokens: 11, outputTokens: 2, totalTokens: 13 };
const secondUsage = { inputTokens: 13, outputTokens: 5, totalTokens: 18 };

function attempt(callId: string, ordinal: number, usage?: ModelUsage,
  outcome: ModelAttemptSummary["outcome"] = "succeeded"): ModelAttemptSummary {
  return { attemptId: `${callId}:${ordinal}`, ordinal, startedAt, outcome, usage,
    ...(outcome === "running" ? {} : { endedAt }) };
}

function call(callId: string, channel: string, turnId: string,
  attempts = [attempt(callId, 0, firstUsage)], outcome: ModelCallSummary["outcome"] = "succeeded"): ModelCallSummary {
  return { callId, channel, turnId, messageId: `model:${callId}`, startedAt, outcome, attempts,
    ...(outcome === "running" ? {} : { endedAt }) };
}

test("native usage pages isolate a channel and turn and keep a retry's own usage and IDs", async () => {
  const requested: Array<string | undefined> = [];
  const ledger = new NativeUsageLedger(async ({ after }) => {
    requested.push(after);
    if (after === undefined) return { calls: [
      call("1", "beta", "t1"), call("2", "alpha", "t0"),
      call("3", "alpha", "t1", [attempt("3", 0, firstUsage, "transient_failure"), attempt("3", 1, secondUsage)]),
    ], next: "3" };
    return { calls: [call("4", "alpha", "t1"), call("5", "beta", "t2")] };
  });
  const alpha = new NativeInferenceSource("agent", "alpha", ledger);
  expect(alpha.isHealthy()).toBe(false);
  const snapshot = await alpha.pullTurn("t1");
  expect(alpha.sessionKey).toBe("agent/alpha");
  expect(alpha.isHealthy()).toBe(true);
  expect(snapshot.lastSeenCallId).toBe("5");
  expect(snapshot.calls.map(entry => entry.callId)).toEqual(["3", "4"]);
  expect(snapshot.calls[0]?.attempts.map(entry => entry.outcome)).toEqual(["transient_failure", "succeeded"]);
  expect(requested).toEqual([undefined, "3"]);
  expect(alpha.drain("agent/beta")).toEqual([]);
  expect(alpha.drain(null)).toEqual([]);
  expect(alpha.drain(alpha.sessionKey).map(entry => [
    entry.callId, entry.attemptId, entry.messageID, entry.tokens, entry.providerID, entry.modelID, entry.sequence, entry.cost,
  ])).toEqual([
    ["3", "3:0", "model:3", firstUsage, "", "", null, null],
    ["3", "3:1", "model:3", secondUsage, "", "", null, null],
    ["4", "4:0", "model:4", firstUsage, "", "", null, null],
  ]);
  expect(alpha.drain(alpha.sessionKey)).toEqual([]);

  const beta = new NativeInferenceSource("agent", "beta", ledger);
  expect((await beta.pullTurn("t1")).calls.map(entry => entry.callId)).toEqual(["1"]);
  expect(alpha.drain(alpha.sessionKey)).toEqual([]);
});

test("native usage keeps running and missing evidence separate from the sealed projection", async () => {
  let reopened = false;
  const ledger = new NativeUsageLedger(async () => ({ calls: reopened ? [
    call("2", "alpha", "t1", [attempt("2", 0, firstUsage, "interrupted")], "interrupted"),
    call("3", "alpha", "t1", [attempt("3", 0, { inputTokens: 0 }, "timeout")], "timeout"),
    call("4", "alpha", "t1", [attempt("4", 0, undefined, "provider_failure")], "failed"),
  ] : [call("2", "alpha", "t1", [attempt("2", 0, firstUsage, "running")], "running")] }));
  const source = new NativeInferenceSource("agent", "alpha", ledger);
  const first = await source.pullTurn("t1", { after: "1" });
  expect(first.calls[0]?.outcome).toBe("running");
  expect(first.calls[0]?.attempts[0]?.usage).toEqual(firstUsage);
  expect(source.outstandingReports(source.sessionKey)).toBe(1);
  expect(source.drain(source.sessionKey)).toEqual([]);

  reopened = true;
  const replay = await source.pullTurn("t1", { after: "1" });
  expect(replay.calls[0]?.attempts[0]?.outcome).toBe("interrupted");
  expect(replay.calls[1]?.attempts[0]?.usage).toEqual({ inputTokens: 0 });
  expect(replay.calls[2]?.attempts[0]).not.toHaveProperty("usage");
  expect(source.outstandingReports(source.sessionKey)).toBe(2);
  expect(source.drain(source.sessionKey).map(entry => entry.tokens)).toEqual([firstUsage]);
});

test("native usage reads from an accounted cursor without scanning historical pages", async () => {
  const history = Array.from({ length: 403 }, (_, index) => {
    const id = index + 1;
    return call(String(id), "alpha", id > 400 ? "last" : "historical");
  });
  const queries: Array<string | undefined> = [];
  const ledger = new NativeUsageLedger(async ({ after }) => {
    queries.push(after);
    const index = after === undefined ? 0 : Number(after);
    const calls = history.slice(index, index + 2);
    return { calls, next: index + calls.length < history.length ? calls.at(-1)?.callId : undefined };
  }, { maxPages: 2, timeoutMs: 5_000 });
  const source = new NativeInferenceSource("agent", "alpha", ledger);
  const data = await source.pullTurn("last", { after: "400" });
  expect(queries).toEqual(["400", "402"]);
  expect(data.lastSeenCallId).toBe("403");
  expect(data.calls.map(entry => entry.callId)).toEqual(["401", "402", "403"]);
  expect(source.drain(source.sessionKey)).toHaveLength(3);
});

test("native usage publishes no stale or partial batch after a paging or host failure", async () => {
  let state: "normal" | "repeated" | "bad-cursor" | "host-down" = "normal";
  const down = new Error("host stopped");
  const ledger = new NativeUsageLedger(async ({ after }) => {
    if (state === "host-down") throw down;
    if (state === "bad-cursor") return { calls: [call("1", "alpha", "t1")], next: "0" };
    if (state === "repeated" && after === undefined) return { calls: [call("1", "alpha", "t1")], next: "1" };
    return { calls: [call("1", "alpha", "t1")] };
  });
  const source = new NativeInferenceSource("agent", "alpha", ledger);
  await source.pullTurn("t1");
  state = "repeated";
  await expect(source.pullTurn("t1")).rejects.toThrow("invalid or repeated call ID");
  expect(source.isHealthy()).toBe(false);
  expect(source.drain(source.sessionKey)).toEqual([]);
  state = "bad-cursor";
  await expect(source.pullTurn("t1")).rejects.toThrow("cursor did not advance");
  state = "host-down";
  await expect(source.pullTurn("t1")).rejects.toBe(down);
  expect(source.drain(source.sessionKey)).toEqual([]);
  state = "normal";
  expect((await source.pullTurn("t1")).calls).toHaveLength(1);
  expect(source.isHealthy()).toBe(true);
});

test("native usage rejects invalid counts and attempt IDs without publishing an inference", async () => {
  let attempts = [attempt("1", 0, { inputTokens: -1, outputTokens: 0, totalTokens: 0 })];
  const ledger = new NativeUsageLedger(async () => ({ calls: [call("1", "alpha", "t1", attempts)] }));
  const source = new NativeInferenceSource("agent", "alpha", ledger);
  await expect(source.pullTurn("t1")).rejects.toThrow("Invalid native model usage field");
  expect(source.drain(source.sessionKey)).toEqual([]);
  attempts = [attempt("1", 0, firstUsage), { ...attempt("1", 1, secondUsage), attemptId: "1:0" }];
  await expect(source.pullTurn("t1")).rejects.toThrow("invalid or repeated attempt ID");
  expect(source.isHealthy()).toBe(false);
});

test("a hung native usage pull does not hold the next channel and can be cancelled", async () => {
  const entered = Promise.withResolvers<void>();
  const never = Promise.withResolvers<{ calls: ModelCallSummary[] }>();
  let reads = 0;
  const ledger = new NativeUsageLedger(async () => {
    if (++reads === 1) {
      entered.resolve();
      return never.promise;
    }
    return { calls: [call("2", "beta", "t1")] };
  });
  const alpha = new NativeInferenceSource("agent", "alpha", ledger);
  const beta = new NativeInferenceSource("agent", "beta", ledger);
  const cancel = new AbortController();
  const pending = alpha.pullTurn("t1", { signal: cancel.signal }).catch(error => error);
  try {
    await entered.promise;
    expect((await beta.pullTurn("t1")).calls.map(entry => entry.callId)).toEqual(["2"]);
  } finally {
    cancel.abort();
  }
  expect((await pending).message).toContain("read cancelled");
  expect(alpha.isHealthy()).toBe(false);
  expect(beta.drain(beta.sessionKey)).toHaveLength(1);
  never.resolve({ calls: [call("1", "alpha", "t1")] });
  expect(alpha.drain(alpha.sessionKey)).toEqual([]);
});

test("native usage fails closed on the elapsed and page budgets", async () => {
  const hung = new NativeUsageLedger(() => new Promise(() => {}), { timeoutMs: 15, maxPages: 3 });
  await expect(hung.readTurn("alpha", "t1")).rejects.toThrow("read timed out");
  const paged = new NativeUsageLedger(async () => ({
    calls: [call("1", "alpha", "t1")], next: "1",
  }), { timeoutMs: 5_000, maxPages: 1 });
  await expect(paged.readTurn("alpha", "t1")).rejects.toThrow("exceeded its page budget");
});
