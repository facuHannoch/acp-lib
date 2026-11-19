/** Portable configuration understood by the scripted protocol server. The
 * script is a destination-side file reference, retained verbatim; it is not
 * embedded or required to exist during import. */
export interface PortableSessionConfig {
  version: 1;
  system: string;
  model: { protocol: "scripted"; script: string };
  /** Present on session files produced after decision 0016. */
  defaultPolicy?: string;
  policies?: Record<string, import("./config-permissions.ts").ToolPolicy>;
}

/** File version 1 CBOR payload. `archive` is the revision-2 logical archive;
 * defined here generically so this contract module imports nothing. Both fields
 * are validated before atomic publication (decision 0015). */
export interface SessionFilePayload<Archive> {
  archive: Archive;
  config: PortableSessionConfig;
}
