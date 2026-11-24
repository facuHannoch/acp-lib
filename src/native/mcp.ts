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

const runtimeHeaderLimits = { totalBytes: 8 * 1024, valueBytes: 2 * 1024 };

function validateRuntimeHeaderSize(material: McpRuntimeHeaders): void {
  const tooLarge = () => new HarnessClientError("mcp_runtime_headers_too_large",
    "Native MCP runtime headers exceed the 8 KiB total or 2 KiB per-value limit");
  for (const headers of Object.values(material)) {
    for (const value of Object.values(headers)) {
      if (Buffer.byteLength(value) > runtimeHeaderLimits.valueBytes) throw tooLarge();
    }
  }
  // Count JSON framing, names and escape expansion as well as the values.
  if (Buffer.byteLength(JSON.stringify(material)) > runtimeHeaderLimits.totalBytes) throw tooLarge();
}

export async function executableMcpOpen<T>(provider: McpRuntimeHeadersProvider | undefined, signal: AbortSignal,
  send: (material?: McpRuntimeHeaders) => Promise<T>): Promise<T> {
  if (!provider) return send();
  let material: McpRuntimeHeaders;
  try { material = await provider(); }
  catch { throw new HarnessClientError("mcp_runtime_headers_failed", "Could not obtain native MCP runtime headers"); }
  signal.throwIfAborted();
  try { validateRuntimeHeaderSize(material); }
  catch (error) {
    if (codeOf(error) === "mcp_runtime_headers_too_large") throw error;
    throw new HarnessClientError("mcp_runtime_headers_failed", "Could not encode native MCP runtime headers");
  }
  try { return await send(material); }
  catch (error) {
    const code = codeOf(error);
    const allowed = ["not_found", "timeout", "transport_closed", "closed", "storage_failure", "invalid_config",
      "invalid_params", "incompatible", "busy", "already_exists"];
    throw new HarnessClientError(code && allowed.includes(code) ? code : "mcp_open_failed",
      "Native harness executable open failed");
  }
}
