import { SESSION_INTAKE_LIMITS } from "../../util/intake.ts";
import { isTimelineTool } from "../../util/timeline-tool-names.ts";
import type { ContextLimits, InferenceContext, InferenceStorageReads, ContextBuildResult, ContextCapture, ContextTurnOutcome } from "../../contracts/context.ts";
import { SESSION_INPUT_MAX_BYTES } from "../../contracts/input-limits.ts";
import type { ToolDefinition } from "../../contracts/loop.ts";
import type { TimelineEntry } from "../../contracts/storage.ts";
import { buildContext } from "./build.ts";
import { composeSystemPrompt } from "./load-instructions.ts";

export const CONTEXT_LIMITS: ContextLimits = {
  maxInputBytes: SESSION_INPUT_MAX_BYTES, ...SESSION_INTAKE_LIMITS,
  maxReadBytes: 256 * 1024, maxReadRecords: 64, maxSharedCandidates: 128,
  contextTokens: 16_384, outputReserveTokens: 2048, estimationMarginTokens: 1024,
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const order = (a: TimelineEntry, b: TimelineEntry) => a.seq - b.seq;

type Offer = { tools: ToolDefinition[]; fixedToolCount?: number };
/** One builder per session. Each inference independently captures a committed
 * read and a tool offer. The runner reuses the resulting request on retry. */
export function createSessionContext(storage: InferenceStorageReads, sessionId: string, systemPrompt: string,
  limits = CONTEXT_LIMITS, capture?: (value: ContextCapture) => void) {
  const budget = limits.contextTokens - limits.outputReserveTokens - limits.estimationMarginTokens;
  if (budget <= 0 || limits.maxInputBytes > limits.maxTakenTextBytes || limits.maxTakenItems < 1)
    throw new Error("Invalid context budget");
  const instructions = composeSystemPrompt(systemPrompt);
  return {
    build(turn: { channelId: string; turnId: number }, offerTools: (policies: readonly string[]) => Offer): ContextBuildResult {
      const overflow = { ok: false, code: "context_limit", message: "Required inference material exceeds the context budget" } as const;
      const read = storage.readInferenceContext({ ...turn, limits });
      if (!read.ok) throw new Error(read.error.message);
      if ("code" in read.value) return overflow;
      const { required, optionalTurn, localHistory, sharedHistory, unfinished, policyNames, takenItemIds } = read.value;
      const toolOffer = offerTools(policyNames);
      const active = [...required], local: TimelineEntry[] = [], shared: TimelineEntry[] = [];
      const groups: TimelineEntry[][] = [];
      const retrievalCalls = new Set<string>();
      let exchange: TimelineEntry[] | undefined;
      for (const row of optionalTurn) {
        if (row.message.role === "assistant") {
          for (const call of row.message.calls) if (isTimelineTool(call.name)) retrievalCalls.add(call.id);
          exchange = [row]; groups.push(exchange);
        }
        else if (row.message.role === "tool") exchange?.push(row);
        else groups.push([row]);
      }
      const outcomes: ContextTurnOutcome[] = [];
      const render = () => buildContext([...local, ...shared, ...active].sort(order), instructions, turn, outcomes)
        .map(message => message.role === "tool" && !retrievalCalls.has(message.callId) && Buffer.byteLength(message.content, "utf8") > 2048
          ? { ...message, content: Buffer.from(message.content).subarray(0, 2048).toString("utf8") + "\n[Tool result shortened]" }
          : message);
      const size = () => bytes({ messages: render(), tools: toolOffer.tools });
      if (size() > budget) return overflow;
      for (const group of groups.reverse()) {
        active.push(...group);
        if (size() > budget) active.length -= group.length;
      }
      for (const outcome of unfinished) {
        outcomes.push(outcome);
        if (size() > budget) outcomes.pop();
      }
      const available = budget - size();
      function fill(rows: TimelineEntry[], candidates: readonly TimelineEntry[], ceiling: number) {
        const deferred: TimelineEntry[] = [];
        for (const row of [...candidates].reverse()) {
          rows.push(row);
          if (size() > ceiling) { rows.pop(); deferred.push(row); }
        }
        return deferred;
      }
      const localDeferred = fill(local, localHistory, budget - Math.floor(available / 3));
      fill(shared, sharedHistory, budget);
      fill(local, localDeferred.reverse(), budget);
      const value: InferenceContext = { sessionId, ...turn, timelineRevision: read.revision, messages: render(), ...toolOffer,
        representedItemIds: active.sort(order).flatMap(row => row.itemId === undefined ? [] : [row.itemId]), takenItemIds };
      // Diagnostics must not be able to mutate or prevent the provider request.
      if (capture) {
        try {
          const included = [...active, ...local, ...shared].map(row => row.seq).sort((a, b) => a - b);
          const kept = new Set(included);
          const trimmed = [...optionalTurn, ...localHistory, ...sharedHistory].map(row => row.seq)
            .filter(seq => !kept.has(seq)).sort((a, b) => a - b);
          capture(structuredClone({ context: value, estimatedInputBytes: bytes({ messages: value.messages, tools: value.tools }),
            records: { included, trimmed }, omitted: {
              active: optionalTurn.length + required.length - active.length,
              local: localHistory.length - local.length, shared: sharedHistory.length - shared.length,
            } }));
        } catch { /* best-effort observation */ }
      }
      return { ok: true, value };
    },
  };
}
