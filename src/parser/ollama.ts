// OllamaParser — a ScreenParser backed by a local ollama-served small model.
// DEFERRED / skeleton. Isolated here so degraded mode depends only on the ScreenParser
// interface, never on ollama directly. See SPEC.md "The SML".

import type { ScreenParser, ParseTarget } from "./types.ts";
import type { ActivityEvent, PromptResult } from "../types.ts";

export interface OllamaParserOptions {
  /** ollama model tag, e.g. "qwen2.5:0.5b". */
  model: string;
  /** ollama HTTP endpoint. Default http://127.0.0.1:11434. */
  host?: string;
}

export class OllamaParser implements ScreenParser {
  constructor(private opts: OllamaParserOptions) {}

  async parse(
    _cleanText: string,
    _target: ParseTarget,
  ): Promise<ActivityEvent | PromptResult | null> {
    // TODO: POST to `${host}/api/chat` with a schema-constrained ("format": <json schema>)
    // request so the small model can only emit a valid ActivityEvent / PromptResult.
    throw new Error("OllamaParser.parse is not implemented yet (deferred)");
  }
}
