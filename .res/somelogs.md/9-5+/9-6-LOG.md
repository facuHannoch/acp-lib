
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

## Implementation

### Part 1A — persistence configuration normalization

Started implementation with the policy/configuration foundation required before either
session-log writer can safely persist data.

Added `src/persistence/config.ts` with the public persistence configuration types and an
internal deterministic resolver for direct and managed sessions. Direct omission/`false`
remains no-persistence; an explicit direct configuration and managed sessions start from
the specified activity transcript, typed session-configuration, disabled audit-log, and
bounded-size defaults. Root resolution follows explicit input, `ACP_CLIENT_HOME`, then
`~/.acp-client`.

Implemented the specified layer semantics rather than shallow spreading: preset changes
reset transcript capture before same-layer overrides; member overrides inherit without a
new preset; arrays replace rather than concatenate; a higher object re-enables a lower
disabled log from library defaults; and a highest-priority `false` remains final. Manager
constraints validate the completed result without silently changing it. Managed layers
cannot supply a competing root.

Added hard-range validation for record, field, depth, and cursor limits; validation for
capture values, paths, booleans, configuration IDs, and constraints; immutable/detached
resolved policies; and runtime rejection of unknown nested fields so JavaScript callers
cannot smuggle arbitrary values into a future persisted header. Only the consumer-facing
configuration types and typed `PersistenceConfigurationError` are exported from the
package root; resolution helpers remain an implementation detail.

Added `test/persistence-config.test.ts` with 13 tests covering defaults, every preset,
layer precedence, disable/re-enable behavior, array replacement, constraints, hard
limits, root precedence/tilde expansion, runtime unknown-field rejection, and immutable
input detachment. The focused suite passes (13/13) and `tsc --noEmit` passes.

The complete existing test suite was also attempted. It is presently blocked in this
sandbox by pre-existing environment-dependent tests: `Bun.serve({ port: 0 })` fails with
`EADDRINUSE` in `metering-live-catalog.test.ts`, and ACP fixture subprocess startup tests
time out/close their connection. Running each affected file alone reproduces the same
failure; neither imports nor exercises the new persistence resolver.

### Part 1B — session-log path resolution

Added `src/persistence/paths.ts`, the filesystem-dependent step deliberately kept separate
from policy merging. It resolves omitted transcript/audit destinations under the effective
root, interprets an explicitly supplied existing directory as a library-named destination,
uses existing regular files and nonexistent paths exactly, normalizes relative and `~/`
paths, and returns absolute transcript/audit paths without creating filesystem objects.

The default resolver rejects direct and ancestor symbolic links, non-file/non-directory
objects, blank logical IDs, and transcript/audit aliases. Alias detection covers both the
same normalized path and distinct hard-link paths identifying the same existing file.
Disabled logs resolve to `null`. These checks happen before a writer or harness needs to
start.

Added `test/persistence-paths.test.ts` with seven focused tests covering the default
layout, directory-derived names, exact file/nonexistent behavior, relative and home
expansion, direct/ancestor symlink rejection, normalized-path and hard-link collision,
and disabled logs. The combined phase-1 configuration/path suite passes 20/20 and
`tsc --noEmit` passes.

### Part 1C — canonical integrity primitives

Added `src/persistence/integrity.ts` with strict RFC-8785-style canonical JSON generation,
lowercase SHA-256 canonical digests, checkpoint digest computation/verification that
excludes exactly the `digest` member, and the shared bounded `PersistedMachineCode`
contract. Checkpoint digest calculation and verification plus its typed serialization
error are exported for consumers that persist/validate their own checkpoints; lower-level
canonicalization and provider-code normalization remain internal module utilities.

Canonicalization sorts object keys recursively, preserves array order, uses ECMAScript
JSON number/string serialization, accepts repeated noncyclic references, and rejects
non-finite numbers, unsupported values, sparse arrays, non-plain objects, symbols, cycles,
lone UTF-16 surrogates, and values beyond the configured depth. Provider-originated prose
normalizes to the stable `unknown` machine code, while structural consumer/library codes
fail validation rather than silently changing meaning.

Added `test/persistence-integrity.test.ts` with nine focused tests including a known
canonical SHA-256 vector, checkpoint mutation detection, invalid/lossy JSON cases,
repeated references, exact machine-code bounds, and provider-prose normalization. The
combined phase-1 foundation suite now passes 29/29 and `tsc --noEmit` passes.

### Part 1D — continuation checkpoint contract

Added `src/persistence/checkpoint.ts` with the bounded, versioned continuation-state
schema and the public create/validate boundary. Checkpoint creation clones the input,
canonicalizes every JSON value through the shared integrity implementation, computes the
digest over all fields except `digest`, and validates the resulting artifact before
returning it. Restored checkpoints are checked before use for version, digest, logical
session and incarnation identity, adapter identity, state/history revisions, transcript
identity/generation/path, protocol shape, boundary shape, canonical timestamps, and
optional expected values supplied by the opener.

Runtime validation now covers the cross-field invariants that TypeScript cannot enforce:
internal-session identity and activation time appear together; activation and transition
times cannot postdate the checkpoint; configuration adapter identity matches the active
adapter; announced/omitted IDs are unique; omitted IDs were actually announced; exact
configuration fidelity cannot claim omitted values; restoration targets have unique IDs,
valid types/sources/timestamps, and strictly increasing ordinals. Optional metering state
is accepted only when the existing metering-state restoration validator accepts its
version, structure, and logical-session identity.

Exported the checkpoint types, constructor, validator, and typed validation error through
the package root so a consumer-managed store can persist and verify the same continuation
unit as the library-managed path. Added `test/persistence-checkpoint.test.ts`; the combined
phase-1 foundation suite passes 36/36 and `tsc --noEmit` passes.

### Part 1E — sink-specific session-log schemas

Added `src/persistence/records.ts` with distinct transcript-v2 and audit-v1 envelopes and
concrete record unions. The transcript schema includes headers, checkpoints, durable
operation boundaries, messages, coalesced reasoning snapshots, activity revisions,
configuration, permissions, transitions, metering references, lifecycle, normalized
protocol metadata, and diagnostic raw records. The audit schema deliberately defines its
own allowlisted operation/reasoning/activity/configuration/permission/transition/metering/
lifecycle records; it has no generic projection from transcript records and cannot accept
messages, checkpoints, raw protocol payloads, restoration configuration, history entries,
transition summaries, or consumer reason text.

Added runtime validators for both sinks. They validate versions and discriminants,
logical/log identity, generations and sequences, bounded canonical JSON, timestamps,
truncation metadata, exact header policy/limit shapes, installation provenance, safe
machine codes, operation-abort presence rules, and required operation correlation.
Transcript checkpoint records validate their complete checkpoint payload and enforce
record/payload revision, identity, path, generation, and physical-versus-covered sequence
invariants. Transition validation keeps audit descriptors content-free and validates the
transcript's restoration configuration, activation state, history identity, and exact
prior-session descriptor match. Protocol capabilities are normalized boolean leaves in
lexical key order.

Made the already-existing resolved capture-policy and persistence-limit validators
reusable by record-header validation rather than duplicating the preset matrix. Exported
the record validators, error, and consumer-facing schema types from the package root.
Added `test/persistence-records.test.ts` for terminal-boundary semantics, checkpoint
identity, header installation/upgrade rules, audit isolation, machine-code/truncation
validation, and prohibited audit record kinds. The complete phase-1 persistence suite
passes 42/42 and `tsc --noEmit` passes.

### Part 2A — strict registry contract and record authority

Started the registry phase alongside the existing permissive `SessionStore`; the old
file-per-session routing catalog has not been silently upgraded to claim atomic/CAS
semantics it does not implement. Added `src/persistence/registry.ts` with the public
`AgentSessionStore` compare-and-swap contract, incarnation-aware session records, all four
prepared maintenance variants, staged continuation state, bounded-receipt shapes,
discriminated preparation results, listing summaries/options/pages, and typed conflict/
maintenance errors.

