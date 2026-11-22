import { describe, expect, test } from "bun:test";
import { HarnessInternalInferenceRuntime } from "../../src/internal-inference/runtime/harness-runtime.ts";
import type { AgentControllerConfig } from "../../src/controller.ts";

describe("HarnessInternalInferenceRuntime", () => {
  test("uses a fresh session, reports lifecycle, and always stops", async () => {
    const calls: string[] = [];
    let effective: AgentControllerConfig | undefined;
    const runtime = new HarnessInternalInferenceRuntime({
      controllerConfig: () => ({
        adapter: { command: ["unused"] },
        adapterId: "original",
        mcpServers: [{ type: "stdio", name: "must-be-removed", command: "unused", args: [] }],
      }),
      createController(config) {
        effective = config;
        return {
          async startFresh() { calls.push("start"); return { sessionId: "fresh-session" }; },
          async prompt(text) {
            calls.push(`prompt:${text}`);
            return {
              text: "answer",
              messages: [{ text: "answer" }],
              stopReason: "end_turn",
              status: "completed",
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            };
          },
          interrupt() { calls.push("interrupt"); },
          async stop() { calls.push("stop"); },
        };
      },
    });
    const stages: string[] = [];
    const result = await runtime.run({
      internalInferenceId: "aii-00000000-0000-0000-0000-000000000001",
      purpose: "conversation_checkpoint",
      agentSessionId: "ags-00000000-0000-0000-0000-000000000001",
      adapterId: "test",
      prompt: "summarize",
    }, undefined, {
      stageChanged: (stage) => stages.push(stage),
      sessionStarted: ({ internalSessionId }) => calls.push(`session:${internalSessionId}`),
    });

    expect(calls).toEqual(["start", "session:fresh-session", "prompt:summarize", "stop"]);
    expect(stages).toEqual(["creating_session", "prompting"]);
    expect(result.internalSessionId).toBe("fresh-session");
    expect(effective?.adapterId).toBe("test");
    expect(effective?.mcpServers).toEqual([]);
    expect(effective?.permissions).toEqual({ default: "ask" });
    expect(effective?.clientHandlers).toEqual({});
  });

  test("interrupts on abort and still stops after failure", async () => {
    const calls: string[] = [];
    const abort = new AbortController();
    const runtime = new HarnessInternalInferenceRuntime({
      controllerConfig: () => ({ adapter: { command: ["unused"] }, adapterId: "test" }),
      createController() {
        return {
          async startFresh() { return { sessionId: "fresh" }; },
          async prompt() { abort.abort(); throw new Error("stopped"); },
          interrupt() { calls.push("interrupt"); },
          async stop() { calls.push("stop"); },
        };
      },
    });
    await expect(runtime.run({
      internalInferenceId: "aii-00000000-0000-0000-0000-000000000002",
      purpose: "identity_update",
      agentSessionId: "ags-00000000-0000-0000-0000-000000000001",
      adapterId: "test",
      prompt: "update",
    }, abort.signal)).rejects.toThrow("stopped");
    expect(calls).toEqual(["interrupt", "stop"]);
  });
});

test("a silent inference is supervised, fails stalled and stops its disposable process", async () => {
  const { resolve } = await import("node:path");
  const runtime = new HarnessInternalInferenceRuntime({ controllerConfig: () => ({
    adapterId: "mock", adapter: { command: [process.execPath, resolve(import.meta.dir, "../fixtures/lifecycle-agent.ts")], cancelGraceMs: 30 },
    operationLifecycle: { internalInference: { firstOutputMs: 20, nextOutputMs: 20 } },
  }) });
  const stages: string[] = [];
  const error = await runtime.run({ internalInferenceId: "aii-00000000-0000-0000-0000-000000000003", purpose: "conversation_checkpoint",
    agentSessionId: "ags-00000000-0000-0000-0000-000000000001", adapterId: "mock", prompt: "[lifecycle:silent]" }, undefined, {
    sessionStarted() {}, operationChanged: (source) => { if (source) stages.push(source().stage); },
  }).catch((error) => error);
  expect(error.code).toBe("stalled"); expect(error.phase).toBe("no_response");
  expect(stages).toEqual(["waiting", "cancelling"]);
});
