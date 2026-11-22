import { HANDOFF_SUMMARY_PROMPT } from "./agent-conversation-continuation.ts";
import type { HandoffOptions } from "./agent-conversation-contracts.ts";

/** Capture handoff options when the operation enters the queue. */
export function ownHandoffOptions(options: HandoffOptions): HandoffOptions {
  return Object.freeze({
    ...(options.summary === undefined ? {} : { summary: options.summary }),
    ...(options.target === undefined
      ? {}
      : {
          target: Object.freeze({
            adapterId: options.target.adapterId,
            ...(options.target.mode === undefined ? {} : { mode: options.target.mode }),
            ...(options.target.adapter === undefined
              ? {}
              : {
                  adapter: Object.freeze({
                    ...(options.target.adapter.cancelGraceMs === undefined
                      ? {}
                      : { cancelGraceMs: options.target.adapter.cancelGraceMs }),
                    ...options.target.adapter,
                    command: Object.freeze([...options.target.adapter.command]) as unknown as string[],
                    ...(options.target.adapter.ptyCommand
                      ? {
                          ptyCommand: Object.freeze([
                            ...options.target.adapter.ptyCommand,
                          ]) as unknown as string[],
                        }
                      : {}),
                  }),
                }),
            ...(options.target.config === undefined
              ? {}
              : { config: Object.freeze({ ...options.target.config }) }),
          }),
        }),
    ...(options.continuation === undefined
      ? {}
      : { continuation: Object.freeze({ ...options.continuation }) }),
    ...(options.targetPrompt === undefined ? {} : { targetPrompt: options.targetPrompt }),
  });
}

export function normalizeHandoffContinuation(options: HandoffOptions):
  | { readonly kind: "generated"; readonly summaryPrompt: string }
  | { readonly kind: "provided"; readonly content: string }
  | { readonly kind: "none" } {
  if (options.summary !== undefined && options.continuation !== undefined) {
    throw new Error("handoff cannot combine deprecated summary with continuation");
  }
  if (options.target && !options.target.adapterId.trim()) {
    throw new Error("handoff target adapter id cannot be blank");
  }
  if (options.targetPrompt !== undefined && !options.targetPrompt.trim()) {
    throw new Error("handoff target prompt cannot be blank");
  }
  if (options.summary !== undefined) {
    if (!options.summary.trim()) throw new Error("handoff summary cannot be blank");
    return Object.freeze({ kind: "provided", content: options.summary });
  }
  const continuation = options.continuation ?? { kind: "generated" as const };
  if (continuation.kind === "provided") {
    if (!continuation.content.trim()) throw new Error("handoff continuation cannot be blank");
    return Object.freeze({ kind: "provided", content: continuation.content });
  }
  if (continuation.kind === "none") return Object.freeze({ kind: "none" });
  if (continuation.summaryPrompt !== undefined && continuation.summaryInstructions !== undefined) {
    throw new Error("handoff generated continuation cannot combine summaryPrompt and summaryInstructions");
  }
  if (continuation.summaryPrompt !== undefined && !continuation.summaryPrompt.trim()) {
    throw new Error("handoff summary prompt cannot be blank");
  }
  if (continuation.summaryInstructions !== undefined && !continuation.summaryInstructions.trim()) {
    throw new Error("handoff summary instructions cannot be blank");
  }
  const base = continuation.summaryPrompt ?? HANDOFF_SUMMARY_PROMPT;
  const summaryPrompt = continuation.summaryInstructions === undefined
    ? base
    : `${base}\n\nAdditional summary instructions:\n${continuation.summaryInstructions}`;
  return Object.freeze({ kind: "generated", summaryPrompt });
}
