/**
 * Adopt an existing provider session as a new conversation: the conversation is created around the session
 * and loaded with `session/load`, instead of starting a new provider thread.
 */
export interface AdoptProviderSessionConfig {
  /** The provider's id for the session to adopt (the `sessionId` `session/list` reports). */
  readonly providerSessionId: string;
  /**
   * Also store the history the load replays, through the normal capture path (so a conversation that does
   * not capture a kind stores none of it). `true` imports all of it; `{ last: n }` the last `n` turns, a turn
   * starting at each user message. Default: the last `DEFAULT_RECAP_TAIL_TURNS` turns when a recap is made,
   * otherwise `false` (the provider still holds the history, and only what happens from now on is stored).
   */
  readonly importHistory?: boolean | { readonly last: number };
  /**
   * Ask the model to summarize its own history, and store the answer as an assistant message (marked as a
   * recap) ahead of the imported turns, so the Agent's other conversations learn about this one: identity
   * delivers stored messages to them. The question is a hidden turn on the adopted session: it is not shown
   * in the conversation, and `create()` returns once it has been answered. The model decides how to compress
   * a long history; the library never summarizes one itself. Default: `true` when the Agent has an identity
   * runtime that shares conversations, otherwise `false`. A failed recap is recorded as an error and the
   * conversation stays usable, but is not in the Agent's memory.
   */
  readonly recap?: boolean;
}

/** Turns stored after a recap when the consumer does not say how much history to import. */
export const DEFAULT_RECAP_TAIL_TURNS = 2;

export interface NormalizedAdoption {
  readonly providerSessionId: string;
  /** `false`, or how much of the replay to store (`last` absent means all of it). */
  readonly importHistory: false | { readonly last?: number };
  readonly recap: boolean;
}

export function normalizeAdoption(
  config: AdoptProviderSessionConfig,
  defaults: { readonly recap: boolean } = { recap: false },
): NormalizedAdoption {
  if (config === null || typeof config !== "object") throw new Error("adopt must be an object");
  const id = config.providerSessionId;
  if (typeof id !== "string" || !id.trim()) throw new Error("adopt.providerSessionId cannot be blank");
  if (config.recap !== undefined && typeof config.recap !== "boolean") throw new Error("adopt.recap must be a boolean");
  const recap = config.recap ?? defaults.recap;
  const history = config.importHistory;
  if (history === undefined) {
    return { providerSessionId: id, recap, importHistory: recap ? { last: DEFAULT_RECAP_TAIL_TURNS } : false };
  }
  if (history === false) return { providerSessionId: id, recap, importHistory: false };
  if (history === true) return { providerSessionId: id, recap, importHistory: {} };
  const last = (history as { last?: unknown }).last;
  if (typeof last !== "number" || !Number.isInteger(last) || last < 1) {
    throw new Error("adopt.importHistory.last must be a positive integer");
  }
  return { providerSessionId: id, recap, importHistory: { last } };
}
