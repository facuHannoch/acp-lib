
## Part 9 — AgentSession metering specification

Status: specification complete; implementation pending.

### Purpose

Before implementing more CLI behavior, define the consumer-facing metering contract
needed by orchestration libraries. The design separates context-window pressure, token
usage, monetary estimates/provider cost, and non-standard subscription quota instead of
treating `/usage` output as one portable value.

The implementation-oriented specification is in `9-6-SPEC-metering.md`. Existing discussion
notes in `.res/somelogs.md/9-5+/9-5-metering.md` were preserved unchanged rather than
overwritten.

### Core boundary

Metering belongs to the stable `AgentSession` layer. `AcpClient` normalizes the ACP usage
payload but does not own pricing or logical-session aggregation. `AgentSession` maintains
bounded live state, calculates attributable deltas, applies the price resolved for each
operation, and returns/emits immutable operation records. The consumer owns the durable
history/dashboard and may pass the last versioned metering state back when reopening an
`AgentSession`.

Neither transcripts nor `SessionManager` become a required accounting database. Metering
works with transcripts disabled and without a catalog.

### Usage and context decisions

- ACP prompt counters are treated as cumulative internal-session observations rather
  than values that can be naively added after every turn.
- The public usage shape is corrected to include `totalTokens` and ACP's
  `cachedReadTokens` / `cachedWriteTokens` names.
- Attributable usage is calculated only from a trusted zero, a matching restored state,
  or a prior observation in the same live object.
- Missing values never become zero; decreasing counters are treated as resets rather
  than negative usage.
- Stable totals aggregate over `agentSessionId`, including handoffs and future provider
  changes.
- `session.contextWindow` represents only the latest active internal thread. It resets
  to unknown on a provider-thread transition and is replaced by later `usage_update`
  observations.

### Engraved pricing

Every attributable token category carries its token count, exact unit price, and computed
subtotal. Prices use an explicit denominator (normally one million tokens), currency, and
decimal-string amounts. Pricing is resolved before an operation and captured on that
queued operation, so a later global price change cannot alter historical records.

Input, output, cached-read, cached-write, and thought tokens can each have distinct unit
prices. `totalTokens` is not priced again because that would double-count its components.
Provider-reported cumulative cost remains distinct from locally estimated operation
cost and is never named actual/invoiced cost.

### Enforcement and subscriptions

The policy is `required` versus `best_effort`, not API versus subscription and not an
inferred login type.

- Required mode is intended for consumer-funded API access. Known missing baselines or
  pricing fail before provider work. Missing post-operation usage preserves the model
  response, emits an unavailable record, blocks further metered work, and never invites
  an automatic retry that could duplicate cost.
- Best-effort mode is intended for user-owned logins/subscriptions and informational
  dashboards. Usage may be present with no price, and missing telemetry does not block
  prompting.

Subscription quota and harness-specific `/usage` parsing are out of scope because ACP
does not standardize them and missing telemetry does not prove subscription use.

### Operation records and persistence

`AgentSession.prompt()` and internal-session commands are specified to return an enriched
result containing an immutable `OperationMeteringRecord`. The record contains operation,
logical/internal session, adapter/model, cumulative report, attributable/priced usage,
latest context/provider-cost observations, and `nextState`. It intentionally excludes
prompt, response, and tool content; consumers join those through `operationId`.

The live session retains totals, current baseline/context/provider cost, last operation,
and metered/unmetered operation counts—not an unbounded history. The consumer stores each
record and its next state and restores that state when reopening if lifetime totals and
first-operation deltas must remain exact.

Handoff summary generation and continuation seeding are separate metered operations.
Typed prompt/handoff errors must carry records for operations that reached the provider,
so rejected calls do not make accounting observable only through listeners.

### Timing and empirical work

Prompt token attribution uses normalized `PromptResponse.usage`. Context and provider
cost remain independently timed `usage_update` observations. An operation attaches only
the latest snapshot seen before it completes and does not claim that the snapshot
includes that operation. The library does not wait arbitrarily for a later notification.

The spec requires real-harness investigation across Codex, Claude, Pi, Kimi, and OpenCode
where available before this timing contract can be strengthened.

### Deferred work

- Runtime implementation and public exports.
- Real-provider timing/semantics measurements.
- Subscription quota parsing.
- CLI presentation.
- Transcript capture/security policy.
- Transcript hashing/HMAC integrity, since transcripts are not the accounting source of
  truth.

### Verification

- `9-6-SPEC-metering.md` contains 22 implementation-oriented sections covering scope, types,
  invariants, enforcement, event ordering, errors, performance, persistence boundaries,
  test cases, and implementation order.
- Markdown code fences are balanced.
- No trailing whitespace exists in the new specification.
- No runtime files or tests were changed in this part.

### Specification review corrections

A subsequent correctness review found seven areas that needed to be explicit before
implementation. The moved specification was revised in place.

#### Cache-inclusive input

`PricingSchedule` now requires a per-cache-category `cacheInputConvention`, recording
whether cached-read and cached-write counters are included in or excluded from the ACP
input counter. `AttributableUsage` engraves the convention, retains the unadjusted
cumulative-counter delta, and distinguishes `reportedTokens` from `pricedTokens` on each
line item. Included cache is subtracted before applying the ordinary-input price and then
priced in its own category; invalid negative adjusted input is never clamped to zero.

The real-harness matrix must record evidence for each adapter's convention, but the
immutable operation record remains the historical source for the assumption actually
used.

#### Partial category totals

`UsageTotals` no longer represents every category as an apparently complete number. Each
category exposes `knownTokens`, `unattributedOperationCount`, and
`complete | partial | none` coverage. Known totals are explicitly lower bounds. This
handles harnesses that report input/output but omit cached-write or thought counters
without fabricating category zeroes.

#### Decimal and currency semantics

