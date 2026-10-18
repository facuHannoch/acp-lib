import type { Agent } from "../agent.ts";
import type { AgentConversationId } from "../agent-ids.ts";
import type { ConversationErrorSource, ConversationErrorRecoverability, ConversationErrorDetails, ConversationRecord, NewConversationRecord } from "../persistence/backend.ts";
import type { ManagerSettings } from "./manager-settings.ts";
import { captureRuntimeRecord, enqueueAuditObservation } from "./record-capture.ts";
export async function writeConversationError(agent: Agent, defaults: ManagerSettings, input: {
    /** The conversation's own settings; the Agent's when the record is not about one conversation's start. */
    readonly settings?: ManagerSettings;
    readonly agentConversationId: AgentConversationId;
    readonly attemptId: string;
    readonly source: ConversationErrorSource;
    readonly code: string;
    readonly recoverability: ConversationErrorRecoverability;
    readonly message?: string;
    readonly operationId?: string;
    readonly transitionId?: string;
    readonly internalSessionId?: string;
    readonly details?: ConversationErrorDetails;
  }): Promise<{ readonly record?: ConversationRecord; readonly recordingError?: Error }> {
    const record: NewConversationRecord = {
      recordId: `${input.attemptId}:error`,
      agentSessionId: agent.id,
      agentConversationId: input.agentConversationId,
      kind: "error",
      timestamp: new Date().toISOString(),
      source: input.source,
      code: input.code,
      recoverability: input.recoverability,
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.transitionId === undefined ? {} : { transitionId: input.transitionId }),
      ...(input.internalSessionId === undefined ? {} : { internalSessionId: input.internalSessionId }),
      ...(input.details === undefined ? {} : { details: input.details }),
    };
    const settings = input.settings ?? defaults;
    const level = settings.capture.error;
    const audit = settings.auditLog;
    let persisted: ConversationRecord | undefined;
    try {
      await agent.persistence.transaction(async (persistence) => {
        if (level !== "none") {
          persisted = await persistence.records.append(captureRuntimeRecord(record, level));
        }
        if (audit) {
          await enqueueAuditObservation(persistence, {
            scope: "conversation",
            sourceObservationId: record.recordId,
            ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
            record,
          }, audit);
        }
      });
    } catch (error) {
      return { recordingError: error instanceof Error ? error : new Error(String(error)) };
    }
    if (persisted) agent.publishCommittedRecords([persisted]);
    if (audit) agent.audit?.notifyPending();
    return persisted ? { record: persisted } : {};
}
