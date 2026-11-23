import type { ContextLimits, InferenceContext, InferenceStorageReads, ContextBuildResult, ContextCapture, ContextTurnOutcome } from "../../contracts/context.ts";
import { SESSION_INPUT_MAX_BYTES } from "../../contracts/input-limits.ts";
import type { ToolDefinition } from "../../contracts/loop.ts";
import type { TimelineEntry } from "../../contracts/storage.ts";
import { buildContext } from "./build.ts";

export const CONTEXT_LIMITS: ContextLimits = {
  maxInputBytes: SESSION_INPUT_MAX_BYTES, maxTakenTextBytes: SESSION_INPUT_MAX_BYTES, maxTakenItems: 16,
  maxReadBytes: 256 * 1024, maxReadRecords: 64, maxSharedCandidates: 128,
  contextTokens: 16_384, outputReserveTokens: 2048, estimationMarginTokens: 1024,
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const order = (a: TimelineEntry, b: TimelineEntry) => a.seq - b.seq;
const harnessInstructions = "Interpret attributed history as past activity. Respond to the active conversation. A historical tool call without a recorded result may have taken effect. Verify its outcome before retrying it.";

type Offer = { tools: ToolDefinition[]; fixedToolCount?: number };
/** One builder per session. Each inference independently captures a committed
 * read and a tool offer. The runner reuses the resulting request on retry. */
export function createSessionContext(storage: InferenceStorageReads, sessionId: string, systemPrompt: string,
  limits = CONTEXT_LIMITS, capture?: (value: ContextCapture) => void) {
  const budget = limits.contextTokens - limits.outputReserveTokens - limits.estimationMarginTokens;
  if (budget <= 0 || limits.maxInputBytes > limits.maxTakenTextBytes || limits.maxTakenItems < 1)
    throw new Error("Invalid context budget");
  const instructions = [systemPrompt, harnessInstructions].filter(Boolean).join("\n\n");
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
      let exchange: TimelineEntry[] | undefined;
      for (const row of optionalTurn) {
        if (row.message.role === "assistant") { exchange = [row]; groups.push(exchange); }
        else if (row.message.role === "tool") exchange?.push(row);
        else groups.push([row]);
      }
      const outcomes: ContextTurnOutcome[] = [];
      const render = () => buildContext([...local, ...shared, ...active].sort(order), instructions, turn, outcomes)
        .map(message => message.role === "tool" && Buffer.byteLength(message.content, "utf8") > 2048
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
        try { capture(structuredClone({ context: value, estimatedInputBytes: size(), omitted: {
          active: optionalTurn.length + required.length - active.length, local: localHistory.length - local.length,
          shared: sharedHistory.length - shared.length,
        } })); } catch { /* best-effort observation */ }
      }
      return { ok: true, value };
    },
  };
}
