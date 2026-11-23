import type { ToolExecutionResult } from "../../../contracts/loop.ts";

export function debugFailure(code: "invalid_arguments" | "debug_failure", message: string): ToolExecutionResult {
  return { content: JSON.stringify({ ok: false, error: { code, message } }), outcome: { status: "failed", code } };
}

export function debugArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* The executor reports a typed argument error. */ }
}