The spec now fixes the accepted canonical decimal grammar, scale 12 calculation limit,
round-half-even behavior, per-category rounding, and exact summation of engraved rounded
subtotals. It defines conversion of ACP's JSON-number cost through the shortest
round-trippable JavaScript representation with exponent expansion, while acknowledging
that parse-time precision cannot be recovered.

One pricing schedule must use one currency. Provider-reported cost and local estimates in
different currencies remain separate and are never converted, compared, or summed by
core.

#### Required-mode recovery

ACP has no usage capability bit or prompt-free usage request, so required mode cannot
prove harness support before its first provider operation. It still fails fast on known
preflight defects. A later missing/malformed report or counter reset blocks subsequent
operations without discarding the already-produced model response.

Added an explicit `reconcileMetering()` design. It is idle-only, validates a complete
state against the current logical/adapter/internal identities, requires an audit reason,
atomically replaces state, and emits an immutable before/after reconciliation event. It
provides in-place recovery from a harness incident without an unaudited “assume zero”
escape hatch or mandatory process rebuild.

#### Edge behavior

- Pricing resolver absence, `null`, throw, and rejection now have defined required and
  best-effort behavior and never trigger automatic retries.
- Absent `usage_update.cost` preserves prior provider cost; explicit null clears it;
  malformed optional cost produces a diagnostic without blocking otherwise valid token
  metering.
- Provider cost was removed from `ContextWindowStatus` and exposed as independent live
  state because a cost-only change is not a new context observation.
- Handoff child operation ids are deterministically `${handoffId}:summary` and
  `${handoffId}:seed`.
- Counter reset is explicitly listed as a required-mode blocking failure.

#### Ownership and compatibility

The spec records the single-live-metering-owner assumption: two live logical sessions
loading the same internal provider thread can independently attribute the same cumulative
increments. ACP supplies no distributed lease, so exclusive ownership remains a consumer
registry/database responsibility.

A new compatibility section covers the complete migration surface: corrected `Usage` /
`TokenUsage` fields and cumulative semantics, enriched AgentSession prompt results, typed
operation and handoff errors, added event variants, and handoff result changes. Consumers
that previously summed `PromptResult.usage` must migrate to attributable operation usage.

## OpenCode certified-metering revision

The metering design was revised after establishing that ACP cannot negotiate usage
support and that its SDK documentation conflicts about per-turn versus cumulative prompt
usage. The former `required` design could stop after a missing report, but it could not
prove billing completeness before or after an operation. The specification no longer
presents strict ACP-derived telemetry as billing-grade evidence.

### ACP metering corrections

Revised `9-6-SPEC-metering.md` in place:

- ACP cumulative semantics are now an explicit library interpretation of contradictory
  SDK documentation, not a protocol fact. The interpretation is stamped in provenance,
  and the implementation may not switch semantics using an undocumented runtime
  heuristic.
- Added four evidence axes: source, measurement, routing, and attribution, plus an
  optional library-recognized certification id.
- Replaced the ambiguous enforcement name with `best_effort`,
  `telemetry_required`, and `billing_required`. ACP alone can satisfy only the first two;
  billing-required needs a certified integration.
- Renamed locally calculated monetary values from estimates to rated costs. A rated cost
  is exact under its engraved schedule while remaining distinct from provider-reported
  cost and an upstream invoice.
- Added a pinned models.dev snapshot as the default resolver. The immutable upstream
  commit, generated artifact SHA-256, generation time, provider/model lookup keys, tier,
  cache convention, unit prices, and subtotals are part of historical pricing evidence.
- The resolver freezes a complete versioned pricing policy before provider work, not
  necessarily one prematurely selected schedule. Context/service/batch-dependent tiers
  are selected afterward from trusted request/response facts without fetching new prices.
- ACP-derived metering resolves once per operation; certified OpenCode resolves once per
  physical inference. The plugin's two-phase start/finish protocol waits for pricing
  admission before each provider dispatch, so hidden auxiliary calls cannot bypass price
  preflight merely because the outer operation selected a different model.
- Retained consumer pricing overrides with mandatory stable version identity and added
  `pricing: false` as the explicit way to disable local rating.
- Required structured provider identity for default catalog lookup. The resolver does
  not guess a provider from an arbitrary model string.
- Recorded that OpenCode token normalization and models.dev pricing remain independently
  testable inputs even though they are maintained in the same ecosystem.
- Added explicit unallocated usage to version 2 of live/restorable metering state. ACP's
  inability to see hidden inference means an empty ACP unallocated bucket is not evidence
  of complete inference coverage.
- Updated compatibility, test, and implementation sections for the revised terminology,
  catalog generator, provenance, and state shape.

### New OpenCode specification

Added `9-6-SPEC-opencode-certified-metering.md` as the separate billing-required design.
It defines:

- A generic `openCode()` ACP adapter that remains best-effort and an explicit
  `managedOpenCode()` integration for certified operation.
- A load-bearing certification tuple covering exact OpenCode/plugin artifacts, runtime
  path, provider package, protocol, authentication mode, pricing snapshot, and tested
  model allowlist.
- An isolated managed OpenCode profile and an authenticated, versioned plugin handshake.
- A metadata-only local side channel carrying one record per physical model attempt,
  including retries and OpenCode's primary/compaction/title/generate classification.
- Source-inspection requirements proving that the pinned hooks cover every admitted
  model-call path; the resulting provenance is `routing: observed`, not an unsupported
  OS-level enforcement claim.
- Operation attribution using OpenCode session and parent-session identity rather than
  wall-clock windows alone, with auxiliary purposes and a durable unallocated path.
- Per-inference provider-normalized usage with no ACP cumulative baseline arithmetic.
- Catalog-based rating, certified overrides for price shapes models.dev cannot express,
  and fail-closed behavior for missing identity, category prices, or pricing tiers.
- Billing-required preflight/post-operation blocking conditions, reconciliation
  boundaries, security/privacy constraints, provider certification lifecycle, and a
  detailed fixture/live test plan.
- The first proposed slice: one pinned OpenCode build, its AI SDK path, one pinned
  Anthropic provider package, the Anthropic Messages protocol, API-key authentication,
  and an explicit model allowlist.
