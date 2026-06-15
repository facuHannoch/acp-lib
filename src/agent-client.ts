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