Defined and tested registry record validation before implementing the physical store.
The validator checks canonical JSON, checkpoint identity/digest, record revision, exact
materialized routing/configuration/protocol projections, complete internal-session history
revision and canonical digest, absolute transcript/audit locations, transcript identity
agreement, exact stored policy/limit shapes, and canonical lifecycle timestamps. The
history digest is computed over the canonical entry array and remains separate from the
bounded checkpoint as required by the transcript reducer design.

Exported the strict record/store/maintenance/listing types and validation utilities from
the package root. Added `test/persistence-registry.test.ts` with registry-only authority,
projection disagreement, complete-history consistency, and transcript projection tests.
This subpart passes 4/4 and `tsc --noEmit` passes. The atomic full-JSON store, receipt
retention, CAS/maintenance transaction implementation, and cursor pagination remain the
next part; no live `SessionManager` behavior uses this contract yet.

### Part 2B — atomic full-JSON registry store

Added `src/persistence/file-registry-store.ts`, a separate strict implementation of
`AgentSessionStore` using the specified `agent-sessions.json` primary, synchronized
temporary sibling, and `agent-sessions.json.bak`. Mutations acquire a cross-process
exclusive lock, reread the latest registry under that lock, apply one transaction,
increment the global revision, fsync owner-only temporary files, preserve the last valid
primary as a synchronized backup, atomically rename, and synchronize the directory.
Readers visibly recover through an optional notice when the primary is invalid and the
backup validates. A recovery-origin mutation never copies the corrupt primary over the
valid backup.

Implemented strict per-record CAS and incarnation checks, maintenance fencing for ordinary
saves/deletes, discriminated prepare retries, monotonic maintenance staging, exact staged
record publication, atomic finalization/receipt insertion, hard deletion, and
incarnation-scoped idempotency. Creation/restoration must durably stage continuation
before staging their complete record; only deletion maintenance may finalize by removing
the registry record. Completion receipts are capped at 32 per logical ID and 4,096
globally. A late deletion retry for an older incarnation resolves through its receipt and
cannot affect a new incarnation reusing the same logical ID.

Added revision-bound opaque pagination for agent-session and maintenance lists, including
deterministic ordering, tombstone/maintenance visibility rules, limits, and stale cursor
rejection. Lock reclamation requires positive proof that the owning PID no longer exists;
elapsed age alone never permits stealing a live lock. Lock release checks its random token
before unlinking.

Added `test/persistence-file-registry-store.test.ts`. Tests cover CAS, two independent
writers without lost updates, staging/fencing/finalization and retry receipts, backup
recovery without backup destruction, revision-invalidated pagination, live-versus-dead
lock behavior, and stable-ID ABA protection. The complete focused persistence suite
passes 53/53 and `tsc --noEmit` passes.

### Part 2C — managed registry inspection surface

Extended `SessionManager` without changing adapter ownership or silently upgrading the
legacy catalog. `SessionManager.open()` now constructs (or accepts) a strict
`AgentSessionStore`, resolves the manager root, and retains only persistence defaults and
constraints. It does not resolve adapters and does not retain live `AgentSession`
instances. Existing `new SessionManager(legacyStore)` behavior remains available for the
current CLI/AgentSession integration and fails with a typed mode error if asked to perform
strict managed-registry operations.

Added `listAgentSessions()`, `getAgentSessionInfo()`, `getSessionMaintenance()`, and
`listSessionMaintenance()` as direct manager-facing views over the strict store. Metadata
lookup honors tombstone/prepared-deletion visibility, exposes incarnation and maintenance
state, and never starts a harness. Added manager/per-session persistence normalization so
the upcoming managed create/load paths share the already-tested defaults, layer merge,
and constraint enforcement. Moved session-summary materialization to the registry module
so custom stores and the manager use the same lifecycle/recovery projection.

Added `test/session-manager-managed.test.ts` covering strict open and metadata discovery,
default/per-session policy merging, constraint enforcement, prepared-deletion visibility,
maintenance inspection, and explicit compatibility-mode rejection. The focused managed
and legacy manager suites pass 6/6 and `tsc --noEmit` passes. Managed creation/loading are
not yet exposed; they require the session-log writer and creation transaction coordinator
rather than a best-effort record after `AgentSession.create()`.

### Part 3A — lifetime-owned physical session-log writer

Added `src/persistence/session-log-writer.ts` as the bounded physical sink shared by the
future transcript and audit projections. A new writer requires an absolute resolved path,
claims only an absent or zero-byte regular destination, installs and validates the exact
versioned header as sequence 1, keeps a cross-process lock for its complete lifetime, and
creates parent/log/lock artifacts owner-only. A second live writer receives a typed in-use
error; dead locks are reclaimed only after positive PID liveness failure and token
revalidation.

Every append is serialized, validates the complete sink-specific record schema plus
logical/log/generation identity, requires the exact next sequence, measures UTF-8 bytes
without the newline, and enforces the same `maxRecordBytes` engraved in the header.
Callers explicitly select durable boundaries; `sync()` and `close()` flush outstanding
work. Schema/sequence/size rejection occurs before writing and does not poison the queue,
while an append or synchronization failure after bytes may have reached the file
permanently poisons that writer so later writes cannot hide a corrupt or uncertain tail.

Added `test/persistence-session-log-writer.test.ts` covering owner-only creation and
durable append, sequence and identity rejection with queue recovery, initialized versus
zero-byte destinations, pre-write size rejection, and lifetime lock exclusion. The writer
suite passes 5/5 and `tsc --noEmit` passes. This subpart deliberately creates only new
generations; opening/scanning an existing generation belongs with the reducer/reader.
Capture filtering, independent transcript/audit projection, and bounded truncation remain
the next subpart.

### Part 3B — independent pre-serialization capture projection

Added `src/persistence/projection.ts` with one explicit normalized runtime-event union and
two independent pure projections. Transcript and audit records are constructed separately;
there is no generic transcript-to-audit mapper. Both results are detached from mutable
input before a writer can enqueue them.

Tool activity is classified before projection into a closed content-free metadata shape,
invocation `input`, and returned `content`. Capture levels are cumulative, but metadata
cannot carry arbitrary keys, titles, paths, commands, patches, or output. The default
activity transcript therefore retains only structural tool identity/status/timing; the
default audit policy adds invocation input but not results; detailed/content policies add
results. Conversation messages never enter audit. Reasoning, configuration definitions,
full permission details, metering summaries, lifecycle detail, protocol metadata, and raw
traffic each require their precise policy level.

Transcript transition routing/activation/history remains structural even when transition
presentation is disabled; summary and consumer reason text require content capture. Audit
transition projection rebuilds an explicit descriptor containing only internal identity,
adapter, mode, model, and protocol, so restoration configuration, activation timestamps,
history entries, summary, and reason text cannot cross into that artifact. Normalized
protocol capability keys are emitted in lexical order; raw protocol payloads remain
diagnostic-transcript-only.

Added `test/persistence-projection.test.ts` with direct leak assertions across metadata,
input, and content tool levels; transcript/audit message and reasoning separation;
structural transition retention and audit stripping; configuration/permission levels;
and normalized-versus-raw protocol capture. Every projected result is also passed through
its concrete record validator. The projection suite passes 5/5 and `tsc --noEmit` passes.

### Part 3C — bounded post-policy record truncation

Added `src/persistence/truncation.ts` as the single size-bounding step between capture
projection and physical serialization. It validates the engraved limits, clones rather
than mutates projected records, truncates strings only at Unicode code-point boundaries,
and replaces oversized structured capture as a whole with an explicit omitted marker.
The order is deterministic and prioritizes raw payloads, tool results, reasoning, tool
input, and message presentation before less common captured detail. Structural identity
is never shortened to make a record fit; a record whose structural remainder exceeds the
bound fails with `SessionLogTruncationError`.

