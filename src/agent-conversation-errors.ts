import type { AgentConversationId, AgentSessionId } from "./agent-ids.ts";
import type {
  ConversationErrorRecoverability,
  ConversationErrorSource,
} from "./persistence/backend.ts";
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

export interface ProviderSessionErrorDetails {
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  /** Stable identity of the failed open invocation; `${attemptId}:error` is its record id. */
  readonly attemptId: string;
  readonly internalSessionId?: string;
  readonly code: string;
  readonly source: ConversationErrorSource;
  readonly recoverability: ConversationErrorRecoverability;
  /** Present only when canonical capture accepted the durable error record. */
  readonly recordId?: string;
  /** Set when writing the durable record also failed; the provider cause stays primary. */
  readonly recordingError?: Error;
  /** Safe display fallback; the durable record carries the same text. */
  readonly message?: string;
  readonly cause?: unknown;
}

/**
 * A provider session could not be created or loaded, and the operation could not return a
 * live conversation. The immediate exception and the durable error record share the same
 * code, attempt id, and recoverability; the record id is present only when canonical capture
 * accepted the row.
 */
export class ProviderSessionError extends Error {
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId: AgentConversationId;
  readonly attemptId: string;
  readonly internalSessionId?: string;
  readonly code: string;
  readonly source: ConversationErrorSource;
  readonly recoverability: ConversationErrorRecoverability;
  readonly recordId?: string;
  readonly recordingError?: Error;

  constructor(details: ProviderSessionErrorDetails) {
    super(details.message ?? "The provider session could not be loaded.", { cause: details.cause });
    this.name = "ProviderSessionError";
    this.agentSessionId = details.agentSessionId;
    this.agentConversationId = details.agentConversationId;
    this.attemptId = details.attemptId;
    if (details.internalSessionId !== undefined) this.internalSessionId = details.internalSessionId;
    this.code = details.code;
    this.source = details.source;
    this.recoverability = details.recoverability;
    if (details.recordId !== undefined) this.recordId = details.recordId;
    if (details.recordingError !== undefined) this.recordingError = details.recordingError;
  }
}


/**
 * A provider session cannot be adopted because a conversation already owns it (or has asked to adopt it).
 * `ownedBy` names the conversation(s), so a consumer can open the existing one instead.
 */
export class ProviderSessionInUseError extends Error {
  readonly code = "provider_session_in_use";
  constructor(
    readonly providerSessionId: string,
    readonly ownedBy: readonly AgentConversationId[],
  ) {
    super(`provider session ${providerSessionId} is already used by conversation ${ownedBy.join(", ")}`);
    this.name = "ProviderSessionInUseError";
  }
}

/** The agent does not advertise `session/list`, so its sessions cannot be listed. */
export class ProviderSessionListUnsupportedError extends Error {
  readonly code = "provider_session_list_unsupported";
  constructor(readonly adapterId: string) {
    super(`adapter ${adapterId} does not advertise session/list, so its sessions cannot be listed`);
    this.name = "ProviderSessionListUnsupportedError";
  }
}
