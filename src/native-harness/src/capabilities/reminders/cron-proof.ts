import { cronCivilCalendar } from "./cron-calendar.ts";
import { parseRoutineCron } from "./cron-fields.ts";
import { zonedCalendar, type ZoneTransition } from "./cron-zone.ts";

const PROOF_BUDGET_MS = 250;
class ProofBudget extends Error {}

export interface ProofZoneRange {
  start: number;
  end: number;
  initialOffset: number;
  transitions: readonly ZoneTransition[];
}

/** Prove the supplied versioned zone span. The caller supplies historical
 * transitions and a complete future cycle with boundary pairs. */
export function proveRoutineCron(expression: string, zone: ProofZoneRange, now = () => performance.now()) {
  const deadline = now() + PROOF_BUDGET_MS;
  const check = () => { if (now() >= deadline) throw new ProofBudget(); };
  try {
    const fields = parseRoutineCron(expression, check);
    if (!fields) return { kind: "invalid_schedule" } as const;
    const civil = cronCivilCalendar(fields, check);
    if (!civil) return { kind: "invalid_schedule" } as const;
    const calendar = zonedCalendar(civil, zone.start, zone.end, zone.initialOffset, zone.transitions, check);
    check();
    return calendar ? { kind: "valid", calendar } as const : { kind: "invalid_schedule" } as const;
  } catch (error) {
    if (error instanceof ProofBudget) return { kind: "proof_budget" } as const;
    throw error;
  }
}