Maximum JSON depth is represented as an explicit `max_depth` omission only for captured
values that genuinely cross the configured depth. Cyclic or otherwise non-JSON values
fail rather than being mislabeled as truncation. Optional SHA-256 metadata is generated
only from values already admitted by capture policy. An integration test projects a tool
event at metadata level and verifies that excluded command/output secrets and their hash
cannot appear after truncation, including when truncation digests are enabled.

Integrated the truncator into `FileSessionLogWriter` before validation and append. The
writer takes its limits and digest choice from the installed header, so reopen cannot
silently change either. The previously resolved `includeTruncationDigests` option is now
engraved in transcript/audit headers and registry metadata; the persistence spec was
updated to match this necessary continuation/configuration fact.

Added `test/persistence-truncation.test.ts` for Unicode-safe text bounds, whole-value tool
output omission and optional hashes, record-level fitting, deep captured values, invalid
JSON rejection, and structural oversize failure. Extended projection and writer tests for
security ordering and physical integration. The complete persistence/manager-focused
suite passes 76/76, `tsc --noEmit` passes, and `git diff --check` is clean.

### Part 4A — canonical transcript history and continuation reducer

Added `src/persistence/reducer.ts` with the two pure folds required by the persistence
contract. `reduceTranscriptHistory()` consumes canonical target activations in physical
sequence order, validates one log identity and a continuous routing chain, rejects repeat
activation IDs, and computes the exact JCS/SHA-256 history digest (including the exported
empty-history constant). `reduceTranscriptState()` begins at the physical checkpoint
record—not merely its covered state sequence—and folds only later structural records, so
a checkpoint can never consume itself as tail input.

The continuation fold validates its supplied history result rather than trusting its
revision/digest, preserves logical/log/incarnation identity, and prevents checkpoints
from changing provider routing without a durable target activation. A `started` operation
produces the exact deterministic in-flight checkpoint; a physical materialization must
match it byte-for-byte at the canonical JSON level. Ordinary terminals remain uncertain
until a later advancing checkpoint covers the exact terminal sequence. Durable
pre-dispatch aborts produce deterministic settled checkpoints and an explicit repair;
interrupted/in-flight boundaries remain conservatively uncertain.

Target activation verifies the complete `from` descriptor against current reduced state,
adds the exact history entry when present, installs the new descriptor using only the
persisted activation state, and reports a repair only when its materialized checkpoint is
missing. Materialized activation/abort checkpoints must exactly equal the pure reduction;
same-revision disagreement, sequence regression, duplicate starts/terminals, cross-log
tail records, unexplained routing changes, and history mismatch fail closed with
`TranscriptReductionError`. The fold performs no I/O, harness calls, notification work,
or fresh clock reads.

Added `test/persistence-reducer.test.ts` covering independent history hashing, selected
checkpoint consistency, uncovered and materialized activation, dirty operation boundary
classification, exact in-flight materialization, deterministic abort repair, and major
corruption cases. The complete persistence/manager-focused suite passes 82/82,
`tsc --noEmit` passes, and `git diff --check` is clean.

### Part 4B — bounded physical transcript continuation scan

Added `src/persistence/transcript-scanner.ts` as the first filesystem consumer of the
canonical folds. `scanTranscriptContinuation()` opens only an absolute regular file,
captures a byte-size snapshot, reads it in fixed 64 KiB chunks, accepts only complete
newline-terminated records, and ignores an incomplete final suffix while reporting its
exact byte count. A line is bounded before UTF-8 decoding or JSON parsing—first by the
library hard ceiling and then by the header's engraved `maxRecordBytes`. UTF-8 decoding
is fatal rather than replacement-based.

The scanner requires an exact sequence beginning with one validated header, enforces a
stable logical/log/generation identity, supports explicit expected-identity checks, and
distinguishes not-found, unavailable, corrupt, and identity failures. Recognized records
receive the concrete transcript validator. A valid same-version unknown display record
may be skipped without weakening envelope, sequence, canonical-JSON, or identity checks.

Every physical checkpoint is validated incrementally against the prior checkpoint and
its structural tail, rather than trusting only the newest record. Target activations are
folded through each checkpoint's covered sequence, then the latest physical checkpoint
and remaining tail are returned with the canonical reduction. This catches corruption in
an older structural interval even when a later checkpoint exists and preserves the
physical-checkpoint versus covered-state sequence distinction.

Added `test/persistence-transcript-scanner.test.ts` covering bounded streaming with a torn
tail, successive checkpoint-chain validation, unknown display records, distinct malformed
and identity errors, missing files, deterministic abort repair, and recovery status. The
complete persistence/manager-focused suite passes 87/87, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 4C — exclusive resume of an existing transcript generation

Extended `FileSessionLogWriter` with `resumeTranscript()`. Resume rejects missing,
non-regular, symbolic, or relative targets; acquires the same lifetime ownership lock as
creation; scans the generation through the bounded continuation scanner; and verifies
that the owned descriptor still names the inspected inode at the exact scanned snapshot
size. It therefore cannot validate one file and unknowingly append to a replacement.

An incomplete final suffix is truncated only after exclusive ownership is established,
then synchronized before append resumes. The writer inherits capture limits and the
truncation-digest choice from the installed header, starts at the scanner's last complete
physical sequence, and retains append-mode semantics for all later records. The resume
result also returns the exact continuation reduction and scan metadata, avoiding a second
independent restoration interpretation.

Extended the scanner result with its captured physical byte size and added an integration
test that resumes a transcript with a torn suffix, confirms the next sequence, appends a
durable operation record, and verifies that only three complete JSON records remain. The
scanner/writer suites pass 11/11 and `tsc --noEmit` passes.

### Part 5A — live v2 transcript operation runtime

Added `src/persistence/transcript-runtime.ts` as the provider-independent live boundary
that `AgentSession` operations will share. Resume takes exclusive ownership through the
existing scanner/writer path, materializes any deterministic activation/abort checkpoint
repair before returning, exposes the current checkpoint/recovery/opening repairs, and
refuses new dispatch while recovery is uncertain.

`beginOperation()` writes and synchronizes the write-ahead start before a caller may reach
the harness, then derives its in-flight checkpoint through the canonical reducer.
`appendEvent()` applies the installed transcript capture policy before enqueue and rejects
target activation through this generic surface. `syncBeforeDispatch()` lets callers make
policy-admitted input durable after the start boundary. `finishOperation()` writes a
terminal plus advancing checkpoint and verifies the complete interval with the reducer;
`abortOperation()` performs the corresponding deterministic pre-dispatch compensation.
Both terminal paths poison the runtime on partial failure so retry cannot append a second
terminal and make the generation ambiguous.

Terminal checkpoint updates are deliberately restricted to model, session-configuration,
metering, and an explicit boundary; ordinary operations cannot silently change provider
routing. Undefined optional changes preserve existing checkpoint state. The runtime owns
no provider calls and accepts no conversation content except through the normalized
capture projection.

Extended the scanner contract with the history reduction at its selected physical
checkpoint and exported the identical registry/runtime history hashing function. Added
end-to-end tests for a live prompt boundary with captured user content, clean rescan and
matching checkpoint digest, plus durable abort compensation that rescans with no pending
repair. The complete persistence/manager-focused suite passes 90/90, `tsc --noEmit`
passes, and `git diff --check` is clean. `AgentSession` is not yet wired to this runtime;
that is the next subpart.

### Part 5B — durable transition activation boundary

