/** Published byte limit shared by the harness and its local clients. */
export const SESSION_INPUT_MAX_BYTES = 8 * 1024;

export interface IntakeLimit {
  maxTakenTextBytes: number;
  maxTakenItems: number;
}