- The provider/credential gateway as a separate deferred subsystem rather than part of
  the first metering implementation.

### Important boundary found while writing

A single OpenCode adapter does not certify all OpenCode providers. Certification is per
precise execution route, and an OpenCode or provider-package update begins as
experimental even if an older tuple was certified. The OpenCode plugin API/runtime must
first be spiked against an actual released `opencode acp` build; missing identity or
lifecycle data must lead to a narrower certification or a pinned integration patch, not
guessed metadata.

### Verification

- Both specification files have balanced Markdown code fences.
- `git diff --check` reports no whitespace errors in tracked changes.
- The new specification contains no prompt, response, tool, or credential persistence in
  its side-channel contract.
- No runtime source, dependency, generated catalog, or test was changed in this part.

## Second metering-spec consistency review

A follow-up review identified seven internal consistency and persistence issues. Both
specifications were corrected before implementation.

### Reconciliation durability and recovery events

`reconcileMetering()` now returns immutable `before` and `after` states. The returned and
`metering_reconciled.after` value is explicitly the authoritative state for the next
`initialState` restore and must be persisted even when no later operation occurs. A
consumer persistence integration must process both `metering_recorded` and
`metering_reconciled`; operation records alone are insufficient.

Added `metering_unblocked`, emitted after `metering_reconciled` when the installed state
transitions from blocked to unblocked. Both events observe the same already-installed
snapshot. The test plan now includes reconcile, persist, stop before another operation,
and reopen.

### Pricing facts and tier selection

A pricing condition can now be evaluated only from a billing fact guaranteed by the
active backend. ACP cumulative deltas and `contextAfter` are explicitly forbidden as
proxies for operation context size. An ACP route unable to provide the fact required by
`context_tokens_at_least` returns `pricing_unavailable`, preserving the timing contract
and preventing accidental Anthropic long-context mispricing.

### State-version handling

`initialState.version` is validated before any version-specific field. Unknown versions
fail preflight in telemetry-required/billing-required modes. Best effort ignores the
foreign state wholesale and exposes structured restoration status with
`initial_state_version_unsupported`; it never reads coincidentally compatible fields.

### Category applicability and coverage

Pricing policies now declare each token category as applicable, not applicable, or
unknown independently from the presence of a price. A missing models.dev price does not
prove a category is inapplicable. Reporting a category declared not applicable is
contradictory evidence and invalidates the policy/record.

`UsageCategoryTotal` now distinguishes attributed, explicitly not-applicable, and
unavailable operation counts. Coverage adds `not_applicable`; mixed model histories can
remain complete when every applicable operation was attributed. Explicit reported zero
still counts as attributed rather than absent.

### Backend-neutral provenance

The shared provenance source changed from the harness-specific `opencode_plugin` to
`certified`. `certificationId` identifies the concrete OpenCode integration, allowing a
future certified backend without changing the core enum.

### Stale wording and accumulation

Corrected telemetry-required preflight from a pricing schedule to a pricing policy and
corrected the performance rule from once per queued operation to once per rating unit.
Cross-operation rated totals are now defined as exact same-currency sums of already
rounded engraved operation totals, with no rerating or second rounding step.

### Serialized-size requirement

Removed the inherited unmeasured “hundreds of bytes to a few kilobytes” claim. The
implementation must measure canonical JSON p50/p95/max fixture sizes, publish them in the
implementation log, and set a regression threshold from evidence. Certified
per-inference arrays are measured separately because their size varies with inference
count.

### Added verification cases

The test plan now covers unsupported state versions, reconciliation persistence across
reopen, unblock event ordering, unavailable ACP tier facts, explicit applicability,
not-applicable/mixed category histories, cross-operation decimal accumulation, and
measured serialized record sizes.

### Aggregate total type correction

A final type review noted that `UsageTotals.total: UsageCategoryTotal` allowed impossible
aggregate states: total tokens cannot be inapplicable, yet the shared category type
exposed `notApplicableOperationCount` and `coverage: "not_applicable"`. Added the narrower
`AggregateUsageTotal` for `UsageTotals.total`; it tracks known tokens plus attributed and
unavailable operations with only complete/partial/none coverage. Category totals retain
the richer applicability shape. The test plan now pins the impossible states out of the
public type.

## Part 10 — Persistence and transcript specification

Status: specification complete; implementation pending.

Created `9-6-SPEC-persistence-transcripts.md` as the implementation contract for logical
session persistence, transcript security policy, restoration, crash recovery, and
pagination. The existing `9-6-transcript-policy.md` discussion record was preserved.

### Persistence model and defaults

- Consolidated persistence under one `persistence` configuration with independently
  disableable registry and transcript facilities.
- Defined the default root precedence as explicit root, `ACP_CLIENT_HOME`, then
  `~/.acp-client`.
- Defined the default layout as one authoritative `agent-sessions.json` registry plus
  one transcript per stable `agentSessionId` under `transcripts/`; no second metadata
  file is created per session.
- Made persistence enabled by default with the `activity` transcript preset and retained
  `persistence: false` as the complete opt-out.
- Fixed path semantics: existing directory derives a filename, existing file is exact,
  nonexistent path is an exact future file, and non-regular filesystem objects fail.
  Paths are absolute and the default store rejects symlink destinations.

### Creation, loading, and registry

- Separated `AgentSession.create()` from `AgentSession.open()` so path, ID, checkpoint,
  and internal-thread inputs no longer form an implicit precedence chain.
- Defined consistent-candidate selection across consumer, registry, and transcript
  checkpoints; equal-revision conflicts fail rather than choosing one arbitrarily.
- Added the externally discoverable `SessionManager.open()` shape and the explicit
  `listAgentSessions()` name, plus optional manager factories which return live sessions
  without retaining ownership of them.
- Defined a central versioned JSON registry with record revisions, stable/current
  internal-session identity, structured internal-session history, model, negotiated
  protocol, transcript configuration, checkpoint, and consumer metadata.
