import { afterEach, describe, expect, test } from "bun:test";
import { OpencodeMeteringChannel } from "../src/metering/opencode/channel.ts";
import { sumInferenceTokens } from "../src/metering/engine.ts";
import type { ProviderInference } from "../src/metering/opencode/channel.ts";

let channel: OpencodeMeteringChannel | null = null;

afterEach(async () => {
  await channel?.stop();
  channel = null;
});

function start(): OpencodeMeteringChannel {
  channel = new OpencodeMeteringChannel();
  channel.start();
  return channel;
}

async function post(target: OpencodeMeteringChannel, body: unknown, token = target.token) {
  return fetch(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-acp-meter-token": token },
    body: JSON.stringify(body),
  });
}

/** One assistant message as OpenCode reports it. */
const inference = (over: Record<string, unknown> = {}) => ({
  type: "inference",
  messageID: "msg_1",
  sessionID: "ses_1",
  providerID: "opencode-go",
  modelID: "kimi-k2.6",
  summary: false,
  completedAt: 1_700_000_000_000,
  cost: 0.00251802,
  tokens: { input: 454, output: 139, reasoning: 55, cache: { read: 8192, write: 0 } },
  ...over,
});

describe("OpenCode metering channel", () => {
  test("binds to loopback only", () => {
    expect(start().url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/inference$/);
  });

  test("records the plugin handshake, distinguishing 'not loaded' from 'silent'", async () => {
    const target = start();
    expect(target.handshake).toBeNull();
    await post(target, { type: "hello", pid: 42, directory: "/tmp/x", at: 123 });
    expect(target.handshake).toEqual({ pid: 42, directory: "/tmp/x", at: 123 });
  });

  test("normalizes OpenCode's token shape, deriving the total from disjoint categories", async () => {
    const target = start();
    await post(target, inference());
    const [record] = target.drain();
    expect(record?.tokens).toEqual({
      // 454 + 139 + 55 + 8192 + 0
      totalTokens: 8840,
      inputTokens: 454,
      outputTokens: 139,
      cachedReadTokens: 8192,
      cachedWriteTokens: 0,
      thoughtTokens: 55,
    });
    expect(record?.providerID).toBe("opencode-go");
    expect(record?.cost).toBe(0.00251802);
  });

  test("dedupes by messageID — the same inference twice would inflate a bill", async () => {
    const target = start();
    await post(target, inference());
    await post(target, inference({ cost: 0.5 }));
    const drained = target.drain();
    expect(drained).toHaveLength(1);
    // Last write wins: a message is reported again as it settles.
    expect(drained[0]?.cost).toBe(0.5);
  });

  test("a drain takes everything once", async () => {
    const target = start();
    await post(target, inference({ messageID: "a" }));
    await post(target, inference({ messageID: "b" }));
    expect(target.drain()).toHaveLength(2);
    expect(target.drain()).toHaveLength(0);
    expect(target.pendingCount).toBe(0);
  });

  test("rejects a bad token — loopback is not an authorization boundary", async () => {
    const target = start();
    const response = await post(target, inference(), "wrong-token");
    expect(response.status).toBe(403);
    expect(target.drain()).toHaveLength(0);
    expect(target.rejectedCount).toBe(1);
  });

  test("rejects malformed records rather than storing partial usage", async () => {
    const target = start();
    for (const bad of [
      inference({ messageID: undefined }),
      inference({ tokens: { output: 1, cache: {} } }),
      inference({ completedAt: "soon" }),
      inference({ tokens: { input: -1, output: 1, cache: {} } }),
      { type: "unknown" },
    ]) {
      const response = await post(target, bad);
      expect(response.ok).toBe(false);
    }
    expect(target.drain()).toHaveLength(0);
    expect(target.rejectedCount).toBe(5);
  });

  test("marks compaction summaries, which no user prompt asked for", async () => {
    const target = start();
    await post(target, inference({ summary: true }));
    expect(target.drain()[0]?.summary).toBe(true);
  });
});

describe("summing inferences into one operation", () => {
  const record = (tokens: Partial<Record<string, number>>): ProviderInference =>
    ({
      messageID: "m",
      sessionID: "s",
      providerID: "p",
      modelID: "m",
      summary: false,
      completedAt: 0,
      cost: 0,
      tokens: {
        totalTokens: 0,
        inputTokens: tokens.input ?? 0,
        outputTokens: tokens.output ?? 0,
        ...(tokens.cachedRead !== undefined ? { cachedReadTokens: tokens.cachedRead } : {}),
        ...(tokens.thought !== undefined ? { thoughtTokens: tokens.thought } : {}),
      },
    }) as ProviderInference;

  test("sums the measured two-inference turn", () => {
    // The turn ACP reported as one inference: 8840 + 9118.
    const summed = sumInferenceTokens([
      record({ input: 454, output: 139, thought: 55, cachedRead: 8192 }),
      record({ input: 860, output: 27, thought: 39, cachedRead: 8192 }),
    ]);
    expect(summed.inputTokens).toBe(1314);
    expect(summed.cachedReadTokens).toBe(16384);
    expect(summed.thoughtTokens).toBe(94);
    expect(summed.totalTokens).toBe(17958);
  });

  test("a category no inference reported stays absent, not zero", () => {
    const summed = sumInferenceTokens([record({ input: 10, output: 2 })]);
    expect("cachedReadTokens" in summed).toBe(false);
    expect("thoughtTokens" in summed).toBe(false);
  });

  test("a category some inferences reported is summed over those that did", () => {
    const summed = sumInferenceTokens([
      record({ input: 10, output: 1, cachedRead: 100 }),
      record({ input: 10, output: 1 }),
    ]);
    expect(summed.cachedReadTokens).toBe(100);
  });
});
