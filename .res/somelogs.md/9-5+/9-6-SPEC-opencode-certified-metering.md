# OpenCode certified metering specification

Status: proposed design; implementation pending an OpenCode compatibility spike.

This document defines the first billing-required metering backend for `acp-lib`. It is a
specialized, managed integration with a pinned OpenCode build. ACP remains the control
and conversation protocol; a bundled OpenCode plugin supplies per-inference metering and
attribution through a private side channel.

This specification extends `9-6-SPEC-metering.md`. The shared money, pricing,
`AgentSession`, operation-record, notification, persistence, and reconciliation contracts
remain applicable unless this document explicitly strengthens them.

The goal is not to claim equality with a provider invoice. The goal is a deterministic,
auditable charge under an engraved schedule, backed by a source-inspected and tested
model-call path.

---

## 1. Design decision

Billing-required metering is initially supported only for certified OpenCode routes.
Arbitrary ACP harnesses continue to use derived best-effort or telemetry-required
metering.

The first intended certification is:

```text
pinned OpenCode build
+ pinned acp-lib metering plugin
+ OpenCode ACP transport
+ OpenCode AI SDK runtime path
+ Anthropic provider
+ Anthropic Messages API route
+ consumer-supplied API-key authentication
+ pinned models.dev pricing snapshot
```

Support is extended one provider route at a time. “OpenCode supports a provider” does not
mean that route is automatically certified for billing-required use.

---

## 2. Why OpenCode is a separate backend

ACP usage cannot provide a billing-grade contract because:

- Usage is optional and experimental.
- ACP exposes no capability indicating whether usage will be reported.
- SDK documentation is ambiguous between per-turn and cumulative counters.
- One ACP prompt can hide tool continuations, retries, compaction, title generation,
  subagents, and other model calls.
- An absent ACP report cannot distinguish no usage from missing telemetry.

A pinned OpenCode build is inspectable. Its session hooks can observe model-call and
native HTTP paths and classify calls such as primary generation, compaction, title, and
transient generation. Source inspection, artifact pinning, fixtures, and live route tests
can establish a bounded certification claim that is unavailable for an opaque harness.

The plugin is not trusted merely because it loaded. The library recognizes only exact
certification tuples produced and tested as described below.

---

## 3. Architecture

```text
Consumer
   |
   v
AgentSession operation queue
   |
   | ACP: prompt, stream, permission, cancel, session lifecycle
   v
Managed OpenCode process
   |
   +-- bundled metering plugin
   |      |
   |      `-- authenticated loopback/IPC metering channel
   |
   `-- OpenCode provider runtime
          |
          `-- provider API
```

ACP remains authoritative for agent interaction. The plugin side channel is
authoritative only for the certified metering evidence it reports. The models.dev
snapshot supplies deterministic price schedules. Provider invoices and billing APIs
remain external reconciliation authorities.

The existing generic adapter remains available:

```ts
openCode()
```

It launches ordinary user-configured OpenCode and does not imply certification. The new
mode is explicit:

```ts
managedOpenCode({
  metering: {
    enforcement: "billing_required",
  },
});
```

The managed integration may share lower-level ACP transport code with the generic
adapter, but it has a stronger launch, configuration, identity, and shutdown contract.

---

## 4. Evidence and provenance

Every certified record uses the shared provenance axes:

```ts
export interface MeteringProvenance {
  readonly source: "certified" | "acp_usage" | "none";
  readonly measurement:
    | "provider_normalized"
    | "acp_derived"
    | "unavailable";
  readonly routing: "observed" | "unknown";
  readonly attribution: "complete" | "partial" | "unavailable";
  readonly counterInterpretation?: "cumulative" | "per_turn";
  readonly certificationId?: string;
}
```

For the certified backend:

- `source` is `certified`; `certificationId` identifies the OpenCode integration without
  coupling the shared source enum to one harness.
- `measurement` is `provider_normalized`: OpenCode normalized usage originating in the
  provider response path. It is not named invoice usage.
- `routing` is `observed`: the plugin observed the inspected OpenCode model-call path.
  The library does not assert OS-level network isolation.
- `attribution` is `complete` only when every observed inference in the relevant scope is
  assigned to the operation or to a separately recorded auxiliary/unallocated record.
- `certificationId` resolves to a library-owned immutable certification manifest.

Consumers cannot construct or promote certified provenance. The public configuration
does not accept `certificationId`, `measurement`, or `attribution` overrides.

---

## 5. Certification identity

A certification is narrower than OpenCode version plus provider name:

```ts
export interface OpenCodeMeteringCertification {
  readonly id: string;

