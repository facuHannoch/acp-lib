import type { PromptQueueItem } from "./context.ts";

type ClearedOperation = PromptQueueItem | {
  readonly kind: "handoff" | "set_config" | "resolve_config" | "resolve_recovery" | "set_mode";
  reject(error: unknown): void;
};

export function dropClearedOperations(
  operations: readonly ClearedOperation[],
  backend: readonly PromptQueueItem[],
  drop: (messages: readonly PromptQueueItem[], error?: Error) => void,
  cancellation?: Error,
): void {
  // A prompt cancelled before dispatch consumes no provider usage.
  drop([...operations.filter((item): item is PromptQueueItem => item.kind === "prompt"), ...backend], cancellation);
  for (const item of operations) {
    if (item.kind === "prompt") continue;
    const label = item.kind === "handoff"
      ? "handoff"
      : item.kind === "set_config" || item.kind === "resolve_config"
        ? "configuration change"
        : item.kind === "resolve_recovery"
          ? "recovery resolution"
          : "mode change";
    item.reject(cancellation ?? new Error(`${label} cancelled before it started`));
  }
}
