export interface ReminderLimits {
  readonly oneShotLeadMs: number;
  readonly repeatIntervalMs: number;
  readonly perChannel: number;
  readonly minGraceMs: number;
  readonly maxGraceMs: number;
}

export const defaultReminderLimits: ReminderLimits = {
  oneShotLeadMs: 120_000,
  repeatIntervalMs: 600_000,
  perChannel: 20,
  minGraceMs: 300_000,
  maxGraceMs: 86_400_000,
};