  readonly openCodeVersion: string;
  readonly openCodeArtifactSha256: string;
  readonly pluginVersion: string;
  readonly pluginArtifactSha256: string;

  readonly acpMode: "stdio";
  readonly runtimePath: string;
  readonly providerId: string;
  readonly providerPackage: string;
  readonly providerPackageVersion: string;
  readonly protocol: string;
  readonly authentication: "api_key";

  readonly pricingSource: PricingSource;
  readonly testedModels: readonly string[];
  readonly issuedAt: number;
}
```

The runtime path distinguishes, for example, OpenCode's AI SDK and native LLM paths.
The protocol distinguishes Anthropic Messages from an OpenAI-compatible wrapper serving
an Anthropic model. Authentication is included because subscriptions, OAuth, cloud
identity, and direct API keys have different cost and routing semantics.

The managed launcher must establish the actual executable artifact. Merely finding an
`opencode` binary on `PATH` with a matching version string is insufficient when an
artifact digest is part of certification. Development builds may run in a diagnostic
mode but cannot satisfy `billing_required`.

Any mismatch fails closed before the first billable prompt.

---

## 6. Managed OpenCode profile

Billing-required mode creates an isolated OpenCode configuration and data environment.
It must not silently load the user's ordinary global profile, plugins, authentication
store, model defaults, or mutable pricing data.

The managed profile contains only:

- The certified provider configuration.
- The selected certified model.
- The bundled metering plugin.
- Explicitly allowed non-metering plugins, which form part of the certification if they
  can issue model calls.
- Session data required by the managed OpenCode process.
- A random, per-process metering-channel credential.

The launch handshake reports:

```ts
export interface OpenCodeMeteringHandshake {
  readonly protocolVersion: 1;
  readonly openCodeVersion: string;
  readonly openCodeArtifactSha256: string;
  readonly pluginVersion: string;
  readonly pluginArtifactSha256: string;
  readonly runtimePath: string;
  readonly providerId: string;
  readonly providerPackage: string;
  readonly providerPackageVersion: string;
  readonly protocol: string;
  readonly authentication: string;
}
```

The library validates the handshake against its certification registry before allowing a
token-consuming operation. A timeout, extra incompatible plugin, missing field, unknown
value, or version mismatch rejects startup.

Whether OpenCode's current public plugin surface exposes every required field must be
established by the compatibility spike. Missing public information requires either a
small pinned OpenCode integration patch or a narrower certification; it must not be
guessed.

---

## 7. Metering side channel

The plugin communicates with the parent library independently from ACP so ACP event
ordering and schema instability cannot erase inference records.

The first implementation may use authenticated loopback HTTP or a dedicated inherited
IPC channel. The choice must satisfy:

- Bind or expose only to the local process boundary.
- Authenticate every plugin message with a random per-process credential.
- Reject messages for unknown OpenCode sessions or request ids.
- Use a versioned message schema.
- Apply bounded buffering and backpressure.
- Never include prompts, responses, tool arguments, tool results, or provider
  authorization headers.
- Shut down with the managed process and surface incomplete finalization.

The channel transports metadata and usage only. It has a two-phase inference lifecycle:
the plugin sends `inference_started` before dispatch and waits for an authenticated
accept/reject acknowledgement; after the attempt terminates it sends
`inference_finished`. This lets the parent resolve and freeze the exact provider/model
pricing policy before money is spent and fail closed when the side channel or pricing
preflight is unavailable.

```ts
export interface OpenCodeInferenceStarted {
  readonly schemaVersion: 1;
  readonly kind: "inference_started";
  readonly requestId: string;
  readonly openCodeSessionId: string;
  readonly parentOpenCodeSessionId?: string;
  readonly inferenceKind: OpenCodeInferenceKind;
  readonly attempt: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: string;
  readonly runtimePath: string;
  readonly startedAt: number;
}

