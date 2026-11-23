import type { StorageSnapshot } from "../../../contracts/storage.ts";
import type { ToolInvocation } from "../../../contracts/tools.ts";

export const invocationId = (turnId: number | string, toolCallId: string) => `${turnId}:${toolCallId}`;

/** Invocation records for one turn, in request order, derived from what storage
 * already commits (decision 0021): the assistant's calls, the dispatch
 * evidence of decision 0018, the paired results and the turn's end. `waiting`
 * holds the invocation IDs with a live approval request in this process. */
export function turnInvocations(view: StorageSnapshot, turnId: number, waiting: ReadonlySet<string> = new Set()): ToolInvocation[] {
  const turn = view.turns.find(value => value.turnId === turnId);
  if (!turn) return [];
  const results = new Map<string, Extract<StorageSnapshot["timeline"][number]["message"], { role: "tool" }>>();
  for (const entry of view.timeline) if (entry.turnId === turnId && entry.message.role === "tool") results.set(entry.message.callId, entry.message);
  const state = turn.state;
  const dispatched = state.status === "running" || state.status === "suspended" ? state.dispatchedCallIds : undefined;
  const ended = state.status === "failed" || state.status === "interrupted";
  const uncertain = ended ? new Set(state.uncertainCallIds) : undefined;
  const records: ToolInvocation[] = [];
  for (const entry of view.timeline) {
    if (entry.turnId !== turnId || entry.message.role !== "assistant") continue;
    for (const call of entry.message.calls) {
      const id = invocationId(turnId, call.id), result = results.get(call.id);
      const base = { invocationId: id, channel: turn.channelId, turnId: String(turnId), toolCallId: call.id, tool: call.name, arguments: call.arguments };
      if (result) {
        // A result written before decision 0021, or by a built-in, is a success.
        const outcome = result.outcome ?? { status: "succeeded" as const };
        records.push({ ...base, state: outcome.status, ...(outcome.code === undefined ? {} : { code: outcome.code }),
          ...(outcome.status === "skipped" ? { effect: "none" as const } : outcome.status === "interrupted" ? { effect: "unknown" as const } : {}),
          ...(outcome.reference ? { reference: outcome.reference } : {}) });
      } else if (uncertain) {
        // The turn ended. With dispatch evidence and no result the effect is
        // unknown, and stays so: the harness never repeats the call. Without
        // evidence the call never left the harness.
        records.push(uncertain.has(call.id) ? { ...base, state: "interrupted", effect: "unknown" } : { ...base, state: "skipped", code: "turn_ended", effect: "none" });
      } else if (dispatched?.includes(call.id)) records.push({ ...base, state: "started" });
      else records.push({ ...base, state: waiting.has(id) ? "waiting_for_approval" : "requested" });
    }
  }
  return records;
}

/** One record by its ID, or undefined. */
export function findInvocation(view: StorageSnapshot, id: string, waiting?: ReadonlySet<string>): ToolInvocation | undefined {
  const at = id.indexOf(":"), turnId = Number(id.slice(0, at));
  if (at < 1 || !Number.isSafeInteger(turnId) || String(turnId) !== id.slice(0, at)) return undefined;
  return turnInvocations(view, turnId, waiting).find(record => record.invocationId === id);
}
