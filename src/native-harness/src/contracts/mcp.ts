/** Portable header declaration. Resolved material belongs to an executable open. */
export type McpHeader = { literal: string } | { env: string } | { runtime: true };
/** Trusted session configuration, validated without spawning or connecting. */
export type McpServer = { enabled?: boolean } & (
  { transport: "stdio"; command: string; args: string[]; cwd?: string; env?: Record<string, { env: string }> }
  | { transport: "http"; endpoint: string; headers?: Record<string, McpHeader> }
);
export type McpRuntimeHeaders = Record<string, Record<string, string>>;
