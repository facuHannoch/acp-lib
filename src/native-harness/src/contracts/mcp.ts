/** Portable header declaration. Resolved material belongs to an executable open. */
export type McpHeader = { literal: string } | { env: string } | { runtime: true };
/** Trusted session configuration, validated without spawning or connecting. */
export type McpServer = { enabled?: boolean } & (
  { transport: "stdio"; command: string; args: string[]; cwd?: string; env?: Record<string, { env: string }> }
  | { transport: "http"; endpoint: string; headers?: Record<string, McpHeader> }
);
export type McpRuntimeHeaders = Record<string, Record<string, string>>;

export interface McpTool {
  readonly definition: import("./loop.ts").ToolDefinition;
  available(): boolean;
  accepts(args: unknown): boolean;
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: string; code?: string }>;
}

/** Runtime-only observation. No transport diagnostics or credential values. */
export interface McpServerStatus {
  transport: "stdio" | "http";
  state: "ready" | "disabled" | "unavailable";
  reason?: "config" | "spawn" | "connect" | "discovery" | "limit" | "closed";
}