Extended `TranscriptPersistenceRuntime` with explicit transition APIs rather than letting
callers send routing changes through the generic event path. Non-activation phases use
`appendTransitionEvent()` and default to a durable boundary. `activateTransition()`
requires clean recovery and no active provider operation, writes the structural
`target_activated` record durably, derives its checkpoint and complete canonical history
through the shared reducer, writes the materialized checkpoint durably, verifies the
materialization, and only then returns the new continuation checkpoint.

Generic `appendEvent()` now rejects every transition, preventing an apparently harmless
display write from bypassing continuation-state updates. Activation failure poisons the
runtime; a caller cannot continue on an in-memory target after only part of the durable
routing transition succeeded. The runtime's installed history is replaced from the
reducer result so later transitions append to exactly the history that was persisted.

Added an end-to-end handoff-shaped activation test: transition start, durable target
activation, materialized checkpoint, close, full physical rescan, current-target check,
canonical prior-thread history check, and confirmation that no repair remains. The
complete persistence/manager-focused suite passes 91/91, `tsc --noEmit` passes, and
`git diff --check` is clean. This completes the persistence primitive needed for wiring
AgentSession prompts and handoffs without separate sequencing implementations.

### Part 5C — live activity persistence classification

Added `persistenceEventFromActivity()` as the narrow adapter between the existing folded
activity stream and the v2 persistence projection. Thinking revisions become explicit
reasoning records; tool identity/status remain structural metadata while raw arguments
and results occupy their separate capture buckets; and other activity payloads remain
content. The adapter deliberately performs no serialization or hashing, preserving the
security invariant that capture filtering discards excluded sensitive values before the
writer examines them.

Added focused tests proving that the activity preset retains tool lifecycle metadata
without private arguments/results, detailed capture admits reasoning and tool content,
and plan payloads remain excluded at the activity level. The projection tests pass 9/9,
`tsc --noEmit` passes, and `git diff --check` is clean. This is the final classification
primitive needed before connecting the v2 runtime to `AgentSession` notifications.

### Part 5D — new transcript-generation runtime boundary

Extended `TranscriptPersistenceRuntime` with `create()`, giving live-session integration a
single owner for both new and resumed v2 generations. Creation validates the initial
checkpoint before touching the destination, installs and durably synchronizes the header
through the existing exclusive writer, appends the initial checkpoint durably, and runs
the canonical reducer before returning a usable runtime.

The boundary requires exact header/checkpoint identity, an empty canonical history, a
settled no-operation boundary, and `coveredSequence` equal to the header sequence. It
deliberately leaves cleanup after a partially installed valid generation to the enclosing
creation transaction, whose installation provenance is the authority for safe cleanup.

Added tests for a generation that closes and fully rescans with the identical checkpoint,
plus rejection of an invalid initial coverage boundary before file creation. The scanner
and runtime suite passes 11/11, `tsc --noEmit` passes, and `git diff --check` is clean.

### Part 5E — session-configuration continuation snapshots

Added `snapshotSessionConfiguration()` to convert the harness's complete advertised
configuration map into the bounded checkpoint model. The snapshot sorts announced IDs,
hashes the ID/type/selectable-value schema deterministically, applies the configured
value policy before inspecting current values, records policy omissions explicitly, and
derives exact/partial restoration fidelity. A nonempty `include` is treated as an
allowlist; `exclude` always wins; typed mode admits booleans, valid advertised selections,
and explicitly included unknown options only.

Existing ordered restoration targets are preserved only when the same persistence policy
admits them. Non-JSON runtime values are reported as omitted instead of being coerced or
allowed to corrupt a checkpoint. Tests cover typed capture, unknown-value opt-in,
exclusion and malformed values, and insertion-order-independent schema digests. The
configuration/checkpoint tests pass 11/11, `tsc --noEmit` passes, and `git diff --check`
is clean.

### Part 6A — direct AgentSession transcript-v2 prompt path

Added the first public v2 lifecycle slice to `AgentSession.create()`. An explicit
`persistence` configuration remains opt-in and cannot be mixed with deprecated
`transcriptPath`/`transcriptDir` or the compatibility `sessions` catalog. Direct v2
persistence requires caller-retained `agentSessionId` and `creationId`; the latter is the
checkpoint incarnation. Audit-log creation is rejected explicitly until its independent
writer coordination is implemented.

Transcript paths and policy are resolved before harness startup. The runtime now accepts
an initializer callback only after it owns and has durably written the header, so the
provider thread cannot be created before the local transcript boundary exists. The first
checkpoint captures the provider ID, model, ACP/PTY protocol, metering state, filtered
session configuration, empty canonical history, and exact transcript identity.

Prompt execution now opens metering preflight before minting a durable operation, then
writes `operation(started)` plus the policy-admitted user message and synchronizes them
before provider dispatch. Folded live activity is projected through the v2 security
buckets. Completion drains activity, records the assistant response and metering
reference, and durably publishes the terminal/checkpoint pair with updated model,
configuration, and metering state. Pre-dispatch persistence failures attempt the required
aborted compensation; dispatched failures retain partial response/activity and a failed
terminal. Legacy transcript behavior remains unchanged.

Handoff, mode changes, configuration changes, and metering reconciliation currently fail
closed on a v2-backed session instead of silently mutating continuation state without a
checkpoint; their dedicated transition/configuration paths are subsequent parts.

Added an end-to-end subprocess test that creates a v2-backed `AgentSession`, prompts it,
stops it, rescans the transcript, verifies clean recovery and the advanced checkpoint,
and checks the physical record order. Added a runtime ordering test proving the header is
installed before provider initialization executes. The new runtime/AgentSession tests
pass 7/7, the full legacy AgentSession transcript/state regression set passes 20/20 when
run outside the restricted subprocess sandbox, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 6B — durable AgentSession handoff transitions

Wired v2-backed handoffs through the transition journal and the ordinary operation
runtime. A transition writes `started`; optional summary generation runs as a durable
`handoff_summary` operation on the old thread; provider creation writes `target_created`;
and `target_activated` durably installs the new descriptor, deterministic activation
checkpoint, and exact prior-thread history entry before the logical session publishes the
new internal ID. Continuation seeding then runs as its own durable `handoff_seed`
operation, followed by `completed`.

Failure handling is phase-aware. A failure before activation leaves the old logical
routing intact. A seed failure after activation writes a failed transition with
`failedAfter: "target_activated"` while retaining the already committed new thread and
canonical history. If the harness switches but activation persistence fails, the runtime
is poisoned and the logical session does not pretend the uncommitted target was safely
installed.

The library-internal prompt helper now uses the same metering preflight, durable
start/input boundary, response and metering projection, and terminal checkpoint path as a
consumer prompt. This closes the previous hole where handoff summary/seed inference was
metered but could bypass transcript-v2 operation evidence.

Also corrected the transition runtime's TypeScript contract: activation and
non-activation inputs are now explicit refinements of the normalized transition event,
rather than an `Extract` over a non-discriminated event-property union that collapsed to
`never` in production sources.

Added subprocess end-to-end tests for successful v2 activation and post-activation seed
failure. Both close and rescan cleanly, retain the previous thread exactly once, expose
the replacement as current, and contain the expected transition/operation sequences.
The two v2 cases pass 2/2; the complete handoff and handoff-metering regression suites
pass 9/9; `tsc --noEmit` and `git diff --check` pass.

### Part 6C — serialized durable session configuration

Changed `AgentSession.setConfig()` from an unsynchronized controller proxy into a queued
session operation. Configuration changes now serialize with prompts and handoffs, expose
the `configuring` busy phase, and emit ordered started/completed/failed lifecycle
notifications. Queue cancellation rejects a configuration change that never dispatched
without creating persistence or metering evidence.

