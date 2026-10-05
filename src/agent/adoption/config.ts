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
   * starting at each user message. Default `false`: the provider still holds the history, and only what
   * happens from now on is stored.
   */
  readonly importHistory?: boolean | { readonly last: number };
}

export interface NormalizedAdoption {
  readonly providerSessionId: string;
  /** `false`, or how much of the replay to store (`last` absent means all of it). */
  readonly importHistory: false | { readonly last?: number };
}

export function normalizeAdoption(config: AdoptProviderSessionConfig): NormalizedAdoption {
  if (config === null || typeof config !== "object") throw new Error("adopt must be an object");
  const id = config.providerSessionId;
  if (typeof id !== "string" || !id.trim()) throw new Error("adopt.providerSessionId cannot be blank");
  const history = config.importHistory;
  if (history === undefined || history === false) return { providerSessionId: id, importHistory: false };
  if (history === true) return { providerSessionId: id, importHistory: {} };
  const last = (history as { last?: unknown }).last;
  if (typeof last !== "number" || !Number.isInteger(last) || last < 1) {
    throw new Error("adopt.importHistory.last must be a positive integer");
  }
  return { providerSessionId: id, importHistory: { last } };
}
