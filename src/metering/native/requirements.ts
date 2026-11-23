import { MeteringPreflightError, type MeteringEnforcement } from "../record.ts";

/** The current ledger lacks the sealed accounting and provider evidence required for certification. */
export function requireNativeMeteringCapability(enforcement: MeteringEnforcement | undefined): void {
  if (enforcement === "billing_required") {
    throw new MeteringPreflightError(
      "billing_required for the native adapter kind requires the native-harness@1 sealed per-turn accounting capability",
    );
  }
}
