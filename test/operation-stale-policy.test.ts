import { expect, test } from "bun:test";
import { stalePolicy, validateStaleLimits } from "../src/operations/stale-policy.ts";
import type { OperationActivity } from "../src/operations/contracts.ts";

const activity: OperationActivity = {
  operationId: "x",
  kind: "turn",
  stage: "waiting",
  startedAt: 100,
  lastOutputAt: null,
  toolsInFlight: 0,
};
const streaming: OperationActivity = { ...activity, stage: "streaming", lastOutputAt: 150 };

test("first/next limits count from output and can be disabled independently", () => {
  expect(stalePolicy(activity, 0, null, { firstOutputMs: 10 }, 110)).toEqual({ deadline: 110, phase: "no_response", stale: true });
  expect(stalePolicy(activity, 0, null, { firstOutputMs: false }, 999999)).toBeNull();
  expect(stalePolicy(streaming, 0, null, { nextOutputMs: 50 }, 199)?.stale).toBe(false);
  expect(stalePolicy(streaming, 0, null, { nextOutputMs: false }, 999999)).toBeNull();
});

test("permission and cancellation suspend deadlines; tool limit uses oldest start", () => {
  expect(stalePolicy(activity, 1, null, {}, 999999)).toBeNull();
  expect(stalePolicy({ ...activity, stage: "cancelling" }, 0, null, {}, 999999)).toBeNull();
  const running = { ...activity, stage: "tool_running" as const, toolsInFlight: 2, lastOutputAt: 120 };
  expect(stalePolicy(running, 0, 110, {}, 999999)).toBeNull();
  expect(stalePolicy(running, 0, 110, { toolMs: 100 }, 210)?.deadline).toBe(210);
  for (const invalid of [-1, 0, NaN, Infinity]) {
    expect(() => validateStaleLimits({ firstOutputMs: invalid })).toThrow();
  }
});
