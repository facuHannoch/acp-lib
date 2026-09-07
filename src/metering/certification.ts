// Which integrations may satisfy `billing_required`. See §12.
//
// This registry is LIBRARY-OWNED and deliberately not reachable from consumer
// configuration. §9 requires provenance to describe evidence rather than configuration: a
// consumer that could set a `billingApproved` flag on its own adapter object would be
// asserting the very thing the mode exists to verify.
//
// Certification is also not a property of an adapter. "OpenCode" is not approvable;
// "OpenCode 1.18.x, with the metering plugin handshake succeeding, on this provider route"
// is. A boolean cannot express a version range or a runtime check, and a stale `true`
// after a harness upgrade is worse than no gate at all.

/** What a certified integration must establish before billing-grade metering is allowed. */
export interface CertificationRequirements {
  /** Stable id engraved into every record the integration produces. */
  readonly certificationId: string;
  /** The adapter this certification applies to. */
  readonly adapterId: string;
  /** Harness versions the integration has actually been tested against. */
  readonly supportedHarnessVersions: readonly string[];
  /** What the integration observes that ACP alone cannot. */
  readonly description: string;
}

/** The OpenCode plugin integration. See src/metering/opencode/. */
export const OPENCODE_PLUGIN_CERTIFICATION: CertificationRequirements = Object.freeze({
  certificationId: "opencode-plugin@1",
  adapterId: "opencode",
  // Verified against 1.18.29. The plugin API is not stable across majors — 1.18's hooks
  // differ from those the v2 docs describe — so the range is what was actually exercised.
  supportedHarnessVersions: Object.freeze(["1.18"]),
  description:
    "An OpenCode plugin on the `event` hook observes one assistant message per model " +
    "inference, each carrying its own cost and normalized token counts. This recovers " +
    "the inferences ACP hides: a tool-using turn runs several while PromptResponse.usage " +
    "reports one.",
});

/**
 * Certified integrations, in registration order.
 *
 * An entry here means the mechanism has been measured end to end, not that it is
 * configured. `billing_required` additionally requires a live `InferenceSource` presenting
 * the matching certificationId, so a registry entry alone opens nothing.
 *
 * The ACP-derived backend can never appear here: measured on OpenCode, a turn with three
 * tool calls billed 3.43x what `PromptResponse.usage` reported.
 */
export const CERTIFIED_INTEGRATIONS: readonly CertificationRequirements[] = Object.freeze([
  OPENCODE_PLUGIN_CERTIFICATION,
]);

/** The certification for an adapter, or null when none is registered. */
export function certificationFor(adapterId: string): CertificationRequirements | null {
  return CERTIFIED_INTEGRATIONS.find((entry) => entry.adapterId === adapterId) ?? null;
}

/**
 * Why `billing_required` is refused for an adapter.
 *
 * Names the adapter and what is registered, so the failure is actionable rather than a
 * flat "unsupported".
 */
export function billingRefusalReason(adapterId: string): string {
  const registered = CERTIFIED_INTEGRATIONS.map((entry) => entry.adapterId);
  const available =
    registered.length === 0
      ? "no integrations are certified yet"
      : `certified adapters: ${registered.join(", ")}`;
  const known = certificationFor(adapterId);
  if (known) {
    // The adapter CAN be certified; what is missing is the live channel.
    return (
      `billing_required for adapter "${adapterId}" needs a live ${known.certificationId} ` +
      `metering channel. Start one with createOpencodeMetering() and pass its ` +
      `inferenceSource, so measurement comes from observed inferences rather than from ` +
      `ACP usage, which reports one inference per prompt while a tool-using turn bills ` +
      `several.`
    );
  }
  return (
    `billing_required needs a certified metering integration for adapter ` +
    `"${adapterId}" — ${available}. ACP usage alone cannot satisfy it: a prompt reports ` +
    `one inference while a tool-using turn bills several.`
  );
}
