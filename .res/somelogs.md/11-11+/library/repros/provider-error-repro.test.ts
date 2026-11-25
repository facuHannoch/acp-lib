import { expect, test } from "bun:test";
import { runModelCall } from "/home/ffacu/q/apps/libs/acp-lib/src/native-harness/src/capabilities/model/runner.ts";
const ok = <T>(value: T) => ({ ok: true as const, value, revision: 1 });
test("what does a provider failure look like when it leaves the model runner?", async () => {
  let n = 0;
  const store: any = {
    startCall: () => ok({ callId: "c", messageId: "m" }),
    startAttempt: () => ok({ attemptId: String(n++), scriptStep: 0 }),
    recordProviderRequestId: () => ok(undefined), confirm: () => ok([]), recordUsage: () => ok(undefined),
    finishAttempt: () => ok(undefined), finishCall: () => ok(undefined), commitResponse: () => ok({}),
  };
  const attempt = () => async function* () { yield { type: "failure", kind: "transient", message: "OpenRouter 429: rate limit exceeded for model openai/gpt-4.1-mini" } as any; };
  let caught: any;
  try { await runModelCall({ turnId: "1", itemIds: [], request: { messages: [], tools: [] }, scripted: true, store, attempt, settings: { retryDelayMs: 1, timeoutMs: 1000 } } as any); } catch (e) { caught = e; }
  console.log("runner error: outcome=%j message=%j", caught?.outcome, caught?.message);
  // What the channel records as the turn's reason (kernel/channels.ts:188):
  const reason = caught && typeof caught === "object" && "outcome" in caught && typeof caught.outcome === "string" ? caught.outcome : String(caught);
  console.log("turn reason recorded by the harness: %j", reason);
  expect(true).toBe(true);
});
