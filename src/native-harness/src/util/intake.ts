import { SESSION_INPUT_MAX_BYTES, type IntakeLimit } from "../contracts/input-limits.ts";

/** Default initial take used by the scheduler and routine wake decision. */
export const SESSION_INTAKE_LIMITS: Readonly<IntakeLimit> = {
  maxTakenTextBytes: SESSION_INPUT_MAX_BYTES,
  maxTakenItems: 16,
};