- Replaced unsafe read-modify-save storage with a per-record CAS contract suitable for
  both the default JSON implementation and database-backed consumer stores.
- Specified cross-process exclusion, temp-file synchronization, atomic replacement,
  backup recovery, corruption visibility, and pagination behavior under concurrent
  registry mutation.

### Transcript security and v2 format

- Finalized the preset ladder as `conversation`, `activity`, `detailed`, and
  `diagnostic`, backed by an explicit component policy.
- `activity` stores user-facing operational metadata without arguments, commands, paths,
  outputs, diffs, reasoning, raw errors, or unknown payloads. Filtering occurs before
  persistence. Diagnostic selection itself authorizes sensitive raw ACP capture; logger
  debug level remains unrelated.
- Defined mandatory content-free structural records so a transcript can remain a
  restoration artifact even under a minimal capture policy.
- Defined the v2 JSONL envelope, strict sequence ordering, transcript identity and
  generation, headers, checkpoints, operations, messages, activities, permissions,
  transitions, metering references, lifecycle, raw, and unknown-record behavior.
- Preserved activity lifecycle checkpoints and last-write-wins folding. Announced,
  input/progress, settled, and nonterminal flushed records remain separate immutable
  full-state revisions and may be separated by large portions of the transcript.
- Distinguished the existing live `activitySnapshot()` from offline folded
  `PersistedActivityState`; an old open record is historical evidence, not proof that a
  tool remains executing after restart.

### Checkpoints, durability, and recovery

- Defined one versioned `AgentSessionCheckpoint` containing the current routing state,
  internal-session history, transcript boundary, metering restore state, and clean versus
  in-flight boundary.
- Checkpoint revisions are compared by an RFC 8785 canonical-JSON SHA-256 digest. This is
  corruption/conflict detection, not tamper-resistant billing storage.
- Checkpoints are written initially, after every reached-harness operation, and whenever
  handoff/switch/model/mode/reconciliation state changes.
- Added a write-ahead rule: captured input and an operation-start marker are durably
  synchronized, and every enabled continuation store records in-flight state, before
  provider work is dispatched.
- Defined clean and active stop ordering, transcript-lifetime writer ownership, and the
  limitations of `SIGKILL`, power loss, and external tool side effects.
- Restoration evaluates the checkpoint plus its journal tail. Dirty boundaries block new
  work while the library attempts adapter-assisted recovery.
- Only a certified adapter replay contract can prove reconciliation; generic ACP load
  replay is observable evidence but remains uncertain. Consumers can explicitly accept
  the harness state, start a new internal session with continuation context, or abort.

### Pagination and migration

- Replaced timestamp-only pagination with opaque, query-bound cursors carrying a stable
  high-water mark, byte/sequence boundaries, generation, and boundary validation.
- Added `conversation`, `timeline`, and `records` projections; pages start from the newest
  region but return items oldest-to-newest. Limits count projected items, not physical
  lines.
- Defined deterministic older/newer navigation, cursor invalidation, partial-final-line
  handling, typed v2 corruption, bounded iteration, and a future-compatible path to
  disposable indexes and segmented transcripts.
- Kept v1 readers and their permissive behavior during migration. A v2 upgrade header can
  follow a validated v1 prefix without rewriting history, while v2 corruption rules are
  determined by the recorded byte boundary.
- Deprecated the old transcript/session configuration while preserving its historical
  no-implicit-restore behavior and preventing legacy options from unexpectedly enabling
  the new default registry.

### Verification and implementation boundary

- The specification includes configuration, security, concurrent-registry, durability,
  simulated power-loss, recovery, lifecycle, pagination, and migration test matrices.
- Markdown code fences are balanced and whitespace checks pass.
- No runtime source, tests, dependencies, or metering specification were changed in this
  part.

### ACP session-configuration correction

A follow-up review identified that storing only the normalized `model` was insufficient:
successful ACP `setConfig()` calls can also change reasoning effort, mode, and arbitrary
harness-defined session state. The specification now includes
`SessionConfigurationCheckpoint` in the registry, current checkpoint, and each historical
internal-session descriptor.

The checkpoint distinguishes explicitly desired selections from the latest effective
values returned by the harness and preserves application order. Default persistence is
limited to advertised select/boolean values; consumers can exclude IDs, include specific
unknown IDs, persist all JSON-compatible values with the documented sensitivity risk, or
disable config-value persistence.

On reopen, the newly announced harness catalog remains authoritative for what is valid.
Persisted desired selections are validated and reapplied in order before prompting. A
missing, invalid, rejected, or deliberately omitted value produces visible
`configuration_mismatch` recovery instead of silently changing model behavior.
Same-adapter handoff carries desired selections before seeding; cross-adapter switching
requires an explicit mapping. Policy-visible selection records are distinct from full
announced definitions, which are retained only by the diagnostic-level configuration
policy.

### Persistence ownership correction

A design review found that placing transcript configuration on `SessionManager` as one
manager-wide policy prevented natural per-session choices. The specification now assigns
the registry to the manager and the transcript writer/effective capture policy to each
individual `AgentSession`.

`SessionManager` can provide session persistence defaults, but every
`createAgentSession()` call can select its own transcript path, preset, capture overrides,
configuration-value policy, or `transcript: false`. The resolved choice is stored on that
session's registry record and reused by `loadAgentSession()`; changing it during load is
not an ordinary override and requires an explicit transcript-relocation operation.

The default behavior is now scoped by entry point:

- Direct `AgentSession.create/open` remains the low-level consumer-controlled path and
  performs no persistence unless explicitly configured.
- `SessionManager.createAgentSession` is the managed path: it always records the logical
  session in the manager registry and defaults that individual session to an `activity`
  transcript plus typed ACP configuration persistence.

The manager resolves construction and restoration but does not retain live session
objects or proxy their operational methods. Consumers continue to own their live-session
map and call `prompt`, `handoff`, `setConfig`, `interrupt`, and other methods directly on
the returned `AgentSession`.

