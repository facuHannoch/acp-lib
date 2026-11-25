# Process-bound native inference relay grants

**Status** — Contract draft based on D63 and D64 and the supplied
`NATIVE-INFERENCE.md` and relay amendment brief. Extends
[trusted inference relay](../0005-AMENDMENT-trusted-http-inference/SPEC.md).
Scope is ACP-client and its native harness. The embedding platform owns
grant issuance, abandonment, revocation, and gateway accounting.

## Grant provider and wire shape

Keep the existing `harness.inferenceRelayGrant({ sessionId, signal })`
provider. Its result contains `baseUrl`, `bearerToken`, and exactly one
lifetime declaration:

```ts
type RuntimeRelayGrant = {
  baseUrl: string;
  bearerToken: string;
} & (
  | { lifetime: { mode: "process" }; expiresAtMs?: never }
  | { expiresAtMs: number; lifetime?: never }
);

type InferenceRelayGrantProviderResult = RuntimeRelayGrant & {
  grantRef?: string;
};
```

ACP-client and the harness reject both lifetimes or neither. A process
lifetime is exactly `{ mode: "process" }`. Use the existing validation
and dispatch expiry checks for numeric grants. A process-bound grant
has no numeric expiry, refresh callback, or clock timer. It is usable
until it is replaced, the harness process ends, or a recognized relay
refusal revokes it. Executable create and reopen still acquire a grant
from the host. The harness checks the exact endpoint and credential
mode under the existing relay contract.

`grantRef` is optional and opaque. ACP-client retains it solely to
correlate the host's failed-open cleanup. Construct the native control
request from the wire fields explicitly. Keep the reference out of
stdio, storage, archives and diagnostics. Keep both lifetime variants
and the bearer runtime-only. Existing providers returning a numeric
expiry and no reference keep working and receive no cleanup callback.
A process-bound grant requires a harness that supports this shape.
An unsupported harness rejects executable open. ACP-client never
substitutes an expiry.

## Relay refusal and request identity

Use the fixed HTTP status and JSON `error.type` pairs from
`agents-node-protocol/NATIVE-INFERENCE.md` at agents commit
`921ba2e11950d7da8a77444bb4f32b7e90c69183`. The harness interprets
them only on the bound relay route. Parse a bounded response body and
report fixed diagnostics.

| HTTP | `error.type` |
| --- | --- |
| 401 | `native_grant_revoked` |
| 401 | `native_authentication_required` |
| 403 | `native_source_rejected` |
| 403 | `native_admission_rejected` |
| 403 | `native_policy_mismatch` |
| 429 | `native_allowance_exhausted` |
| 502 | `native_provider_authentication_failed` |
| 502 | `native_provider_model_failed` |
| 503 | `native_unavailable` |

Capture the current grant identity and existing model attempt identity
at dispatch. Only the exact 401 and `native_grant_revoked` pair revokes
authority. Fail the affected inference with a fixed revocation
diagnostic. Invalidate the captured grant only if it is still the
current grant when the response is handled. A late refusal fails its
original inference and leaves any replacement usable. Later dispatches
with a revoked current grant fail before sending anything. An
executable open with fresh authority can run later inference.

All other pairs, status mismatches, malformed bodies, and transport
failures leave the grant's revocation state unchanged. Never replay an
inference automatically once the request may have been accepted.
This applies to ambiguous `native_unavailable` failures and lost
responses, even when no stream frame arrived. Preserve the original
attempt's identity and normal settlement. The platform owns relay
response authenticity and durable accounting.

## Failed executable-open cleanup

Expose `harness.onInferenceRelayOpenFailure({ grantRef, delivery })`
for executable create and reopen. When configured, call it if an issued grant with a
reference belongs to an open attempt that fails or is cancelled,
including cancellation after the provider resolves. Correlate cleanup
with the original issuance, process and session. A provider whose
result never reached ACP-client remains responsible for that issuance.

- `not_sent` requires proof that the grant never reached the harness
  transport. Mark delivery as potentially sent before the first
  operation that could enqueue or write any part of the grant.
- `unknown` covers any possible handoff, including partial writes,
  timeouts, lost responses, cancellation and a rejection after
  possible delivery. Use it whenever evidence is ambiguous.

Await the cleanup hook before completing the failed open or starting
another issuance. Cleanup runs under its own deadline, independent of
the open's cancellation. Configure it using the host-only
`harness.inferenceRelayCleanupMs`, with a default of 10,000 ms.
Accept a positive integer that fits the runtime timer range. A resolved
hook acknowledges cleanup and preserves the original open failure.
Hook rejection or deadline expiry surfaces the fixed, matchable
`relay_cleanup_unconfirmed` code. This outcome stops automatic
executable-open retries. The host decides how to fence the process
before requesting new authority. A late cleanup completion cannot
acknowledge a later grant. Keep the reference, bearer and raw callback
errors out of all diagnostics.

## Acceptance

1. Verify process-bound grants on native create and reopen, including
   operation after advancing the wall clock. Verify numeric expiry
   compatibility, both invalid lifetime combinations, and archive
   and logging canaries for the bearer and host reference.
2. Test every fixed status and type pair. Test a mismatched revocation
   pair, malformed responses, transport failure and a lost response.
   Prove that only the captured current grant is invalidated, a late
   refusal leaves a replacement usable, and no possibly accepted
   inference is replayed.
3. Exercise failed create and reopen with cancellation after the
   provider resolves, a partial write, a lost reply, and a rejection
   after possible handoff. Check the original reference and delivery
   classification for each case. Assert that the reference never
   reaches the harness.
4. Verify cleanup succeeds after the open is cancelled. Verify the
   default and overridden deadline, rejected or timed-out cleanup,
   the fixed code, and zero new issuance on unconfirmed cleanup.
   Preserve settlement of an admitted stream and legacy providers
   without a reference. Run both typechecks and the native regression
   suites.

See the [implementation plan](PLAN.md).