For v2 transcripts, `setConfig` writes and synchronizes an operation start before the ACP
request. A successful response is treated as the complete current announcement: the
library recomputes its schema digest and filtered effective values, engraves the explicit
selection as an ordered restoration target when policy admits it, projects a
policy-filtered configuration record, and durably publishes the settled checkpoint before
resolving. The first-class model and metering snapshot are updated in the same checkpoint.
A harness rejection closes the operation as failed and preserves prior restoration state.

Added `snapshotSessionConfigurationAfterSelection()`. Restoration targets remain unique;
reselecting an option moves it to the end with a monotonically increasing ordinal so the
recorded restoration order matches the most recent successful application order.
Excluded, non-JSON, or otherwise policy-rejected values cannot enter either the checkpoint
or configuration display record merely because they were explicitly selected.

Added a dedicated ACP configuration fixture plus end-to-end success and rejection tests.
They verify the live model, persisted effective value, restoration target, lifecycle
notifications, operation/configuration records, unchanged state after rejection, and clean
reduction after close. The v2 setConfig suite passes 2/2, configuration-state tests pass
5/5, the persistence/manager suite passes, `tsc --noEmit` passes, and `git diff --check`
is clean.

### Part 6D — durable mode changes and metering reconciliation

Changed `AgentSession.setMode()` into a queued session transition so it serializes with
prompts, handoffs, and configuration changes. Mode replacement now exposes the
`switching_mode` busy phase plus started/completed/failed lifecycle notifications. A
queued mode change cancelled before dispatch produces no persistence evidence.

For v2-backed sessions, a real mode replacement records `started`, `target_created`,
`target_activated`, and `completed`. Target activation durably installs the new mode,
protocol, internal-session identity, and the prior ACP thread's canonical history entry
before the logical session publishes the replacement identity. Moving to degraded PTY
therefore records a valid null internal-session ID instead of pretending the previous ACP
thread is still current. Failures retain phase-aware transition evidence and do not
publish an uncommitted target as logical session state.

Added standalone checkpoint publication to the transcript runtime for non-routing state
changes made while no provider operation is active. It advances the state revision,
keeps the state-changing covered sequence unchanged, appends the physical checkpoint
durably, verifies it through the canonical reducer, and poisons the runtime if publication
fails. Ordinary projected and transition append failures now poison the runtime as well,
preventing later writes from continuing after an unknown persistence boundary.

Mode replacement now clears both the live and serialized metering baseline for the old
provider thread and publishes that cleared state. `reconcileMetering()` uses the same
standalone-checkpoint primitive: the validated replacement state is made durable before
the in-memory engine changes or reconciliation notifications are emitted, without
manufacturing a provider operation or metering record.

Added end-to-end tests for an ACP-to-PTY mode replacement and durable metering
reconciliation, plus a runtime test for standalone checkpoint publication. The focused
mode/reconciliation suite passes 2/2, the targeted metering and persistence suites pass
208 tests, the complete repository suite passes 595/595, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 7A — direct transcript-backed AgentSession open

Added the first checkpoint-based restoration entry point, `AgentSession.open()`. This
slice deliberately implements only the safest default continuation strategy: acquire and
validate the authoritative v2 transcript under its writer lock, validate logical,
incarnation, adapter, transcript, and optional consumer-checkpoint identity, and ask the
supplied adapter to load exactly the recorded non-null ACP internal-session ID. It never
falls back to `session/new`. A failed load throws `ContinuationUnavailableError` with the
partial continuation report and releases transcript ownership so a later retry can open
the session.

Successful opens return `AgentSessionOpenResult` with the continuation attempt/outcome,
transcript recovery status, configuration restoration status, derived promptability, and
any deterministic repairs made while acquiring the transcript. Conversation availability
now distinguishes captured, partially truncated, and uncaptured message history; the
streaming scanner derives truncation without loading transcript content wholesale.

Opening restores the checkpoint's metering state and then reapplies persisted ACP
configuration targets once in ordinal order. Each required reapplication is its own
durable `set_config` operation and emits a policy-filtered `restored` configuration
record. Missing, changed, rejected, or residually different targets become an explicit
configuration mismatch instead of silently returning a differently configured agent.
Policy-partial state remains promptable.

Added the public promptability composition and typed `AgentSessionPromptBlockedError`.
Prompts, harness slash commands, handoffs, mode changes, and configuration changes now
refuse to dispatch when transcript recovery is uncertain, configuration restoration is
mismatched, or v2 persistence is poisoned. The same immutable value is exposed on the
session and its state snapshot.

This is intentionally not the whole Phase 5 surface. Exact-file identity inference,
registry-only/direct-checkpoint opening, explicit transcript/consumer reconstruction
strategies, recovery resolution, configuration-mismatch resolution, and manager-backed
load remain later slices.

Added end-to-end cases for successful load plus configuration reapplication, unavailable
thread reporting and retry, uncertain-boundary prompt blocking, and disappeared-option
mismatch blocking. Added scanner coverage for truncated conversation detection. The
focused restoration suite passes 6/6, scanner tests pass 14/14, the complete repository
suite passes 600/600, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 7B — configuration-mismatch resolution

Added the queued `resolveConfigurationMismatch()` API and both specified resolution
strategies. Resolution is allowed only for a live mismatched v2 session whose crash
recovery and persistence state permit mutation; it serializes with prompts, handoffs,
mode changes, and ordinary configuration changes under the existing `configuring` phase.

`accept_effective` performs no harness mutation. It snapshots the current announcement,
turns every policy-admitted effective value into an ordered `accepted_effective`
restoration target, writes the policy-visible resolution record, and durably publishes
the replacement checkpoint before removing the prompt blocker. Excluded or otherwise
unpersistable values retain an honest promptable-partial result.

`replace_restoration_targets` validates a nonempty duplicate-free selection list before
dispatch. Each selection is revalidated against the latest announcement after every
prior harness response, because one option may change the remaining schema. A value that
must change is applied through its own durable `set_config` start/terminal/checkpoint
boundary. Successful earlier selections remain accurately checkpointed if a later one
fails. Once all values agree, a final standalone checkpoint replaces—not merges—the old
target list and only then clears the mismatch. The result reports which options actually
required harness mutation, and the session emits a resolution notification.

Added a pure helper for accepting effective configuration plus end-to-end tests for both
resolution strategies, including a harness which rejects the first opening-time restore
and accepts the explicit retry. The focused configuration suites pass 14/14, the complete
repository suite passes 603/603, `tsc --noEmit` passes, and `git diff --check` is clean.

### Part 7C — ordered continuation and explicit reconstruction

Expanded `AgentSession.open()` from its load-only first slice into the specified ordered
continuation pipeline. The default remains exactly one `load_internal_session` attempt;
the library still never creates a replacement thread merely because load failed. Consumers
can now explicitly add either a transcript continuation builder, identified by a stable
nonsecret `strategyId`, or supplied portable continuation text, identified separately by
`continuationId`. Empty policies and blank identities/content fail before harness startup.

Every attempted or locally skipped strategy is retained in `ContinuationReport`. A failed
recorded-thread load remains visible as `recordedThreadAvailability: "unavailable"` even
when a later strategy succeeds. A different adapter fails before harness contact unless
the caller explicitly supplied a reconstruction strategy; with one, the exact-load step
is skipped and the reconstruction is recorded as an adapter `switch` rather than a same-
adapter `replacement`.

Fresh reconstruction uses a dedicated controller startup path which ignores the stale
load target. Before publishing the new internal-session identity it durably records the
transition start, prepares the target configuration, records target creation, and commits
target activation plus canonical history. Same-adapter reconstruction reapplies the saved
ordered restoration targets before activation so the activation checkpoint is truthful.
Cross-adapter reconstruction deliberately carries no restoration targets because ACP
configuration identifiers are not portable without an explicit mapping. Uncertain
transcript recovery blocks replacement activation rather than letting continuation hide
an unresolved operation boundary.

