// PtyClient — degraded-mode AgentClient. DEFERRED / skeleton.
//
// Pipeline (SPEC.md "The parsing pipeline"):
//   PTY raw bytes → terminal emulator (screen grid) → frame de-dup (settle) →
//   ScreenParser (SML) → ActivityEvent / PromptResult
//
// node-pty is dynamically imported (optional dependency) so the core never pulls a
// native addon.

import type { AgentClient, InterruptOptions } from "../agent-client.ts";
import type { Adapter } from "../adapters.ts";
import type { ScreenParser } from "../parser/types.ts";
import type { PromptResult, PromptHandlers, Attachment } from "../types.ts";

export interface PtyClientOptions {
  adapter: Adapter;
  execPrefix?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Injected SML/heuristic parser. The PtyClient never hardcodes a backend. */
  parser: ScreenParser;
  /** ms of screen stability that counts as "settled" / turn complete. */
  settleMs?: number;
}

export class PtyClient implements AgentClient {
  constructor(private opts: PtyClientOptions) {}

  async prompt(
    _text: string,
    _handlers?: PromptHandlers,
    _attachments?: Attachment[],
  ): Promise<PromptResult> {
    throw new Error("PtyClient is not implemented yet (deferred)");
  }

  interrupt(_options?: InterruptOptions): void {
    throw new Error("PtyClient is not implemented yet (deferred)");
  }

  async stop(): Promise<void> {
    /* no-op until implemented */
  }

  // --- PTY-only surface (not on AgentClient) ------------------------------------

  /** Pull: the current screen grid as text. */
  readScreen(): string {
    throw new Error("PtyClient.readScreen is not implemented yet (deferred)");
  }

  /** Escape hatch: send raw keys (ESC, slash commands, arrows) into the PTY. */
  sendKeys(_raw: string): void {
    throw new Error("PtyClient.sendKeys is not implemented yet (deferred)");
  }
}