### Durability decision note

Added `9-6-NOTE-durability.md` to isolate the power-loss durability concern and preserve
the deferred design without expanding the v0 API.

V0 will not expose synchronous versus buffered durability modes. Managed persistence
requires a durable operation-start/in-flight boundary before provider dispatch and a
durable terminal checkpoint afterward. Direct sessions with persistence disabled make no
such guarantee. Transcript-backed managed sessions synchronize the append-only
continuation journal; registry-only sessions must instead publish the in-flight state to
their registry before dispatch.

The note retains the possible future buffered mode and its honest limitation: sudden
power loss could erase recent boundaries and make an apparently clean checkpoint
unreliable. It is deferred until measurements show synchronization latency is material
relative to harness/model operations.

### Persistence restoration and recovery correction

Normalized `9-6-SPEC-persistence-transcripts.md` after the adapter ownership, checkpoint,
missing-transcript, and recovery discussion.

Adapter construction is no longer a `SessionManager` concern. The manager stores the
stable `adapterId`, but every create/load/open operation receives the concrete adapter
from the consumer. Ordinary restoration permits another adapter object or version under
the same adapter identity and lets `loadSession()` determine compatibility. A different
adapter identity fails before harness startup with `AdapterMismatchError`; continuing
through another adapter is an explicit switch or transcript reconstruction operation.

Removed the complete `internalSessionHistory` from `AgentSessionCheckpoint`. Checkpoints
now retain only the current internal session, activation time, optional last transition,
and bounded history revision/digest. The registry retains history for registry-only and
listing use, while transcript-enabled history is reconstructed from transition records.
The digest is a corruption-consistency signal, not a competing recovery source.

Replaced the dual-authority checkpoint rules with conditional authority:

- registry plus transcript: registry provides discovery and transcript provides
  continuation;
- registry only: registry provides discovery and continuation;
- transcript only: the consumer supplies discovery and transcript provides continuation;
- neither: the consumer supplies both the checkpoint and adapter.

A registry-declared transcript is mandatory during managed restoration. Missing,
unreadable, corrupt, and identity-mismatched files now produce distinct typed errors
before harness startup. Managed restoration never creates a replacement transcript,
falls back to a stale registry projection, starts an empty thread, or inherits legacy
`providerSession.onFailure: "new"` behavior. Registry-only sessions remain valid without
a transcript.

V0 automatic certified replay was removed from the active contract and deferred. Dirty
boundaries remain explicitly `uncertain`; generic ACP load replay can add observable
evidence but cannot prove completeness. Continuation recovery is now an ordered,
extensible pipeline: validate the checkpoint, try the recorded internal session by
default, then only when explicitly configured create a new thread from transcript or
consumer-provided continuation. This preserves a future extension point without making
costly/content-sending reconstruction an implicit fallback.

The public deletion contract now defaults to a registry tombstone with transcript
retention. Transcript deletion and permanent registry removal are separate explicit
booleans, deleted entries are hidden normally and discoverable with `includeDeleted`, and
the fully destructive combination requires explicit selection. The old ambiguous listing
names are decided: manager inventory is `listAgentSessions()` and harness discovery is
`AgentSession.listInternalSessions()`.

Also added announced ACP configuration IDs for actionable schema mismatch reporting,
bounded configuration reapplication to one ordinal pass, a concrete versioned structured
message payload, and timeline `types` filtering when the requested types are members of
the timeline union. Tests, notifications, implementation order, and deferred-work lists
were aligned with these decisions. No runtime source or tests were changed.

### Continuation outcomes and tombstone restoration correction

Completed the final pre-implementation clarification pass on the persistence spec.

Separated continuation acquisition from crash-boundary reconciliation. Opening always
uses an ordered `ContinuationStrategy` pipeline, defaulting only to loading the recorded
internal session. `new_from_transcript` requires an explicit consumer builder in v0, and
consumer-supplied continuation remains explicit. Independently, an uncovered or in-flight
operation produces `SessionRecoveryStatus: uncertain`; successfully finding or creating
a provider thread cannot make that uncertainty disappear.

Both direct `AgentSession.open()` and managed `loadAgentSession()` now return an
`AgentSessionOpenResult`. Its continuation report includes the recorded adapter and
internal session, requested adapter, whether the recorded thread was available,
every ordered attempt, the final source, transition ID when reconstruction occurred, and
the active internal session ID. If opening exhausts its strategies, the typed error
carries the same partial report. Opening-time notifications mirror the attempts and
outcome, but the return/error value is authoritative because consumers cannot reliably
attach a session listener before an open returns.

ACP configuration mismatch is no longer mislabeled as crash recovery. It has a separate
`ConfigurationRestoreStatus`, while continuation availability is represented only by the
continuation report and crash recovery only by the durable operation boundary.

Made registry-ahead validation mechanical: the implementation reconstructs the expected
in-flight checkpoint from the authoritative transcript checkpoint plus journal tail and
accepts the registry only when every field and digest match that projection. Other
registry-newer state remains an uncertain persistence gap and never overrides transcript
continuation.

Clarified that an unexpectedly missing authoritative transcript fails validation before
continuation strategies run. Consumer continuation is available only when transcripts
were intentionally disabled, a direct consumer checkpoint is authoritative, or an
explicit repair/import has replaced the missing authority.

Specified `getAgentSessionInfo()` as the manager metadata lookup used to obtain
`adapterId`; it never returns or owns a live session. Completed tombstone behavior:
ordinary load rejects deleted sessions, `restoreAgentSession()` explicitly accepts a
tombstone, deleted transcripts require an explicit replacement/disabled choice, and the
tombstone clears only after successful continuation, durable checkpointing, and CAS
publication. Transcript locks reject deletion of active transcript-backed sessions;
registry-only races cannot resurrect a tombstone. Only explicit hard registry removal
plus transcript deletion permits stable-ID reuse.

