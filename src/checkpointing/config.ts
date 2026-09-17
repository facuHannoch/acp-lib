export interface ConversationCheckpointSchedule {
  /** One-based successful response counts. Defaults to 1, 5, 10, 15, 30, and 50. */
  readonly milestones?: readonly number[];
  /** After the final milestone, generate every N successful responses. Defaults to 50. */
  readonly everyAfterMilestones?: number;
}

export interface ConversationCheckpointingConfig {
  readonly enabled?: boolean;
  readonly schedule?: ConversationCheckpointSchedule;
  readonly summaryInstruction?: string;
  readonly recovery?: ConversationRecoveryConfig;
}

export interface ConversationRecoveryConfig {
  readonly onLoadFailure?: "recover" | "error";
  /** ACP has no standardized missing-session error, so consumers may override detection. */
  readonly isMissingProviderSession?: (error: unknown) => boolean;
  readonly seedInstruction?: string;
  readonly maxTailMessages?: number;
}

export interface ResolvedConversationCheckpointingConfig {
  readonly enabled: boolean;
  readonly milestones: readonly number[];
  readonly everyAfterMilestones: number;
  readonly summaryInstruction: string;
  readonly recovery: ResolvedConversationRecoveryConfig;
}

export interface ResolvedConversationRecoveryConfig {
  readonly onLoadFailure: "recover" | "error";
  readonly isMissingProviderSession?: (error: unknown) => boolean;
  readonly seedInstruction: string;
  readonly maxTailMessages: number;
}

const DEFAULT_MILESTONES = Object.freeze([1, 5, 10, 15, 30, 50]);

export function resolveConversationCheckpointingConfig(
  config: ConversationCheckpointingConfig = {},
): ResolvedConversationCheckpointingConfig {
  const milestones = [...(config.schedule?.milestones ?? DEFAULT_MILESTONES)];
  if (
    milestones.length === 0
    || milestones.some((value) => !Number.isSafeInteger(value) || value < 1)
    || milestones.some((value, index) => index > 0 && value <= milestones[index - 1]!)
  ) throw new Error("checkpoint milestones must be strictly increasing positive integers");
  const everyAfterMilestones = config.schedule?.everyAfterMilestones ?? 50;
  if (!Number.isSafeInteger(everyAfterMilestones) || everyAfterMilestones < 1) {
    throw new Error("checkpoint everyAfterMilestones must be a positive integer");
  }
  const summaryInstruction = config.summaryInstruction?.trim() || [
    "Create a precise continuation summary for another instance of this agent.",
    "Preserve objectives, decisions, important facts, unresolved questions, pending actions,",
    "relevant resources, and the latest conversational state. Do not invent information.",
    "Return only the continuation summary.",
  ].join(" ");
  const maxTailMessages = config.recovery?.maxTailMessages ?? 100;
  if (!Number.isSafeInteger(maxTailMessages) || maxTailMessages < 0 || maxTailMessages > 10_000) {
    throw new Error("checkpoint recovery maxTailMessages must be between 0 and 10000");
  }
  return Object.freeze({
    enabled: config.enabled ?? true,
    milestones: Object.freeze(milestones),
    everyAfterMilestones,
    summaryInstruction,
    recovery: Object.freeze({
      onLoadFailure: config.recovery?.onLoadFailure ?? "recover",
      ...(config.recovery?.isMissingProviderSession
        ? { isMissingProviderSession: config.recovery.isMissingProviderSession }
        : {}),
      seedInstruction: config.recovery?.seedInstruction?.trim() || [
        "Restore the following private continuation context for this conversation.",
        "Do not answer it as a user request. Use it to continue naturally when the next user message arrives.",
      ].join(" "),
      maxTailMessages,
    }),
  });
}

export function isConversationCheckpointDue(
  successfulResponseCount: number,
  config: ResolvedConversationCheckpointingConfig,
): boolean {
  if (!config.enabled || successfulResponseCount < 1) return false;
  if (config.milestones.includes(successfulResponseCount)) return true;
  const last = config.milestones.at(-1)!;
  return successfulResponseCount > last
    && (successfulResponseCount - last) % config.everyAfterMilestones === 0;
}