export type OpenCodeInferenceAdmission =
  | {
      readonly accepted: true;
      readonly pricingPolicyDigest: string;
    }
  | {
      readonly accepted: false;
      readonly reason: string;
    };
```

The completed record is:

```ts
export type OpenCodeInferenceKind =
  | "primary"
  | "compaction"
  | "title"
  | "generate";

export interface OpenCodeInferenceRecord {
  readonly schemaVersion: 1;
  readonly kind: "inference_finished";
  readonly requestId: string;
  readonly openCodeSessionId: string;
  readonly parentOpenCodeSessionId?: string;
  readonly inferenceKind: OpenCodeInferenceKind;
  readonly attempt: number;

  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: string;
  readonly runtimePath: string;

  readonly startedAt: number;
  readonly completedAt: number;
  readonly outcome: "completed" | "cancelled" | "error";
  readonly usage: TokenUsage | null;
  readonly usageFailureReason?: string;
}
```

`requestId` identifies one physical provider attempt. Retries are separate records and
must not overwrite the failed attempt. Whether failed/cancelled attempts contain billable
usage is recorded exactly as observed; absence is not zero.

---

## 8. Completeness boundary

Source inspection must demonstrate that the plugin hooks cover every provider execution
path admitted by the certification:

- Primary agent generation.
- Tool-driven continuations.
- Compaction.
- Title generation.
- Transient generation.
- Retry attempts.
- Task/subagent sessions created by the certified path.
- Cancellation and provider errors.

The certification must exclude or disable any path that bypasses the hooks. A source
change touching model dispatch, retry, provider runtime selection, plugin hooks, or usage
normalization invalidates certification until reviewed and retested, even if OpenCode's
public version string is unchanged.

This is verification by inspected software boundary, not proof of network routing. The
record therefore says `routing: "observed"`, never `enforced`.

---

## 9. Operation and inference attribution

`AgentSession` continues to serialize public operations. Before dispatching an ACP
operation, the library opens an attribution scope for the mapped OpenCode session:

```ts
export interface OpenCodeOperationScope {
  readonly operationId: string;
  readonly agentSessionId: string;
  readonly internalSessionId: string;
  readonly openCodeSessionId: string;
  readonly openedAt: number;
}
```

Every inference received while the scope is active is associated using the OpenCode
session id, parent-child session relation, request lifecycle, and inference kind. Time
windows alone are insufficient evidence.

An inference may be represented as:

```ts
export type InferenceAttribution =
  | {
      readonly status: "operation";
      readonly operationId: string;
      readonly purpose:
        | "prompt"
        | "handoff_summary"
        | "handoff_seed"
        | "compaction"
        | "title"
        | "retry"
        | "subagent"
        | "internal";
    }
  | {
      readonly status: "unallocated";
      readonly reason: string;
    };
