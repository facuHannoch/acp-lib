import type { ManagedConfig, ToolDecision } from "../../contracts/config-permissions.ts";

export class PolicyError extends Error {
  readonly code = "invalid_policy";
  constructor(readonly policy: string) { super(`Unknown policy: ${policy}`); }
}
export function resolvePolicy(config: ManagedConfig, explicit?: string | null, channel?: string | null): string {
  const selected = explicit ?? channel ?? config.defaultPolicy;
  if (!Object.hasOwn(config.policies, selected)) throw new PolicyError(selected);
  return selected;
}
/** A taken input contributes all its policy names; no pending input is passed. */
export function toolDecision(config: ManagedConfig, references: readonly string[], tool: string): ToolDecision {
  let result: ToolDecision = "allow";
  for (const reference of new Set(references)) {
    if (!Object.hasOwn(config.policies, reference)) throw new PolicyError(reference);
    const policy = config.policies[reference]!;
    const next = Object.hasOwn(policy.tools, tool) ? policy.tools[tool]! : policy.fallback;
    if (next === "deny") return "deny";
    if (next === "ask") result = "ask";
  }
  return result;
}
/** Stable comparison independent of insertion order. */
export function policyFingerprint(config: ManagedConfig, references: readonly string[]): string {
  return JSON.stringify([...new Set(references)].sort().map(name => {
    if (!Object.hasOwn(config.policies, name)) throw new PolicyError(name);
    const policy = config.policies[name]!;
    return [name, policy.fallback, Object.keys(policy.tools).sort().map(tool => [tool, policy.tools[tool]])];
  }));
}