The portable continuation is sent only after durable activation, through the ordinary
metering and transcript operation boundary as `switch_seed`. Successful completion then
closes the transition. If seeding fails after activation, no later fallback is attempted:
the transcript already names the new target, and a later open can report and load that
truthful boundary instead of silently creating another thread.

Exported the continuation strategy/builder types through the public barrel and added
`switch_seed` to the metered operation vocabulary. End-to-end coverage verifies failed
load followed by consumer reconstruction, same-adapter configuration restoration,
canonical history, seed metering, and transcript-builder reconstruction onto a different
adapter. The focused suite passes 10/10, the complete repository suite passes 605/605,
`tsc --noEmit` passes, and `git diff --check` is clean.

### Part 7D — explicit uncertain-boundary recovery

Added queued `AgentSession.resolveRecovery()` with the two explicit recovery choices from
the spec. `accept_harness_state` acknowledges that the harness may have completed work or
tool side effects which the transcript cannot prove; it makes no claim about the hidden
outcome. `start_new_internal_session` first records that same acknowledgement and then
uses the ordinary handoff path, with either caller-supplied continuation or a portable
summary generated by the currently loaded thread. It therefore retains the existing
handoff transition, canonical history, seed metering, and failure semantics rather than
creating a second replacement implementation.

Recovery resolution is serialized with every other session mutation under a distinct
`recovering` phase. It is permitted while recovery is the prompt blocker but still
requires a healthy v2 persistence sink. The session exposes the previous uncertain
boundary and final clean state in its result, returns the handoff result when it replaces
the provider thread, emits an explicit recovery-resolution notification, and updates
promptability only after the clean checkpoint is durable.

Extended the transcript runtime with a narrow canonical recovery primitive. A
`started_without_terminal` boundary receives an `interrupted` terminal followed by a
settled checkpoint. A `terminal_without_checkpoint` boundary materializes only the
missing checkpoint and never duplicates the existing terminal. A selected
`in_flight_checkpoint` is closed with operation kind `other`, explicitly avoiding a guess
that the lost started record represented a user prompt. In every case the runtime feeds
the complete structural tail through the existing reducer before exposing clean state,
then records the policy-filtered lifecycle acknowledgement.

The continuation scanner now returns its bounded structural tail to the runtime so this
resolution uses the same evidence that produced the opening recovery status. Tests cover
all three uncertain-boundary shapes, durable reopen after acceptance, promptability
unblocking and notification, and explicit recovery onto a newly seeded provider thread.
The complete repository suite passes 609/609, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 8A — snapshot-bound transcript pagination

Added the public `TranscriptReader` for bounded-memory access to an authoritative v2
transcript. `readPage()` supports the `conversation`, `timeline`, and `records` views,
returns every page oldest-to-newest, starts from the newest matching records, and provides
non-overlapping older/newer navigation. Type filters are validated against the selected
projection; an explicitly empty filter remains distinct from an omitted filter, and
unknown future record envelopes remain visible only through the records view.

Pagination now has a stable inclusive snapshot boundary. Concurrent appends remain outside
an existing walk, while a fresh read sees them. Opaque navigation cursors bind the log
generation, high-water mark, physical boundary, direction, view, and exact filter. Snapshot
cursors are deliberately view-independent for folded queries. Both cursor kinds verify the
captured prefix and record boundaries, reject truncation or earlier rewrites, use strict
canonical base64url decoding, and fit the spec's minimum 256-byte engraved cursor limit.
Log identity and integrity values are compact SHA-256 tags rather than paths or content.

The reader scans JSONL in fixed-size byte chunks in both directions, preserves records and
Unicode code points crossing chunk boundaries, rejects noncontiguous sequences and records
above engraved or hard safety limits, ignores only an incomplete bounded trailing suffix,
and never loads the whole transcript merely to return a normal page. Individual record
validation reuses the v2 persisted schema validators; forward-compatible unknown records
still require a valid identity envelope and canonical JSON value.

Added offline `listActivityStates()` at an inclusive snapshot. It folds each activity to
its greatest revision before applying open/terminal filtering, deterministic sequence/ID
ordering, and the requested limit. Open states are explicitly `historically_open`, never
presented as proof that an old tool is still running.

Continuation builders now receive the `TranscriptReader` itself instead of an absolute
path, so consumers can reconstruct from bounded pages without independently parsing the
storage format. The reader and its public cursor/page/activity types are exported from the
package barrel.

Tests cover reverse pagination, no overlap, filtered walks, concurrent appends, unknown
records, empty filters, cursor projection binding, prefix rewrites, malformed/oversized and
wrong-kind cursors, snapshot activity folding, the 256-byte cursor budget, and records over
64 KiB with a UTF-8 split. The complete repository suite passes 616/616, `tsc --noEmit`
passes, and `git diff --check` is clean.

### Part 8B — audit-log pagination

Added the public `AuditLogReader` with the same bounded, snapshot-stable paging contract as
the transcript reader while retaining an audit-specific API and record union. The reader
starts from the newest matching records, returns pages oldest-to-newest, supports exact
type-filtered older/newer navigation without overlap, and exposes forward-compatible
unknown audit envelopes through `UnknownAuditLogRecord`.

Audit navigation and snapshot cursors use distinct brands and distinct wire-kind markers;
they cannot be accepted as transcript cursors even when their sequence and generation
happen to match. Cursors bind the audit-log identity, generation, inclusive high-water
boundary, physical page boundary, and exact filter. They detect truncation and rewrites,
reject malformed or oversized input before using offsets, and fit a header engraved with
the minimum supported 256-byte cursor size. Concurrent appends stay outside an existing
walk and appear only in a fresh snapshot.

Extracted only the byte-level JSONL scanning, hashing, and integer-validation primitives
from the transcript reader as an internal module contract. Transcript and audit parsing,
schema validation, cursor wire formats, public errors, and projection semantics remain
separate, so audit security does not become a mechanical projection of transcript content.
The shared `TranscriptPage` container now carries defaulted cursor/snapshot generic types,
matching the spec while preserving existing transcript call sites.

The reader tests exposed and fixed an older sink-validation mismatch: audit operation
starts were being required to carry transcript-only continuation `stateRevision`, despite
both the declared audit schema and audit projection excluding it. The validator now keeps
that deterministic recovery requirement on transcript operation starts/aborts only. A
schema regression test fixes this boundary explicitly.

Tests cover audit reverse navigation, append-stable snapshots, no overlap, filters,
unknown future records, empty filters, cross-kind cursor rejection, malformed/oversized
cursors, earlier rewrites, and the 256-byte cursor budget. The complete repository suite
passes 620/620, `tsc --noEmit` passes, and `git diff --check` is clean.

### Part 9A — explicit legacy transcript migration boundary

Added the explicit `migrateLegacyTranscript()` utility. It requires a complete
`StagedContinuationState`; adapter identity, provider-thread identity, activation time,
model, session configuration, and protocol are never inferred from legacy presentation
records. The caller supplies the stable logical session identity, while fresh transcript
and incarnation identities may either be supplied for deterministic integration or minted
by the library.

Migration acquires the same exclusive path lock as a live session-log writer, validates
that the destination is a regular non-symlink file, scans the legacy prefix with bounded
memory, and preserves v1's permissive malformed/unknown-line behavior. It truncates only
an incomplete final v1 line. Unrelated v2 content is rejected rather than reclassified as
legacy history.

The writer establishes authority in two separately synchronized records: a generation-1
`upgraded` header carrying the exact legacy byte boundary, followed by a canonical initial
checkpoint at revision 1. That checkpoint has empty canonical routing history, no prior
transition or metering state, the supplied continuation identity/configuration, and a
clean boundary. Legacy records remain presentation-only and never enter the v2 reducer.