```

Late or background inference must never be assigned to the next operation merely because
it arrived during that operation's wall-clock window. Known auxiliary calls should be
linked to their initiating operation and labeled by purpose. Calls with no defensible
link enter `unallocatedUsage`.

An operation reaches `attribution: "complete"` only after OpenCode reports the operation
idle/settled according to the tested lifecycle, all started inference records have a
terminal event, and every inference belonging to that operation is assigned to it. ACP
response arrival alone is not necessarily sufficient. Ambiguous relevant inference makes
the operation partial even though it is also preserved as unallocated usage.

Certified operation records retain their inference evidence:

```ts
export interface OpenCodeCertifiedOperationEvidence {
  readonly kind: "opencode_certified";
  readonly certificationId: string;
  readonly inferences: readonly {
    readonly inference: OpenCodeInferenceRecord;
    readonly attribution: InferenceAttribution;
    readonly ratedUsage: AttributableUsage | null;
  }[];
}
```

The implemented `OperationMeteringRecord` public type becomes a discriminated union of
ordinary ACP operation evidence and certified OpenCode evidence. A consumer can
therefore audit the operation aggregate against its individual inference attempts. The
inference evidence contains no conversational payload.

---

## 10. Unallocated usage

Unallocated inference is recorded rather than discarded:

```ts
export interface UnallocatedInferenceRecord {
  readonly inference: OpenCodeInferenceRecord;
  readonly attribution: {
    readonly status: "unallocated";
    readonly reason: string;
  };
  readonly ratedUsage: AttributableUsage | null;
}
```

It contributes to `AgentSessionMeteringState.unallocatedUsage` when the owning stable
session can be identified. If even the stable session is unknown, it is emitted as a
managed-process metering incident and blocks every billing-required session sharing that
process.

Allocated operation totals and unallocated totals remain separate. Consumers may display
a combined financial exposure, but core must not make an arbitrary operation bear the
unallocated amount.

Any unallocated provider usage blocks subsequent `billing_required` operations until an
audited reconciliation accounts for it. The already-observed record remains immutable.

---

## 11. Provider-normalized token usage

The plugin reports the final normalized token categories produced by the certified
OpenCode provider runtime for each physical inference:

```ts
export interface TokenUsage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly thoughtTokens?: number;
}
```

Unlike ACP-derived usage, these are per-inference observations. No cumulative baseline,
subtraction, restored internal-session counter, or counter-reset heuristic is applied.

The certified route defines:

- Which provider response fields feed every normalized category.
- Whether ordinary input excludes or includes each cache category.
- Whether reasoning is included in output and/or separately reported.
- How multiple streaming usage fragments form one final record.
- Whether unsuccessful attempts expose usage.
- How duplicate final events are identified idempotently.

Normalization correctness is tested independently from pricing correctness. Shared
maintenance by OpenCode and models.dev reduces mismatch risk but does not prove category
semantics.

---

## 12. Pricing and rated cost

The default resolver uses the pinned models.dev artifact defined by the shared metering
spec. Lookup requires both the certified `providerId` and actual `modelId`. Model-name
guessing, fuzzy aliases, and fallback to another provider's entry are forbidden in
`billing_required` mode.

Each `inference_started` message identifies the actual provider and model before dispatch.
The library invokes the pricing resolver once for that physical inference, freezes the
returned policy, and acknowledges its digest. When a tier depends on actual provider
request or response facts, the plugin supplies only the required non-content facts and
the library deterministically selects one of the frozen schedules after the inference.
It never resolves a new price after provider work. An operation containing multiple
inferences contains their individual rated lines and an exact sum by currency.
The operation record engraves:

- Pricing source kind.
- models.dev commit and artifact SHA-256, or consumer override version.
- Provider and model lookup keys.
- Applicable pricing tier.
- Cache-input convention.
- Reported and priced tokens per category.
- Unit price and denominator per category.
- Rounded category subtotal.
- Rated total.

`ratedCost` means exact under this schedule. It does not mean provider invoice cost.
Provider-reported cost, when present, remains separate.

Models.dev is an open-source catalog, not a guarantee of current provider prices. A
certification review must compare the pinned entry against authoritative provider pricing
for every tested model and account for pricing shapes the snapshot cannot represent,
including context tiers, service tiers, batch prices, regional prices, and cache-write
durations. A small versioned certified override is permitted when the catalog cannot
express the provider schedule. That override becomes the engraved pricing source.

Missing model identity, a missing billed category, an ambiguous tier, or an incomplete
schedule is a preflight or post-observation billing-required failure. No missing price is
treated as zero.

In billing-required mode, category applicability is certification evidence. A consumer
pricing override may change the tariff but cannot change an applicable category to
`not_applicable` or resolve an `unknown` category without a new certified override.

---

## 13. Billing-required enforcement

`billing_required` is satisfied only when all of the following hold:

1. The managed OpenCode and plugin artifacts match a recognized certification.
2. The runtime path, provider package, protocol, authentication mode, and selected model
   are admitted by that certification.
3. The metering side-channel handshake is authenticated and complete.
4. The operation's inference lifecycle is completely observed.
5. Every observed inference in scope is attributed completely; an unallocated inference
   is a recorded billing-required failure, not successful completeness.
6. Every reported billed token category has a complete applicable price schedule.
7. The consumer receives an immutable operation record and next state.

Known failures reject before provider work. Failures discovered after provider work:

- preserve the ACP response or error;
- emit every available inference and operation record;
- mark provenance/coverage honestly;
- block subsequent token-consuming work;
- never retry automatically merely to recover metering;
- require audited reconciliation or reconstruction from durable records.

There is no calibration prompt that upgrades an uncertified route. Compatibility smoke
tests may issue explicit calibration operations, but seeing one request does not certify
all execution paths.

---

## 14. Failure cases

The session or managed process blocks billing-required work when:

- OpenCode or plugin identity changes.
- The plugin channel disconnects, times out, or violates its schema.
- An inference starts without a terminal metering event.
- A terminal inference event lacks required usage.
- Duplicate request ids disagree.
- Provider/model/runtime identity changes to an uncertified tuple.
- Usage normalization produces invalid values.
- Pricing becomes incomplete or ambiguous.
- An inference cannot be attributed.
- OpenCode reports idle while an inference remains open.
- ACP and plugin session identity mappings conflict.
- The managed process exits before final metering flush.

A listener or consumer persistence failure does not mutate an already-created immutable
record, but it may prevent the consumer from safely continuing under its own financial
policy. Exactly-once durable billing remains outside the library's crash boundary.

---

## 15. Security and privacy

The plugin must never export conversational content. Side-channel schemas are allowlists,
not serialization of OpenCode message or HTTP event objects.

The managed profile must avoid loading arbitrary user plugins because a plugin can alter
model execution and invalidate the inspected boundary. Any permitted plugin set is part
of certification.

API credentials remain necessary in the OpenCode process for the first implementation.
This specification does not claim key isolation from the harness or its tool subprocesses.
Credential custody is the motivation for a possible future provider gateway, specified
and reviewed separately.

Temporary configuration and authentication files must use restrictive permissions and
must be removed through a recoverable, scoped lifecycle where practical. Secret values,
headers, prompts, responses, and tool data must not appear in metering diagnostics.

---

## 16. Provider certification matrix

The repository maintains a machine-readable registry plus a human-readable evidence
report. Each row is one precise route, not a broad provider family:

| OpenCode | Runtime | Provider package | Protocol | Auth | Models | Status |
|---|---|---|---|---|---|---|
| pinned by spike | AI SDK | pinned Anthropic package | Anthropic Messages | API key | explicit allowlist | planned |

Possible statuses are:

```ts
export type CertificationStatus =
  | "planned"
  | "experimental"
  | "certified"
  | "suspended"
  | "retired";
