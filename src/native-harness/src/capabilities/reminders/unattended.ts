/** Use the same initial take when checking eligibility and charging a turn.
 * Kept outside storage so memory and SQLite apply identical policy. */
export function unattendedAdmission(limit: number | undefined, spent: number, participantInInitialTake: boolean) {
  if (limit === undefined) return { eligible: true, nextSpent: spent };
  if (participantInInitialTake) return { eligible: true, nextSpent: 0 };
  if (spent >= limit) return { eligible: false, nextSpent: spent };
  return { eligible: true, nextSpent: spent + 1 };
}
