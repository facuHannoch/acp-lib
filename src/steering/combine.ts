import type { PromptHandlers } from "../types.ts";
import type { PromptPart, SteeringPrompt } from "./contracts.ts";

/** Text of a combined prompt: the messages in order, separated by a blank line. Nothing is added. */
export const COMBINED_TEXT_SEPARATOR = "\n\n";

/**
 * Every combined message keeps its own handlers: each one receives the events of the shared turn.
 * Permission requests have one answer, so the first message that handles them decides.
 */
export function mergeHandlers(list: readonly (PromptHandlers | undefined)[]): PromptHandlers | undefined {
  const handlers = list.filter((entry): entry is PromptHandlers => entry !== undefined);
  if (handlers.length === 0) return undefined;
  if (handlers.length === 1) return handlers[0];
  const merged: PromptHandlers = {
    onChunk: (text) => handlers.forEach((entry) => entry.onChunk?.(text)),
    onResponseChunk: (chunk) => handlers.forEach((entry) => entry.onResponseChunk?.(chunk)),
    onActivity: (event) => handlers.forEach((entry) => entry.onActivity?.(event)),
    onRecord: (record) => handlers.forEach((entry) => entry.onRecord?.(record)),
    onUpdate: (notification) => handlers.forEach((entry) => entry.onUpdate?.(notification)),
  };
  const permission = handlers.find((entry) => entry.onPermissionRequest)?.onPermissionRequest;
  if (permission) merged.onPermissionRequest = permission;
  return merged;
}

function partOf(prompt: SteeringPrompt): PromptPart {
  return {
    id: prompt.turnId,
    text: prompt.text,
    ...(prompt.participantId ? { participantId: prompt.participantId } : {}),
    ...(prompt.consumerMetadata !== undefined ? { consumerMetadata: prompt.consumerMetadata } : {}),
  };
}

/**
 * Build the one prompt that carries a run of messages. The head keeps its id, so the combined prompt
 * is one operation (one metering record). Every original promise settles with the same result.
 * A run of one is returned unchanged.
 */
export function combinePrompts<T extends SteeringPrompt>(run: readonly T[]): T {
  const [head] = run;
  if (!head) throw new Error("cannot combine an empty run of prompts");
  if (run.length === 1) return head;
  const attachments = run.flatMap((prompt) => prompt.attachments ?? []);
  const handlers = mergeHandlers(run.map((prompt) => prompt.handlers));
  return {
    ...head,
    text: run.map((prompt) => prompt.text).join(COMBINED_TEXT_SEPARATOR),
    parts: run.map(partOf),
    ...(attachments.length > 0 ? { attachments } : { attachments: undefined }),
    ...(handlers ? { handlers } : { handlers: undefined }),
    resolve: (result) => run.forEach((prompt) => prompt.resolve(result)),
    reject: (error) => run.forEach((prompt) => prompt.reject(error)),
  };
}