```

Only `certified` permits billing-required execution. A newly released OpenCode version,
provider package, model alias, or protocol route begins as `experimental`, even if an
older tuple was certified.

---

## 17. First Anthropic slice

The first spike must answer before implementation approval:

- Which released OpenCode build exposes the required plugin hooks while running
  `opencode acp`.
- Whether the hooks cover both AI SDK and any native runtime selected by that build.
- How actual provider/model/package/runtime identity is exposed to the plugin.
- Whether each physical retry receives a stable unique request identity.
- Whether final normalized usage is available after streaming and on failures.
- How tool continuations, compaction, title generation, transient generation, and task
  subagents appear.
- Whether ACP completion precedes OpenCode session idle and plugin finalization.
- How cancellation affects outstanding request and response hooks.
- Whether the managed profile can reliably exclude global configuration, credentials,
  and plugins.

The first certification should disable unsupported runtime alternatives rather than
trying to normalize them under one identity.

---

## 18. Test plan

### Artifact and startup

- Accept the exact certified OpenCode and plugin artifacts.
- Reject matching version text with a different artifact digest.
- Reject unknown versions, plugin versions, runtime paths, and provider packages.
- Reject missing, late, malformed, replayed, or unauthenticated handshakes.
- Demonstrate isolation from ordinary user OpenCode config, auth, and plugins.

### Inference capture

- Require an accepted pricing-policy acknowledgement before provider dispatch.
- Reject dispatch when inference identity, channel health, or price preflight fails.
- Capture one provider record for every physical primary call.
- Capture every tool continuation and retry separately.
- Capture compaction, title, generate, and subagent traffic.
- Preserve final streaming token counts without recording bodies.
- Represent cancelled and errored attempts without fabricated zeroes.
- Deduplicate identical records and reject conflicting duplicates.

### Attribution

- Map ordinary calls to the correct operation id.
- Map handoff summary and seed calls to their deterministic child operation ids.
- Keep late background work out of the next operation.
- Preserve auxiliary purpose labels.
- Put genuinely ambiguous records into unallocated usage.
- Block billing-required continuation after unallocated usage.
- Wait for the tested settled boundary before claiming complete attribution.

### Pricing

- Reproduce the pinned snapshot from its source commit.
- Verify the generated artifact SHA-256.
- Convert prices to canonical decimal strings at generation time.
- Resolve exact provider and model keys without fuzzy fallback.
- Test input, output, cache read, cache write, and reasoning categories.
- Test applicable context/service tiers and reject ambiguous tiers.
- Compare certified model schedules with authoritative provider pricing evidence.
- Engrave snapshot/override identity and all applied prices.
- Demonstrate that historical records do not change after a catalog upgrade.

### Failure and recovery

- Preserve usage after ACP cancellation or error when OpenCode reports it.
- Block on missing terminal inference events or missing required usage.
- Block when the plugin disconnects or OpenCode exits without flushing.
- Restore and deduplicate durable inference/operation state after reopen.
- Reconcile unallocated or incomplete state only through the audited API.

### Live smoke tests

- Run a trivial prompt.
- Run a tool-using prompt with multiple continuations.
- Trigger a retry using a controlled provider response.
- Trigger compaction.
- Observe title generation if enabled.
- Run a task/subagent if admitted by certification.
- Cancel during streaming.
- Change model/provider and verify fail-closed behavior.

Tests that spend real provider money must be opt-in, budget-capped, and record the exact
certification and pricing snapshot under test.

---

## 19. Rollout sequence

1. Complete the OpenCode compatibility spike and evidence report.
2. Select and pin one OpenCode artifact and provider runtime path.
3. Generate the first pinned models.dev snapshot and certified pricing override format.
4. Implement the versioned plugin side-channel schema.
5. Implement managed-profile launch and authenticated handshake.
6. Capture per-inference normalized usage and lifecycle.
7. Implement operation, auxiliary, retry, subagent, and unallocated attribution.
8. Integrate rated costs with shared operation records and state version 2.
9. Run fixture tests and opt-in live Anthropic smoke tests.
10. Mark the exact tuple `certified` only after the evidence is reviewed.
11. Add provider routes incrementally using the same process.

The generic OpenCode adapter and other ACP adapters remain available throughout rollout.

---

## 20. Deferred provider gateway

A provider metering/credential gateway is not part of this implementation. If built, it
receives its own specification, package subpath, threat model, and security review.

Its likely first host is managed OpenCode because provider `baseURL` is documented
configuration there. It may improve credential custody and add provider-native wire
evidence, but it does not replace OpenCode's normalized provider coverage or inference
attribution plugin.

---

## 21. Non-goals

- Certifying arbitrary OpenCode installations or future versions automatically.
- Certifying all providers supported by OpenCode.
- Treating models.dev as an invoice or silently live-updating its data.
- Charging end users or storing the consumer's billing ledger.
- Claiming OS-level network isolation.
- Parsing or persisting prompt/response bodies in the metering channel.
- Supporting subscription/OAuth routes in billing-required mode.
- Building the provider gateway in the first pass.
