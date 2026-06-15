// ScreenParser — the abstraction degraded mode depends on. Pure, ZERO deps.
// Degraded mode never hardcodes ollama; it takes a ScreenParser by injection. ollama is
// just one implementation (./ollama.ts). See SPEC.md "The SML — isolate it".

import type { ActivityEvent, PromptResult } from "../types.ts";

/** What we want extracted from a settled block of clean terminal text. */
export type ParseTarget = "activity" | "result";

export interface ScreenParser {
  /**
   * Turn clean (de-duped, ANSI-free) terminal text into structured output. The parser
   * does NOT interpret or summarize — only parses — so a very small model suffices.
   * Implementations SHOULD constrain decoding to a schema so only valid output is emitted.
   */
  parse(
    cleanText: string,
    target: ParseTarget,
  ): Promise<ActivityEvent | PromptResult | null>;
}