The required-test matrix and notification contract were extended for all of these cases.
No runtime source or tests were changed.

### Separate operational audit artifact

Extended `9-6-SPEC-persistence-transcripts.md` after deciding that operational evidence
may need different storage, access, and retention policy from conversation/restoration
content.

The ordinary transcript can now explicitly operate without message capture, preserving
its structural checkpoints and continuation authority while never enqueueing user or
assistant text. Tool capture gained an `input` level between `metadata` and `content`:
it retains arguments, commands, paths, and edit patches while excluding tool results,
terminal output, and returned file content.

Added an optional, separately configured `auditLog`. It is disabled by default, has its
own path, identity, generation, sequence, lock, capture policy, reader, cursor, registry
metadata, deletion controls, and typed failures. Its default policy records operational
tool input, lifecycle, transition metadata, permission decisions, usage, and selected ACP
configuration, but never messages, restoration checkpoints, raw ACP traffic, handoff
content, or consumer continuation content.

The transcript remains the sole file-based continuation authority. The audit artifact is
never consulted for thread selection, checkpoint restoration, metering restoration,
crash reconciliation, or transcript reconstruction. Shared logical/operation/activity
identifiers correlate both files, but the specification makes no cross-file atomic-commit
or total-order claim.

Configured audit durability is strict in v0: its start boundary must synchronize before
provider dispatch. A post-dispatch audit failure reports a visible audit gap and blocks
later state-changing work without changing the independent continuation-recovery status.
Managed reopen rejects a missing or corrupt expected audit artifact unless the consumer
explicitly replaces or disables it.

The registry schema, listing summaries, pagination/cursor contract, continuation report,
notifications, tombstone/deletion rules, required tests, and implementation order were
updated consistently. No runtime source or tests were changed.

### Final pre-implementation persistence corrections

Closed six correctness and security gaps identified in the persistence specification.

Added `operation(aborted)` with explicit pre-dispatch persistence-failure and cancellation
reasons. When one required start boundary fails after another became durable, dispatch is
withheld and every successful artifact receives a compensating abort plus a settled
checkpoint where applicable. A durable abort proves the harness was not contacted and can
repair a missing settled checkpoint deterministically; failure to persist the abort
correctly remains uncertain.

Made internal-session history reconstruction canonical. Transitions now have a
`target_activated` phase carrying the exact immutable `InternalSessionHistoryEntry`, while
descriptors include configuration and activation time. The fold rules explicitly cover
creation, activation, completion, failure before activation, and failure after activation,
so implementations never infer timestamps or history from adjacency.

Defined the previously implicit repair surface. V0 has no live repair: consumers stop the
session and use `reconfigureAgentSessionPersistence()` with revision CAS, a stable
reconfiguration ID, explicit loss acknowledgements, and a validated checkpoint. The
registry records a prepared transaction before destructive work, replacement remains at
the same path in v0, durable artifact installation precedes final registry publication,
and identical retries can complete interrupted work. Checkpoint lookup can explicitly
return a nonauthoritative registry projection after transcript loss. Relocation, general
orphan import, and in-place continuation after an audit gap remain deferred.

Prohibited hard registry removal while retaining any configured artifact. Fully
destructive removal must explicitly delete every transcript/audit log, synchronizes those
deletions before CAS-removing discovery, and remains retryable if interrupted.

Removed the unsupported claim that a direct consumer can reproduce pre-dispatch durability
from notifications. Durable database-backed continuation uses an injected
`AgentSessionStore` through `SessionManager`; with both continuation stores disabled the
library makes no restoration guarantee.

Added concrete record-security limits and defaults: 1 MiB per record, 256 KiB per captured
field, JSON depth 64, and cursor size 4 KiB, with documented configurable hard ceilings.
The contract now specifies UTF-8 measurement, Unicode-safe truncation, deterministic
omission metadata/digests, filtering before measurement, truncation priority, rejection of
oversized structural records, and pre-decode reader/cursor validation. Conversation
availability reports `partial` when retained messages were size-limited.

Updated schemas, registry summaries, error taxonomy, notifications, recovery rules,
deletion ordering, tests, implementation order, and deferred work accordingly. No runtime
source or tests were changed.

### Full pre-implementation architecture pass

Updated `9-6-SPEC-persistence-transcripts.md` to incorporate the final review as one
coherent contract rather than a series of isolated exceptions.

Made transcript and audit persistence explicitly sink-specific. Runtime events now pass
through separate transcript and audit allowlist projections; audit schemas are concrete
and cannot inherit newly added transcript fields. Audit transitions exclude restoration
configuration, canonical history entries, summary/continuation content, and arbitrary
reason text. Transcript transition configuration remains available for restoration only
under the independent session-configuration persistence policy.

Normalized transition identity and deterministic reduction. Every canonical history
entry carries a transition kind and ID plus an optional stable reason code; capture-
controlled reason text never affects history or its digest. `target_activated` records now
carry every value needed to derive the resulting checkpoint without a fresh timestamp.
A single pure reducer folds checkpoint plus structural journal tail for writers, opening,
registry repair, cursor reads, and tests. An uncovered durable activation rebuilds its
checkpoint and is reported directly in `AgentSessionOpenResult.repairs`.

Replaced separate prepared-operation concepts with one generalized per-session maintenance
transaction covering creation, persistence reconfiguration, and deletion. The store
contract now supports prepare, constrained update, and atomic finalize operations.
Creation uses a stable creation ID, rejects every initialized destination, stages all logs,
and durably records its complete staged registry row before promotion. Direct persistent
creation uses a temporary owner-only maintenance marker because no registry is present.
The unavoidable provider/local-storage gap before a returned internal-session ID can be
recorded is stated explicitly.

Deletion now requires a stable deletion ID and expected record revision. It acquires every
configured log lock before publishing prepared deletion, then removes requested logs,
synchronizes their directories, and finalizes the tombstone or hard removal. Interrupted
deletion remains visibly `maintenance_pending` and only an identical request can resume
it. Hard removal continues to require deletion of every configured session log.

