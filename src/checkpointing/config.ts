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
}

export interface ResolvedConversationCheckpointingConfig {
  readonly enabled: boolean;
  readonly milestones: readonly number[];
  readonly everyAfterMilestones: number;
  readonly summaryInstruction: string;
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
  return Object.freeze({
    enabled: config.enabled ?? true,
    milestones: Object.freeze(milestones),
    everyAfterMilestones,
    summaryInstruction,
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
