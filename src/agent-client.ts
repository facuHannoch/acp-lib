// AgentClient — the shared OUTPUT contract. This interface IS the "same output
// contract" from SPEC.md made structural: both AcpClient (core) and PtyClient
// (degraded, deferred) implement it, so a caller's rendering code targets this and
// works in either mode.
//
// The rich INPUT surfaces (capabilities, configOptions, sessions, authenticate) live
// ONLY on AcpClient — they don't exist on this interface because they genuinely don't
// exist in degraded mode.

import type { PromptResult, PromptHandlers, Attachment } from "./types.ts";

export interface InterruptOptions {
  /** Also drop any queued prompts, not just the in-flight one. */
  clearQueue?: boolean;
}

export interface BridgeOptions {
  /** Input stream to read keystrokes from. Default process.stdin. */
  input?: NodeJS.ReadStream;
  /** Output stream to write raw pty bytes to. Default process.stdout. */
  output?: NodeJS.WritableStream;
  /** Bytes that end the bridge and return control. Default [0x1d Ctrl-], 0x03 Ctrl-C]. */
  exitBytes?: number[];
  /** Chrome/status messages (the bridge banner). Default → process.stderr. */
  onStatus?: (msg: string) => void;
}

/**
 * A client whose underlying terminal can be handed directly to the user (degraded/pty
 * only). The user drives the real CLI; we relay bytes both ways until an exit chord.
 * Use for tty-auth (login) and as an escape hatch when scraping can't read a TUI.
 */
export interface Bridgeable {
  bridge(options?: BridgeOptions): Promise<void>;
}

export interface AgentClient {
  /** Send a prompt and resolve with the turn result. The main entry point. */
  prompt(
    text: string,
    handlers?: PromptHandlers,
    attachments?: Attachment[],
  ): Promise<PromptResult>;

  /** Cancel the in-flight prompt; the pending prompt() resolves with status "cancelled". */
  interrupt(options?: InterruptOptions): void;

  /** Tear down the underlying process/transport. */
  stop(): Promise<void>;
}