An interrupted migration whose upgrade header is durable but whose initial checkpoint is
missing can be resumed explicitly. A completed identical retry returns
`already_migrated` without appending again; a retry whose continuation disagrees with the
engraved checkpoint fails without changing the file. This is mutation idempotency, not a
claim that a lost live object or original return value can be reconstructed.

Added a narrow internal lock helper to the session-log writer so migration and live append
ownership cannot race while retaining a single lock implementation. Tests cover torn v1
suffix repair, malformed and unknown legacy lines, exact boundary preservation, canonical
checkpoint fields, identical retry, conflicting retry, header-only recovery, and rejection
of unrelated v2 content. Mixed v1/v2 cursor reading and ordinary opening are intentionally
the next Phase 7 slice.

The complete repository suite passes 624/624, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 9B — mixed v1/v2 scanning, opening, and pagination

Extended the authoritative transcript scanner to recognize a v1 presentation prefix
followed by the explicit generation-1 upgrade boundary. Before that boundary, malformed
and unknown v1 lines retain their historical permissive behavior. The first v2 object must
be the `upgraded` header at the exact byte offset engraved in `upgradedFrom`; all subsequent
continuation scanning, sequence validation, canonical history folding, checkpoint
selection, and recovery analysis operate only on the v2 suffix.

Because the continuation scanner now reports the suffix's v2 sequence independently from
physical legacy lines, the existing `FileSessionLogWriter.resumeTranscript()` and
`TranscriptPersistenceRuntime.resume()` work unchanged above it. A migrated transcript
can acquire normal append ownership at sequence 3, persist new operation/content/checkpoint
records, and reopen using the same reducer and uncertainty rules as a transcript created
natively as v2.

Updated `TranscriptReader` to locate and validate an upgrade header after a bounded-memory
legacy scan. Recognized v1 records are decoded with the existing permissive legacy parser
and exposed as presentation records; malformed and unknown v1 lines remain skipped. The
conversation view combines legacy `msg` records with v2 `message` records, timeline/record
filters map compatible legacy categories, and records view can retain recognized legacy
raw/meta/history records without manufacturing v2 envelopes.

Pagination can cross the declared byte boundary in either direction. V1 order is physical
file order, while v2 envelope sequence continuity remains checked within the authoritative
suffix. The snapshot prefix digest binds both regions, so edits to legacy presentation
history invalidate an existing mixed cursor just as edits to the v2 suffix do. Legacy
activity is intentionally not folded into v2 offline activity state; the older v1 folding
API remains its compatibility path.

Added an end-to-end test that migrates a v1 transcript, scans its canonical checkpoint,
resumes it through the live transcript runtime, appends a new v2 prompt boundary, and pages
from the v2 message into the v1 message and forward again without overlap. A process-backed
integration test verifies that ordinary `AgentSession.open()` loads the engraved provider
thread from this mixed file and returns a clean, promptable logical session.

The complete repository suite passes 626/626, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 9C — explicit legacy registry import

Added `importLegacySessionRegistry()` as the explicit bridge from the deprecated
`SessionStore` catalog into the v2 `AgentSessionStore`, plus
`SessionManager.importLegacySessions()` for managed consumers. Import is deterministic,
create-only, and per-entry: records are processed by stable logical-session ID and each
result reports `imported`, `already_imported`, `conflict`, or `skipped` with a structured
reason. One bad legacy row never prevents independent rows from being assessed.

The importer deliberately does not manufacture continuation authority from the sparse
legacy registry. A row is importable only after its transcript is native v2 or has passed
through the explicit transcript migration boundary. The transcript checkpoint supplies
the incarnation, provider-thread identity, adapter/mode, protocol, model, configuration,
activation state, and canonical history projection; the legacy record contributes its
catalog metadata such as cwd, title, and historical timestamps. Dirty, repaired,
unavailable, corrupt, missing, or identity-mismatched transcripts are reported without
mutating the destination store.

Destination writes use create-only compare-and-swap. An identical concurrent importer
that loses the race rereads the winner and reports `already_imported`; a different
incarnation using the same stable logical ID reports `conflict` and never overwrites the
existing v2 record. Idempotency is based on the imported lineage identities rather than
record revision, so a later ordinary update to the destination session does not make a
repeated import falsely conflict.

Tests cover mixed importable/mismatched/missing rows, exact checkpoint-derived authority,
concurrent import races, repeat import after a destination revision change, and conflicting
incarnations with preservation of the existing target. The complete repository suite
passes 629/629, `tsc --noEmit` passes, and `git diff --check` is clean.

### Part 10A — transactional managed-session deletion

Added the consumer-facing `SessionManager.deleteAgentSession()` operation and the lower-
level `deleteManagedAgentSession()` utility. The API requires a stable deletion ID plus
the expected incarnation and record revision. With no destructive flags it creates a
tombstone while retaining transcript and audit artifacts; either artifact can be deleted
explicitly, and registry hard removal is accepted only when no known artifact will remain.

The implementation uses the existing maintenance transaction rather than adding another
state model. It resolves every currently available artifact, acquires their writer locks
in canonical absolute-path order, prepares the incarnation/revision-fenced deletion,
unlinks only requested paths, synchronizes their parent directories, and then atomically
finalizes either the tombstone or registry removal. Ordinary live writers therefore stop
deletion before its prepared marker is published rather than leaving an indefinitely
hidden session.

Interrupted deletion is retryable with the same normalized request. Missing files after a
partially completed delete are treated idempotently while the prepared maintenance remains
visible. Hard deletion can also resolve a lost successful return through the existing
incarnation-scoped completion receipt even though the session record no longer exists.
Reused stable logical IDs remain protected by the caller's expected incarnation token.

Deletion metadata uses the prepared transaction timestamp, clamped to the existing record
timestamp so host clock skew cannot move registry time backward; retries therefore produce
the same lifecycle timestamps. Tests cover default tombstoning, independent artifact
retention, selective deletion, a failure between unlink and registry finalization, hard-
removal validation and idempotent retry, and CAS failure before filesystem mutation.

The complete repository suite passes 633/633, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 10B — managed CLI listing and confirmed deletion

Added top-level `acp-client sessions` and `acp-client delete` commands. These operate on
the managed logical-session registry and remain separate from the existing `chat` command
and its single-provider `AgentController` REPL. The CLI therefore does not blur logical
AgentSession operations with harness-specific internal-session commands.

`sessions` walks the paginated registry snapshot and presents stable logical identity,
adapter/mode, model, lifecycle/recovery state, artifact availability, and update time.
Tombstones remain hidden by default and are included explicitly with `--all` or
`--include-deleted`; `--json` returns the same bounded public summaries rather than raw
registry/checkpoint state.

`delete` resolves the current incarnation and record revision from the manager, then calls
the public transactional deletion API. Its artifact and hard-removal choices are separate
flags. Interactive execution requires the user to type the exact logical session ID;
non-interactive execution refuses mutation unless `--yes` was supplied explicitly. The
confirmation preview names transcript, audit, and registry destruction independently.

If a prior CLI deletion stopped after preparing maintenance, repeating the exact flags
reuses its persisted operation ID, incarnation, and base revision. A different pending
maintenance kind or deletion intent is reported rather than overwritten. Tests cover
strict command parsing, normal and tombstone-inclusive presentation, JSON output, exact
confirmation and cancellation, non-TTY refusal, and prepared-deletion recovery.

The complete repository suite passes 639/639, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 11A — transcript-backed managed creation

Added `SessionManager.createAgentSession()` for the default normal-ACP, transcript-backed
managed path. The manager resolves defaults, constraints, and the exact transcript
destination; mints or accepts stable logical/creation identities; acquires transcript
ownership before publishing maintenance; and prepares the registry creation before any
provider process starts. The acquired lock is transferred into `AgentSession` and remains
owned by the live transcript writer until the returned session stops.

