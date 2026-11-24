import type { PermissionOutcome } from "../types.ts";
import type { PermissionLevel, PermissionSettings } from "./matcher.ts";
import type { PermissionOption } from "./request.ts";

/** Translate an automatic level to an ACP reply. Ask is left for the caller to route. */
export function selectPermissionOutcome(
  level: PermissionLevel,
  options: readonly PermissionOption[],
): PermissionOutcome | undefined {
  if (level === "ask") return undefined;
  const option = level === "allow"
    ? options.find(({ kind }) => kind === "allow_once") ?? options.find(({ kind }) => kind === "allow_always")
    : options.find(({ kind }) => kind === "reject_once");
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

// Preserve the intent across internal prompt handlers that return only a PermissionOutcome.
export const unansweredCancellation = Object.freeze({ outcome: "cancelled" } as const);

/** An unattended ask can refuse only the tool, or cancel instead. */
export function unansweredPermissionOutcome(
  options: readonly PermissionOption[],
  mode: PermissionSettings["unanswered"],
): PermissionOutcome {
  return mode === "cancel" ? unansweredCancellation : selectPermissionOutcome("deny", options)!;
}
