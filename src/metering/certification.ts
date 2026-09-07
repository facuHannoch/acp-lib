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

/**
 * Certified integrations, in registration order.
 *
 * EMPTY, and that is the honest state. The only harness with an in-process hook exposing
 * per-inference usage is OpenCode — its `event` hook delivers one assistant message per
 * inference, each carrying its own cost and normalized token counts (see
 * smoke-tests/test6-metering/opencode-plugin/). Until that integration exists, ships a
 * verified handshake, and fails closed when the channel drops, nothing can honestly claim
 * billing-grade coverage.
 *
 * The ACP-derived backend cannot be certified at all: measured on OpenCode, a turn with
 * three tool calls billed 3.43x what `PromptResponse.usage` reported, because ACP surfaces
 * one inference per prompt while the provider bills roughly tool-calls + 1.
 */
export const CERTIFIED_INTEGRATIONS: readonly CertificationRequirements[] = Object.freeze([]);

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
  return (
    `billing_required needs a certified metering integration for adapter ` +
    `"${adapterId}" — ${available}. ACP usage alone cannot satisfy it: a prompt reports ` +
    `one inference while a tool-using turn bills several.`
  );
}
