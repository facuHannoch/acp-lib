import type { ActivityEvent } from "../types.ts";
const terminal = new Set(["completed", "failed"]);
/** Timing state only; tool content stays in the presentation aggregator. */
export class ToolTracker {
  private readonly tools = new Map<string, { status: string; startedAt: number }>();
  get inFlight(): number {
    return [...this.tools.values()].filter((tool) => !terminal.has(tool.status)).length;
  }
  get oldestStartedAt(): number | null {
    const starts = [...this.tools.values()].filter((tool) => !terminal.has(tool.status)).map((tool) => tool.startedAt);
    return starts.length ? Math.min(...starts) : null;
  }
  /** True when this update settles a previously unsettled tool. */
  observe(event: ActivityEvent, now = Date.now()): boolean {
    if (event.kind !== "tool" && event.kind !== "tool_update") return false;
    const previous = this.tools.get(event.toolCallId);
    const status = event.status ?? previous?.status ?? "pending";
    this.tools.set(event.toolCallId, { status, startedAt: previous?.startedAt ?? now });
    return terminal.has(status) && !terminal.has(previous?.status ?? "pending");
  }
}