Finished configuration layering and manager invariants. Persistence merges low-to-high,
objects can explicitly re-enable a lower-layer `false`, arrays replace, capture and limits
merge as documented, and manager constraints can require or forbid transcript/audit logs
after resolution. Constraints are validation only and do not silently enable or disable
storage. Managed `persistence: false` is invalid; registry-only managed sessions disable
both logs explicitly.

Added an explicit promptability composition and blocker list spanning continuation,
recovery, configuration, persistence health, maintenance, and stopped state. Configuration
mismatch resolution is ordered: `accept_effective` persists only policy-admitted values,
while each `replace_desired` selection receives its own operation boundary and checkpoint,
so partial progress remains truthful after a crash or failure.

Hardened record-size privacy. Message records are never physically omitted, text remains
a valid Unicode string, and optional structured content can be omitted without violating
the schema. Truncation hashes now default off for every preset because low-entropy values
can be guessed from plain SHA-256; each log must explicitly enable them, after capture
filtering.

Separated snapshot cursors from navigation cursors. Every transcript/audit page returns
its inclusive high-water snapshot even when empty. Activity-state listing accepts only a
same-transcript snapshot, folds revisions through that boundary, applies status filtering
after folding, and orders deterministically by latest revision sequence plus activity ID.

Added the corresponding required tests, updated implementation order to build maintenance
and the reducer before managed restoration, and standardized “session log” to mean only a
transcript or audit log. No runtime source or tests were changed.

### Capture-schema and maintenance-completeness pass

Closed the remaining pre-implementation gaps in
`9-6-SPEC-persistence-transcripts.md`.

Added concrete transcript and audit reasoning records. Streaming reasoning is persisted
as complete monotonic snapshots under a stable reasoning ID rather than ambiguous activity
payloads or raw protocol deltas. Added a concrete transcript protocol-metadata record for
normalized initialization identity and schema-known boolean capabilities; arbitrary/raw
initialization content remains restricted to diagnostic raw records.

Made capture-independent continuation explicit. The canonical transcript reducer and the
authority section now share one exact structural-tail definition containing only
checkpoints, operation boundaries, and transition records. Configuration and lifecycle
records are presentation history; configuration/recovery changes become authoritative
only through mandatory checkpoints, so capture policy cannot alter restoration behavior.

Completed the maintenance-store contract with `getMaintenance()`, paginated maintenance
listing, and bounded completion receipts. Finalization atomically applies its session
mutation, clears the prepared marker, and stores a receipt. Exact retries are idempotent
while a marker or receipt remains; after eviction, ambiguous outcomes fail visibly rather
than being inferred. Maintenance listing makes generated managed-creation reservations
discoverable after power loss.

Narrowed the provider-thread loss window in creation. Immediately after the harness
returns an internal-session identity, creation durably records a bounded
`stagedContinuation` before writing, syncing, or installing session logs. It later records
the complete staged registry row only after logs are durable. Direct persistent creation
now requires caller-supplied logical and creation IDs so its prepared marker is always
recoverable by an identical retry.

Added durable session-log installation provenance to transcript and audit headers:
maintenance kind, operation ID, and request digest. Retry/cleanup may adopt or remove an
installed final-path log only when all provenance fields match the prepared transaction.
The spec explicitly treats this as structural transaction evidence under locks, not
tamper-resistant authentication.

Moved tombstone restoration into the same maintenance architecture. Restoration now
requires a stable restoration ID and expected record revision, records retained/disabled/
replacement log choices, stages the acquired provider thread immediately, installs logs
with matching provenance, and clears the tombstone only through atomic finalization.

Replaced ambiguous `desired` configuration with ordered `restorationTargets` carrying
`explicit_selection` or `accepted_effective` provenance and real recording time. Defined
fidelity completely: intentionally lossy policy is promptable partial restoration, exact
requires all relevant announced values to be retained, and only a failed persisted target
creates mismatch. Explicit excluded selections never bypass persistence policy.

Also corrected managed-creation ordering prose, transition IDs for mode changes and
replacements, conversation-partial wording, deletion defaults wording, and audit abort
validation. Expanded required tests and implementation order for every new invariant. No
runtime source or tests were changed.

### Bounded idempotency and final consistency tradeoffs

Applied the final clean-pass review without adding persisted high-level result objects or
a second direct-session receipt subsystem.

`prepareMaintenance()` now returns a discriminated prepared/already-prepared/already-
completed result, so callers cannot accidentally execute work after finding a completion
receipt. The contract now promises mutation idempotency only. A completed deletion retry
may return normally; non-void create/restoration/reconfiguration retries receive a typed
already-completed error and explicitly load or inspect current state rather than receiving
a fabricated original report or live object.

Bounded maintenance receipts now have both per-logical-ID and global limits (32 and 4,096)
with deterministic eviction. After eviction, an outcome that current state cannot safely
establish fails as unknown. Hard deletion may temporarily retain this content-free
operation receipt, but it is not discovery state and does not reserve the reusable logical
ID.

Made maintenance restoration requests canonicalizable without persisting content
fingerprints. Transcript reconstruction strategies carry a stable nonsecret `strategyId`;
consumer continuation carries `continuationId`. Digests cover IDs, ordering, adapter and
storage intent, but never callback identity or continuation text. A retry may rerun the
consumer behavior only before staged continuation is durable; afterward it must reuse the
recorded provider thread.

Defined uncovered-abort repair exactly using existing envelope fields instead of another
state object: required next revision, validated epoch-millisecond timestamp and canonical
ISO conversion, settled boundary semantics, covered sequence, unchanged continuation
fields, and recomputed digest.

Accepted and documented the V0 direct-creation response-gap tradeoff. Direct persistent
creation has known caller IDs and is marker-resumable before finalization; after marker
removal, a lost response is recovered with explicit `AgentSession.open()` only when a
transcript or consumer checkpoint exists, not another create or an invented original
result. Audit-only direct persistence remains non-restorable by design. Direct completion
receipts remain deferred.

