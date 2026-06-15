// Subpath barrel: acp-lib/degraded. DEFERRED.
//
// PtyClient implements the same AgentClient output contract as AcpClient, but drives a
// native interactive CLI in a PTY and parses the screen back into events. It has almost
// no input contract (no capabilities, no sessions, no permission gating). See SPEC.md
// "Degraded mode" + SPEC-multi-agent.md.
//
// Heavy deps (node-pty, the vt emulator) are dynamically imported inside the
// implementation so merely importing this subpath stays cheap and install-safe.

export { PtyClient } from "./pty-client.ts";
export type { PtyClientOptions } from "./pty-client.ts";
