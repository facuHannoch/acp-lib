/**
 * The narrow context `runTurn` receives from `AgentSession` (controller-interface spec, Brief A2
 * step 1). It names exactly what the turn path reads and changes in the session, grouped as the
 * spec lists them, instead of passing the session itself. Members that the session can replace
 * while it lives (the controller, the transcript runtime, the attachment state, ...) are getters,
 * so the turn reads them at the same moments it did when it was a session method.
 */
import type { AggregatedRecord } from "../activity.ts";
import type { AgentConversationOwnerLifecycle } from "../agent-conversation-owner.ts";
import type { AgentConversationPresentation } from "../agent-conversation-presentation.ts";
import type { AgentConversationId, AgentSessionId } from "../agent-ids.ts";
import type { AgentController } from "../controller.ts";
import type { Logger } from "../logger.ts";
import type { ResolvedPart } from "../media/parts.ts";
import type { OpenOperation } from "../metering/engine.ts";
import type { SupervisedProvider } from "../operations/contracts.ts";
import type { MeteredOperationKind, OperationMeteringRecord } from "../metering/record.ts";
import type { NewConversationRecord, ParticipantRef } from "../persistence/backend.ts";
import type { ProviderAttachmentState } from "../persistence/provider-attachment.ts";
import type { PersistenceStateRuntime } from "../persistence/state-runtime.ts";
import type { SteeringController } from "../steering/controller.ts";
import type { SteeringPrompt } from "../steering/contracts.ts";
import type { TranscriptLine } from "../transcript.ts";
import type { PromptHandlers, PromptResult, TokenUsage } from "../types.ts";

/** A queued prompt operation: one message, or a combined steer run. */
export interface PromptQueueItem extends SteeringPrompt {
  /** How this operation is classified in its metering record. */
  operationKind: MeteredOperationKind;
}

export interface TurnRunContext {
  readonly log: Logger;

  /** The provider controller (replaced by handoffs and mode switches). */
  readonly controller: AgentController;
  /** Runs one provider call under the operation supervisor, with the stall limits of `kind`. */
  supervisedPrompt(
    controller: AgentController,
    operationId: string,
    kind: "turn",
    provider: SupervisedProvider,
  ): Promise<PromptResult>;
  /** Whether an operation supervisor is attached (it then routes activity to steering itself). */
  readonly supervising: boolean;

  readonly persistence: {
    /** Managed mode's v2 transcript runtime, or null. */
    readonly v2Transcript: PersistenceStateRuntime | null;
    /** Detached mode's legacy JSONL transcript. */
    appendTranscript(line: TranscriptLine): Promise<void>;
    persist(): Promise<void>;
    finishV2Prompt(
      status: PromptResult["status"],
      record: OperationMeteringRecord,
      errorCode?: "unknown",
    ): Promise<void>;
  };

  readonly presentation: AgentConversationPresentation;

  readonly metering: {
    open(item: PromptQueueItem): Promise<OpenOperation>;
    close(
      operation: OpenOperation,
      outcome: "completed" | "cancelled" | "error",
      reportedCumulative: TokenUsage | null,
      usageFailureReason?: string,
    ): Promise<OperationMeteringRecord>;
  };

  readonly steering: Pick<SteeringController<{ readonly kind: string }>, "observeActivity" | "resultFields">;

  readonly owner: {
    /** Set for conversations of an `Agent` (Agent-owned mode). */
    readonly lifecycle: AgentConversationOwnerLifecycle | undefined;
    readonly agentSessionId: AgentSessionId | null;
    readonly agentConversationId: AgentConversationId;
    /** A stable stand-in for the provider context before one exists, minted once per session. */
    contextNonce(): string;
    queueRecord(record: NewConversationRecord, parts?: readonly ResolvedPart[]): void;
    recordNow(record: NewConversationRecord): Promise<void>;
    /** The tail of the owned-record write chain (reassigned by every queued write). */
    readonly recordWrite: Promise<void>;
  };

  readonly turn: {
    begin(turnId: string): void;
    end(turnId: string, handlers?: PromptHandlers): void;
    queueActivityRecords(turnId: string, records: readonly AggregatedRecord[]): void;
  };

  /** Session state the turn reads or updates. */
  readonly session: {
    readonly cwd: string | undefined;
    readonly defaultPermission: "approve" | "cancel";
    readonly internalSessionId: string | null;
    setInternalSessionId(next: string | null): void;
    title: string | undefined;
    /** Adds a participant the conversation does not know yet. */
    learnParticipant(participant: ParticipantRef): void;
    providerAttachment: ProviderAttachmentState;
    installProviderAttachment(
      internalSessionId: string,
      kind: "runtime_only" | "recorded",
      created: boolean,
      options?: { readonly acquiredAt?: string; readonly transitionId?: string },
    ): void;
    lastRecordedInternalSessionId: string | null;
  };
}
