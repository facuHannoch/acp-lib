import { expect, test } from "bun:test";
import { ToolTracker } from "../src/operations/activity-tracker.ts";
test("tool tracking preserves partial updates and reports the last tool boundary", () => {
  const tracker = new ToolTracker();
  tracker.observe({ kind: "tool", toolCallId: "a", status: "pending" } as any, 10);
  tracker.observe({ kind: "tool", toolCallId: "b", status: "in_progress" } as any, 20);
  tracker.observe({ kind: "tool_update", toolCallId: "a" } as any, 30);
  expect(tracker.inFlight).toBe(2);
  expect(tracker.oldestStartedAt).toBe(10);
  expect(tracker.observe({ kind: "tool_update", toolCallId: "a", status: "completed" } as any)).toBe(true);
  expect(tracker.inFlight).toBe(1);
  expect(tracker.observe({ kind: "tool_update", toolCallId: "a", status: "completed" } as any)).toBe(false);
  tracker.observe({ kind: "tool_update", toolCallId: "b", status: "failed" } as any);
  expect(tracker.inFlight).toBe(0);
});
