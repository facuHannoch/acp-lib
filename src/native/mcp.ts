import { HarnessClientError, type CreateParams, type InitializeResult, type PushParams, type StatusResult } from "../native-harness/src/client.ts";
import { codeOf } from "./errors.ts";

export type NativeInputPolicy = NonNullable<PushParams["item"]["policy"]>;
export type McpRuntimeHeaders = NonNullable<CreateParams["mcpRuntimeHeaders"]>;
export type McpRuntimeHeadersProvider = () => McpRuntimeHeaders | Promise<McpRuntimeHeaders>;
export type NativeMcpStatus = {
  readonly capabilities?: InitializeResult["description"]["capabilities"]["mcpServers"];
  readonly servers?: StatusResult["mcpServers"];
  readonly stale: boolean;
};

export async function executableMcpOpen<T>(provider: McpRuntimeHeadersProvider | undefined, signal: AbortSignal,
  send: (material?: McpRuntimeHeaders) => Promise<T>): Promise<T> {
  if (!provider) return send();
  let material: McpRuntimeHeaders;
  try { material = await provider(); }
  catch { throw new HarnessClientError("mcp_runtime_headers_failed", "Could not obtain native MCP runtime headers"); }
  signal.throwIfAborted();
  try { return await send(material); }
  catch (error) {
    const code = codeOf(error);
    const allowed = ["not_found", "timeout", "transport_closed", "closed", "storage_failure", "invalid_config",
      "invalid_params", "incompatible", "busy", "already_exists"];
    throw new HarnessClientError(code && allowed.includes(code) ? code : "mcp_open_failed",
      "Native harness executable open failed");
  }
}
