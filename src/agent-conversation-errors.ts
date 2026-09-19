import type { ContinuationReport, PromptBlocker } from "./agent-conversation-contracts.ts";

export class AgentSessionPromptBlockedError extends Error {
  constructor(readonly blockers: readonly PromptBlocker[]) {
    super(`AgentSession cannot mutate while blocked: ${blockers.join(", ")}`);
    this.name = "AgentSessionPromptBlockedError";
  }
}

export class ContinuationUnavailableError extends Error {
  constructor(readonly continuation: ContinuationReport, options?: ErrorOptions) {
    super("recorded internal session could not be loaded", options);
    this.name = "ContinuationUnavailableError";
  }
}

export class AdapterMismatchError extends Error {
  constructor(readonly recordedAdapterId: string, readonly requestedAdapterId: string) {
    super(`adapter mismatch: transcript requires ${recordedAdapterId}, received ${requestedAdapterId}`);
    this.name = "AdapterMismatchError";
  }
}

/** Direct V2 audit creation is deferred until it has the same crash transaction as managed creation. */
export class DirectAuditPersistenceUnsupportedError extends Error {
  constructor() {
    super("direct V2 audit persistence is not supported; use SessionManager.createAgentSession()");
    this.name = "DirectAuditPersistenceUnsupportedError";
  }
}

