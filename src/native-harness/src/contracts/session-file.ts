/** Portable configuration understood by the scripted protocol server. The
 * script is a destination-side file reference, retained verbatim; it is not
 * embedded or required to exist during import. */
export interface PortableSessionConfig {
  version: 1;
  limits?: import("./config-permissions.ts").ManagedConfig["limits"];
  mcpServers?: Record<string, import("./mcp.ts").McpServer>;
  system: string;
  model: import("./config-permissions.ts").ManagedModel;
  /** Present on session files produced after decision 0016. */
  defaultPolicy?: string;
  policies?: Record<string, import("./config-permissions.ts").ToolPolicy>;
}

/** File version 1 CBOR payload. `archive` is a supported logical archive;
 * defined here generically so this contract module imports nothing. Both fields
 * are validated before atomic publication (decision 0015). */
export interface SessionFilePayload<Archive> {
  archive: Archive;
  config: PortableSessionConfig;
}