Provider identity is advanced into `CreationMaintenance.stagedContinuation` immediately
after the harness returns it and before the initial checkpoint is written. Once the
transcript header/checkpoint are durable, the complete registry record is staged and the
maintenance transaction atomically finalizes it. Header installation provenance uses the
same request digest and creation ID as the registry transaction. Existing nonempty
destinations are rejected before reservation; an interrupted matching creation may remove
only an artifact whose header proves that exact ownership.

If registry finalization fails after provider/transcript creation, the live session is
stopped but its staged record remains discoverable. An identical retry finalizes that
record without creating another provider thread, then opens the recorded thread from the
authoritative transcript. A retry after a retained completion receipt throws
`MaintenanceAlreadyCompletedError` and tells the consumer to load instead of pretending
to reproduce the original live object.

The earlier crash phase is covered independently: if provider continuation was staged but
the complete record was not, retry removes only the matching creation-owned transcript
generation, loads the already-staged provider thread, and rebuilds the initial generation.
The staged continuation snapshot remains immutable; a fresh load observation cannot
replace its activation timestamp or configuration under the same transaction.

Added a managed checkpoint publisher to the transcript runtime. Every later in-flight or
settled transcript checkpoint updates the registry projection using incarnation/revision
CAS. In-flight publication occurs before provider dispatch. If it fails, the transcript
is closed with a durable aborted boundary, provider work is withheld, and the live
session exposes `persistence_unhealthy` rather than continuing against stale managed
state.

This slice deliberately rejects registry-only, audit-backed, and degraded managed
creation with explicit typed errors. Registry-only creation needs its own checkpoint
runtime, while audit-backed creation needs coordinated independent audit-log installation;
neither is simulated through a weaker best-effort path.

Tests cover successful creation, generated registry projection, later configuration
checkpoint publication, initialized-destination refusal before maintenance, staged-record
and staged-continuation retries without duplicate provider creation, completed-call
semantics, explicit unsupported variants, and registry pre-dispatch failure. The complete
repository suite passes 645/645,
`tsc --noEmit` passes, and `git diff --check` is clean.

### Part 11B — transcript-backed managed loading and registry reconciliation

Added `SessionManager.loadAgentSession()` as the managed counterpart to direct
`AgentSession.open()`. It resolves a logical identity from the manager's strict registry,
rejects missing identities, tombstones, active maintenance, unsupported persistence modes,
and accidental adapter changes before starting the harness. The stored transcript path,
capture policy, limits, and session-configuration persistence policy are reconstructed from
the registry rather than from mutable manager defaults.

The transcript reducer remains the continuation authority. Loading compares its reduced
checkpoint with the registry projection: a transcript-ahead state repairs the registry,
same-revision digest disagreement fails, and an unexplained registry-ahead checkpoint fails
instead of guessing. A successful open publishes a new `lastOpenedAt` revision and attaches
the same ongoing checkpoint publisher used by managed creation, so later operations keep
advancing the catalog. Any registry failure during reconciliation stops the acquired live
session before the error escapes.

Extracted the common registry projection/publisher logic so creation and loading share one
incarnation-fenced CAS implementation. Added the resolved session-configuration persistence
policy to new registry records; without it a reopened session could silently apply a
different filtering policy to later configuration checkpoints.

Tests cover provider-thread loading, configuration restoration, continued checkpoint
publication, transcript-ahead registry repair, missing and deleted identities, and
adapter-mismatch rejection before process startup. The complete repository suite passes
649/649, `tsc --noEmit` passes, and `git diff --check` is clean.

### Part 12A — offline checkpoint inspection and transcript reconfiguration

Added `SessionManager.getAgentSessionCheckpoint()` so consumers can resolve continuation
authority without starting a harness. The default path scans and reduces the configured
transcript, validates its incarnation and registry relationship, and labels the result as
authoritative. The explicit `registry_projection` source exposes a stale/lost-transcript
escape hatch and labels whether that projection is authoritative. Tombstone visibility and
active maintenance remain explicit.

Added the first offline `reconfigureAgentSessionPersistence()` implementation for
transcripts. Both replacement and disabling require the exact stopped-session incarnation
and revision, a consumer-stable operation ID, a validated checkpoint, and explicit
continuation-loss acknowledgement. Maintenance is prepared before destructive work and
fences ordinary registry publication. Replacement constructs and synchronizes a fresh
generation in a sibling file and atomically installs it at the existing v0 path; disabling
removes and synchronizes the old authority before final registry publication. Exact retries
are answered through the bounded completion receipt without repeating the mutation.

The session-log writer now distinguishes its temporary physical build path from the final
logical transcript path used by checkpoint validation. This keeps atomic replacement strict
without weakening transcript identity checks. Audit-log reconfiguration remains explicitly
unsupported until the live audit writer is integrated; the method does not pretend a
metadata-only change is sufficient.

Tests cover offline authority selection, transcript replacement, new generation identity,
post-replacement provider loading, idempotent completed retry, and acknowledged transcript
disablement. The complete repository suite passes 652/652, `tsc --noEmit` passes, and
`git diff --check` is clean.

### Part 12B — managed tombstone restoration with retained authority

Added `SessionManager.restoreAgentSession()` for tombstones whose authoritative transcript
was retained. Restoration requires the exact incarnation/revision, a stable restoration ID,
and an adapter supplied for this operation. The manager acquires transcript ownership before
preparing maintenance and transfers that lock into the opening runtime, so a live writer
cannot race a published restoration intent.

The tombstone remains authoritative until the recorded provider thread has loaded and a
fresh post-restoration checkpoint is durable. The transaction then stages provider
continuation and the complete active registry projection in separate monotonic steps before
finalizing. Only after finalization is ongoing checkpoint publication attached. The returned
`AgentSessionOpenResult` carries the normal continuation, recovery, configuration, repair,
and promptability reports, so the consumer can see whether the latest thread was actually
available and what occurred.

Interrupted finalization is resumable: an identical retry recognizes the staged record,
finalizes it without another restoration mutation, releases transaction ownership, and
performs an ordinary managed load to return a new live object. Active sessions are not
silently treated as tombstones. Deleted-transcript replacement and audit-backed restoration
remain explicit unsupported cases for their dedicated persistence stages.

Managed `AgentSession.open()` now accepts an internal transferred transcript lock, and the
session exposes an internal durable restoration-checkpoint primitive. Tests cover successful
reactivation, restored model/provider identity, continued registry publication, active-row
rejection, and recovery after staged finalization failure. The complete repository suite
passes 655/655, `tsc --noEmit` passes, and `git diff --check` is clean.

### Part 13 — registry-only managed session runtime

Separated managed checkpoint state from transcript storage through a common persistence
runtime contract and added `RegistryPersistenceRuntime`. A managed session with
`transcript: false` now retains its stable logical/provider identities, configuration,
metering, transition history, operation boundary, and promptability entirely in the strict
registry. It captures no conversation/activity content and reports conversation availability
as `not_captured`.

Registry-only creation stages provider identity before publishing the initial record, just
like transcript-backed creation. Every later operation publishes an in-flight checkpoint by
incarnation/revision CAS before provider dispatch and a settled checkpoint afterward. A
failed pre-dispatch registry publication withholds provider work and marks persistence
unhealthy. Staged creation retry loads the recorded provider thread instead of starting a
replacement.

Managed loading now recognizes registry authority, restores the exact provider thread and
configuration, returns the normal `AgentSessionOpenResult`, and attaches ongoing checkpoint
publication. Offline checkpoint inspection labels this source authoritative. The transcript
runtime implements the same internal state contract, keeping all existing transcript-backed
behavior unchanged.

Tests cover registry-only creation, absent transcript paths, authoritative checkpoint
inspection, configuration persistence, stopped-session reopening, continuation reporting,
and ongoing updates after load. The complete repository suite passes 657/657,
`tsc --noEmit` passes, and `git diff --check` is clean.
