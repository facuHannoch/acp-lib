import { formatResponseMessages } from "../response.ts";
import type { ConversationRecord, PersistenceJsonValue } from "../persistence/backend.ts";
import type {
  InternalInferenceCompletion,
  InternalInferenceStrategy,
} from "../internal-inference/contracts.ts";
import { createConversationRecoveryCheckpointId } from "./ids.ts";

export const CONVERSATION_CHECKPOINT_STRATEGY_ID = "conversation-checkpoint-v1";

const CHECKPOINT_READ_ONLY_INSTRUCTION = [
  "Do not execute commands, use tools, inspect files, or modify the environment.",
  "Only summarize the records supplied in this prompt.",
].join(" ");

export type ConversationCheckpointPayload = {
  readonly instruction: string;
};

export class ConversationCheckpointStrategy
implements InternalInferenceStrategy<ConversationCheckpointPayload> {
  readonly strategyId = CONVERSATION_CHECKPOINT_STRATEGY_ID;
  readonly purpose = "conversation_checkpoint" as const;
  readonly version = 1;

  validatePayload(payload: PersistenceJsonValue): ConversationCheckpointPayload {
    const instruction = (payload as { instruction?: unknown })?.instruction;
    if (typeof instruction !== "string" || !instruction.trim()) {
      throw new Error("conversation checkpoint instruction is required");
    }
    return Object.freeze({ instruction: instruction.trim() });
  }

  async prepare(context: Parameters<InternalInferenceStrategy<ConversationCheckpointPayload>["prepare"]>[0], payload: ConversationCheckpointPayload) {
    const conversationId = context.attempt.agentConversationId;
    const through = context.attempt.sourceThroughSequence;
    if (!conversationId || through === undefined) {
      throw new Error("conversation checkpoint requires a conversation and source coverage");
    }
    const repository = context.persistence.recoveryCheckpoints;
    if (!repository) throw new Error("persistence does not support recovery checkpoints");
    const previous = await repository.latest(conversationId);
    if ((previous?.checkpointId ?? undefined) !== context.attempt.sourceCheckpointId) {
      throw new Error("conversation checkpoint source changed before preparation");
    }
    const from = previous?.coveredSequence ?? 0;
    if (through <= from) throw new Error("conversation checkpoint source range is empty");
    const records = await readRecords(context.persistence.records, conversationId, from, through);
    if (!records.length) throw new Error("conversation checkpoint source contains no records");
    return Object.freeze({
      prompt: [
        payload.instruction,
        CHECKPOINT_READ_ONLY_INSTRUCTION,
        previous
          ? `Previous continuation summary:\n${previous.summary}`
          : "There is no previous continuation summary.",
        `New canonical records after sequence ${from} through ${through}:`,
        JSON.stringify(records),
      ].join("\n\n"),
      metadata: JSON.stringify({ previousCheckpointId: previous?.checkpointId ?? null, through }),
    });
  }

  async complete(context: Parameters<InternalInferenceStrategy<ConversationCheckpointPayload>["complete"]>[0], result: Parameters<InternalInferenceStrategy<ConversationCheckpointPayload>["complete"]>[1]): Promise<InternalInferenceCompletion> {
    const conversationId = context.attempt.agentConversationId;
    const through = context.attempt.sourceThroughSequence;
    if (!conversationId || through === undefined) throw new Error("checkpoint completion lacks source scope");
    const repository = context.persistence.recoveryCheckpoints;
    if (!repository) throw new Error("persistence does not support recovery checkpoints");
    const summary = formatResponseMessages(result.messages, "\n\n").trim();
    if (!summary) throw new Error("checkpoint inference returned an empty summary");
    const checkpoint = await repository.publish({
      checkpointId: createConversationRecoveryCheckpointId(),
      agentConversationId: conversationId,
      coveredSequence: through,
      ...(context.attempt.sourceCheckpointId
        ? { previousCheckpointId: context.attempt.sourceCheckpointId as `chk-${string}` }
        : {}),
      generatorInternalInferenceId: result.internalInferenceId,
      summary,
    });
    const appended = await context.persistence.records.append({
      recordId: `${result.internalInferenceId}:checkpoint`,
      agentSessionId: context.attempt.agentSessionId,
      agentConversationId: conversationId,
      kind: "native_action",
      timestamp: checkpoint.createdAt,
      action: "conversation_checkpoint",
      state: "completed",
      output: {
        internalInferenceId: result.internalInferenceId,
        checkpointId: checkpoint.checkpointId,
        coveredSequence: checkpoint.coveredSequence,
      },
    });
    // Hand the committed record to the manager so it reaches the Agent's live bus after
    // the completion transaction commits, exactly like every other Agent-owned record.
    context.onRecordAppended?.(appended);
    return Object.freeze({
      internalInferenceId: result.internalInferenceId,
      rootInternalInferenceId: context.attempt.rootId,
      internalSessionId: result.internalSessionId,
      purpose: context.attempt.purpose,
      artifactId: checkpoint.checkpointId,
      completedAt: new Date().toISOString(),
      metadata: JSON.stringify({ coveredSequence: checkpoint.coveredSequence }),
    });
  }

  classifyError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("source changed") || message.includes("coverage") || message.includes("source range")) {
      return { kind: "terminal" as const, code: "checkpoint_source_conflict" };
    }
    if (message.includes("empty summary") || message.includes("no records")) {
      return { kind: "terminal" as const, code: "invalid_checkpoint_result" };
    }
    return { kind: "retryable" as const, code: "checkpoint_inference_failed" };
  }
}

async function readRecords(
  repository: Parameters<InternalInferenceStrategy["prepare"]>[0]["persistence"]["records"],
  conversationId: Parameters<typeof repository.list>[0],
  afterSequence: number,
  throughSequence: number,
): Promise<readonly ConversationRecord[]> {
  const records: ConversationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(conversationId, {
      afterSequence,
      throughSequence,
      kinds: ["message"],
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    records.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor);
  return Object.freeze(records);
}