Clarified that restoration-target replacement is exact and recomputes matched versus
partial fidelity, deprecated transcript options do not inherit strict v2 creation rules,
only the migration/import utility upgrades v1 transcripts, V0 offline replacement uses a
new random log ID at generation 1, and restoration is included throughout maintenance
errors/tests. No runtime source or tests were changed.

### Final reducer and identity-boundary pass

Closed the remaining four implementation gaps while deliberately keeping richer retry and
provider-reconciliation policy deferred.

Split transcript derivation into two coordinated internal folds. A full canonical-history
fold streams every `target_activated` record through the requested snapshot; a continuation
fold then uses the validated history through the selected checkpoint plus its structural
tail. The spec now defines empty-history revision/digest, exact JCS/SHA-256 input,
checkpoint validation, and the complete `TranscriptReductionResult`. Registry-only
history uses the same digest algorithm.

Made registry in-flight projection deterministic without adding another state object.
`operation(started)` now requires the exact next state revision and validated epoch-
millisecond timestamp. The fold copies prior continuation state, installs the specified
in-flight boundary, sets covered sequence, uses canonical `toISOString()`, and recomputes
the same checkpoint digest the writer publishes. Timestamp state derivation is limited to
the explicitly defined started and aborted cases.

Scoped completion receipts to logical-session incarnations using the already-existing
`creationId`. `AgentSessionRecord`, every maintenance transaction, and every receipt carry
`incarnationId`; existing-session operations must match the registry incarnation, hard-
deleted receipts never affect a fresh incarnation, and logical-ID reuse requires a new
creation ID. Migration generates a fresh incarnation as well.

Chose a fixed V0 rule for the unavoidable provider/local-storage gap rather than adding a
policy API. Manager background operations never retry provider creation. An identical
explicit create/restore retry with a matching prepared marker but no staged continuation
is authorization to repeat the provider step and accept a possible unidentified orphan.
Once continuation is staged, creating another thread or rerunning its builder is forbidden.
Adapter-aware orphan discovery/deletion and configurable fail/retry/reconcile policy remain
deferred.

Hardened direct maintenance marker paths by naming them with SHA-256 of the JCS two-ID
array and verifying actual IDs inside the owner-only marker. Clarified that navigation
cursors—not snapshot cursors—are view/filter-bound; maintenance inspection exposes
persisted recovery state rather than executable original requests; and tombstone log
replacement requires an explicit path, though deliberately reusing the prior path remains
allowed with a new identity at generation 1.

Expanded tests, implementation ordering, and deferred-work boundaries accordingly. No
runtime source or tests were changed.

### Incarnation fencing and reducer-boundary pass

Closed the final three transaction/reducer inconsistencies without introducing another
identity or transaction abstraction.

Made the already-persisted `incarnationId` the public ABA token. Checkpoints, live
`AgentSession` objects, session summaries, and maintenance summaries expose it, and every
existing-session maintenance request now requires `expectedIncarnationId` alongside the
record revision. Store updates/finalization validate the same incarnation, so a delayed
mutation for a hard-deleted incarnation cannot affect a new session which reused its
stable logical ID—even if their record revisions happen to coincide. Incarnation mismatch
uses the existing typed maintenance-conflict path rather than adding another error class.

Added one common `baseRecordRevision` fence to all prepared maintenance values: `null` for
creation and the exact pre-operation revision for restoration, persistence
reconfiguration, and deletion. Ordinary record saves/deletes atomically reject while a
maintenance marker exists. Finalization verifies the marker's incarnation and base
revision before applying its single mutation. This makes the documented registry-only
delete/checkpoint race enforceable and prevents a late live-session checkpoint from
crossing prepared maintenance or resurrecting a deleted record.

Corrected the transcript fold boundary. The history fold now consumes activations only
through the selected checkpoint's inclusive `coveredSequence`; the continuation fold
receives only structural records after it. Post-checkpoint activations are therefore
applied exactly once. Activation from a null internal-session identity installs the new
target without appending history or changing its revision/digest.

Updated the public method examples, storage contract, deletion/restoration prose, tests,
and implementation order to make these constraints directly implementable. No runtime
source or tests were changed.

### Physical checkpoint boundary and migration-authority pass

Corrected the remaining checkpoint self-tail problem while preserving the useful meaning
of `coveredSequence`. The continuation reducer now receives the selected physical
`TranscriptCheckpointRecord`; its base is that record's checkpoint and its tail begins
strictly after the containing record's `seq`. `coveredSequence` remains the logical state
coverage boundary used by deterministic started/activation/abort projection. Added exact
record/checkpoint invariants for revision, logical/transcript identity, generation,
normalized path, incarnation, and the absence of intervening structural records. This
also makes repaired checkpoints valid without forcing a second state revision merely to
materialize them.

Defined the previously missing v1-to-v2 authority boundary without adding a history-seed
record. The explicit migration utility requires a complete continuation seed matching
`StagedContinuationState`, appends an upgrade header and canonical initial checkpoint,
then publishes a registry projection only when configured. The migrated checkpoint starts
at state revision 1 with a settled boundary, no prior transition/metering state, and empty
canonical internal-session history. The v1 prefix remains pageable presentation history
but never becomes v2 continuation or history-fold authority. Header-only interruption is
an incomplete migration rejected by ordinary open and resumable through the migration
utility. Lossless legacy routing-history import remains explicitly deferred.

Added one shared `PersistedMachineCode` contract instead of enumerating harness-specific
codes. Persisted reason/error codes must match a bounded ASCII identifier grammar;
provider or consumer prose, paths, commands, whitespace, and oversized values cannot use
those fields. Unknown provider values normalize to `unknown`, while readable details are
subject to their ordinary capture policy before transcript/audit projection.

Updated reducer, checkpoint, migration, security, and deferred-work tests accordingly. No
runtime source or tests were changed.
