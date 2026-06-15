// Subpath barrel: acp-lib/degraded.
//
// PtyClient implements the same AgentClient output contract as AcpClient, but drives an
// interactive CLI in a pty and scrapes the screen back into prompt()/onChunk. It has
// almost no input contract (no capabilities, no sessions, no permission gating). See
// SPEC.md "Degraded mode" + SPEC-multi-agent.md.
//
// The pty is owned by the OS `script` utility (node-pty is unusable under Bun — see
// .res/test.md), driven by the same Bun.spawn pipes the ACP transport uses, so importing
// this subpath pulls in NO native addon.

export { PtyClient } from "./pty-client.ts";
export type { PtyClientOptions } from "./pty-client.ts";
export { PtyTransport } from "./pty-transport.ts";
export type { PtyTransportOptions } from "./pty-transport.ts";
export { EmulatorScreen, compactLines } from "./emulator.ts";
export type { EmulatorOptions } from "./emulator.ts";
export { extractReply } from "./extract.ts";
