# Per-conversation persistence policy

Status: implemented, in two parts (see `10-4-LOG-adopt-provider-session.md`): capture, with the resolver itself (Phase 1),
then audit overrides and exclusion, metering retention, fingerprints, checkpoint-record policy and the relaxed checkpoint
guard (Phase 7). Not done: the Hub follow-up (outside this repository), tests for recovery under a resolver, and the
per-conversation identity switch (`identity: false`, parked).
Supersedes `9-24-SPEC-per-conversation-persistence.md`.

An `Agent` resolves one canonical capture policy (`AgentConfig.capture`), one audit capture
policy (`AgentConfig.auditLog.capture`), and one detailed metering retention
(`meteringPersistence.meteringRecords`) at `Agent.open`. Every conversation it owns uses them.
A consumer that hosts different kinds of conversations in one Agent therefore cannot persist
less for some of them.

The Hub is the motivating case. It opens one Agent per Profile, and that Agent hosts the
Profile's user conversations, inbox, direct pairs, and Groups. Participant channels need to
follow `agent_to_agent_persistence` instead of the ordinary `persistence`.

This specification adds a **conversation persistence resolver** to `AgentConfig`. The consumer
supplies it at `Agent.open`, alongside the Agent defaults. The library calls it whenever it
needs a conversation's policy and applies the result to every record, audit observation, and
metering write made for that conversation. The library never infers a policy; what a
conversation *is* stays the consumer's business.

## Goals

- Let a caller choose, per conversation:
  - which canonical record kinds are stored, and at what level;
  - whether the conversation enters the Agent's audit stream, and how much of it;
  - how much detailed metering history is kept.
- Apply the policy to every write made for the conversation. This includes writes the library
  makes outside a live conversation: error records during `open()`, checkpoint records, and
  detached metering.
- Make it impossible to forget the policy on some code path: no call site has to repeat it.
- Keep the policy's source of truth and lifetime the same as the Agent defaults. Both come from
  the consumer at `Agent.open`, and neither is stored by the library.
- Preserve one Agent = one SQLite database, one audit destination, one audit identity.
- Leave Agents without a resolver unchanged, apart from the fixes listed under
  "Behavior changes without a resolver".

## Non-goals

- A conversation `kind`, `purpose`, or `audience` field, or any library rule that maps
  participants, titles, or metadata to a policy.
- Storing the policy, or any per-conversation override, in SQLite.
- Per-conversation storage location or runtime: SQLite path, audit `directory`, `filePrefix`,
  rotation, retry, `shutdownGraceMs`, `auditLogId`, or persistence limits.
- Per-conversation levels for agent-scope audit kinds (`agent_lifecycle`, `identity`,
  `internal_inference`).
- Retroactive effect. A narrower policy never deletes or redacts rows or audit entries that
  were already written.
- Controlling what a conversation *receives* through checkpoint-backed identity (see
  "Checkpointing, recovery, and identity").
- Changing the policy of a live conversation in place.
- Suppressing the operational state the library needs in order to function (see "Always
  persisted").
- Recording on each canonical record which policy captured it.

## Model

| Owned by the Agent (fixed at `Agent.open`) | Selectable per conversation |
|---|---|
| Persistence backend and file | Canonical capture level of each record kind (`capture`) |
| Audit destination, `filePrefix`, rotation, retry, `shutdownGraceMs`, `auditLogId` | Whether the conversation enters the audit stream (`auditLog: false`) |
| Agent-scope audit capture levels | Conversation-scope audit capture levels (`auditLog.capture`) |
| Whether checkpointing, recovery, and identity are enabled | Detailed metering retention (`meteringRecords`) |
| Persistence limits | |

The Agent-level values are the defaults a conversation inherits. The resolver returns an
**override**, which is a partial layer over those defaults:

- keys the override sets replace the Agent's values;
- keys it omits follow the Agent;
- `undefined` and `{}` both mean "use the Agent defaults".

## API

```ts
/** Audit kinds observed at agent scope, derived from the observation contract. */
export type AgentScopeAuditObservationKind = NormalizedAgentLevelObservation["kind"];

export type AgentConversationAuditCaptureConfig =
  Omit<AgentAuditCaptureConfig, AgentScopeAuditObservationKind>;

export interface AgentConversationPersistenceOverride {
  /** Canonical record capture. Keys set here replace the Agent's; omitted keys inherit. */
  readonly capture?: ConversationRecordCaptureConfig;
  /** `false` keeps this conversation out of the audit stream entirely. */
  readonly auditLog?: false | { readonly capture?: AgentConversationAuditCaptureConfig };
  /** Detailed metering-record retention for this conversation. */
  readonly meteringRecords?: MeteringRecordRetention;
}

/** What the library knows about a conversation when it asks for its policy. */
export interface ConversationPersistenceContext {
  readonly agentConversationId: AgentConversationId;
  readonly participants: readonly ParticipantRef[];
  readonly title?: string;
  readonly metadata?: string;
}

export type ConversationPersistenceResolver = (
  conversation: ConversationPersistenceContext,
) => AgentConversationPersistenceOverride | undefined;

export interface AgentConfig {
  // ...existing fields...
  readonly conversationPersistence?: ConversationPersistenceResolver;
}
```

Export the new types from `src/index.ts`. `CreateAgentConversationConfig`,
`OpenAgentConversationConfig`, and `AgentConversationSummary` do not change.

The override types are **derived** from the exported contracts
(`ConversationRecordCaptureConfig`, `AgentAuditCaptureConfig`,
`NormalizedAgentLevelObservation`). They never list kinds by hand, so a record kind added later
can be overridden as soon as it exists. The override type name matches the 0.9.4 Hub patch,
so the Hub's existing helper that builds it keeps compiling.

### Example

```ts
const agent = await Agent.open({
  persistence: { kind: "sqlite", path },
  adapters,
  capture: { message: "none" },                  // default: keep no message content
  checkpointing: {},
  auditLog: { directory, capture: { message: "none" } },
  conversationPersistence: ({ agentConversationId }) =>
    channels.isParticipantChannel(agentConversationId)
      ? {
          capture: { message: "content" },       // keep content, and so recovery
          auditLog: false,                       // stay out of the audit stream
          meteringRecords: "none",               // keep no detailed metering history
        }
      : undefined,                               // everything else: Agent defaults
});
```

## Resolver contract

- **Synchronous and free of side effects.** It returns a value; it does not return a promise
  and must not write anything. The library may call it just before a write transaction. A
  consumer whose lookup is asynchronous preloads what it needs before `Agent.open`. The Agent's
  own API is asynchronous, so a synchronous resolver also cannot call back into the Agent.
- **May be called at any time while the Agent is open**, for any conversation the Agent owns,
  including conversations that are not live and conversations created in an earlier process.
- **Receives only what the library already knows.** On `create()` the conversation row does not
  exist yet, so the library builds the context from the create input (the chosen or generated
  ID, normalized participants, `title`, `metadata`). Otherwise the context comes from the
  stored conversation summary.
- **Should be stable.** For a given conversation it should return the same answer until the
  consumer's own configuration changes. The library does not detect or reconcile changes.

When the resolver is absent, every conversation uses the Agent defaults.

## When the policy is resolved

- **Conversation start.** `create()`, `open()`, and the recovery path in `open()` call the
  resolver once, before any durable write and before the provider starts, at the same point as
  the existing `prepareStart` checks. The resolved policy is held on
  `PersistedConversationLifecycle` for the life of that live conversation. Per-record writes
  never call the resolver.
  - The error records written by that same start (provider-session create, load, and recovery
    failures) use the policy resolved for it.
  - Recovery creates a new `AgentConversation` through `start()`. That call receives the policy
    already resolved for the failed load, rather than calling the resolver again.
- **Writes outside a live conversation.** Checkpoint completion, detailed metering of
  conversation-scoped internal inference, and audit observations about a conversation call the
  resolver just before their write transaction. If the conversation is live, they use the
  live conversation's policy instead.
- **Configuration changes.** A live conversation keeps the policy it started with until it is
  stopped and opened again, as it keeps the Agent defaults until the Agent is reopened. Writes
  made outside a live conversation always see the resolver's current answer.

Resolving is cheap: an object merge plus the existing validators. The resolved policy,
including its audit fingerprint, is memoized by the override's canonical JSON, so a consumer
with a handful of distinct overrides validates and fingerprints each one once per Agent.

## Resolution and validation

A conversation's effective policy is resolved as follows.

- **Canonical capture:** `resolveConversationRecordCapture({ ...agentCapture, ...override.capture })`,
  where `agentCapture` is the Agent's validated `AgentConfig.capture`.
  - Replacement is per key.
  - `protocol` counts as one key, so an override replaces its level and method filters
    together.
- **Audit:**
  - If `override.auditLog === false`, the conversation is excluded (see "Exclusion").
  - Otherwise, if the Agent has an audit log, the capture is
    `resolveAgentAuditCapture({ ...agentAuditCapture, ...override.auditLog?.capture })` with its
    own fingerprint (see "Fingerprints"). Destination fields are the Agent's resolved values,
    used verbatim and not re-validated.
  - If the Agent has no audit log, nothing is audited.
- **Metering records:** `override.meteringRecords ?? agentMeteringRecords`. Retention is
  already applied per conversation (`metering.commit` prunes `record_json` by
  `agent_conversation_id`), so `{ retain: n }` keeps the newest `n` detailed records of that
  conversation. Bounded metering state is unaffected.

Validation uses the existing resolvers, so an unknown kind or an invalid level fails with the
same message as it does in Agent configuration. Validation also rejects:

- An agent-scope kind in `auditLog.capture`:
  `conversation audit capture cannot select agent-scope kind: identity`. The type already
  excludes these kinds; this check catches untyped callers.
- An `auditLog` other than `false` when the Agent was opened without an audit log:
  `conversation audit capture requires an Agent audit log`. The Hub specification requires
  unsupported per-conversation behavior to fail explicitly rather than be ignored.
- An effective `message` capture of `metadata` while checkpointing is enabled (see
  "Checkpointing, recovery, and identity").

### Failures

- **At conversation start**, a resolver that throws or returns an invalid override is a caller
  mistake. The call rejects with that error. It creates no conversation row, writes no error
  record, and starts no provider.
- **Outside a live conversation**, the write that needed the policy fails like any other
  persistence failure. For a checkpoint this means the internal-inference attempt fails and
  follows the existing retry rules. For an agent-scope audit observation about the
  conversation, the observation is not enqueued, and the error is kept as the Agent's pending
  audit-observation error, which `Agent.close()` reports as it does today. The library logs the
  error. It does not fall back to the Agent defaults, because a fallback could persist more
  than the consumer allowed.

## Where the policy applies

| Write | Code path | Policy today | Policy after |
|---|---|---|---|
| User message, assistant messages, streaming snapshots, failed-prompt messages | `PersistedConversationLifecycle` | Agent | Conversation |
| Tool calls, permissions, configuration, protocol, thinking, activity, native and agent actions (including recovery-seed actions) | `lifecycle.record` | Agent | Conversation |
| Metering timeline reference and its detailed metering record | `lifecycle.meteringRecorded` | Agent | Conversation |
| Provider-session create, load, and recovery error records | `recordConversationError` (manager) | Agent (reads the manager's settings) | Conversation, resolved at start and passed in |
| Checkpoint `native_action` record | `ConversationCheckpointStrategy.complete` appends directly | **None: no capture or audit is applied** | Conversation, applied inside the completion transaction |
| Detailed metering records of conversation-scoped internal inference | Internal-inference manager | Agent retention | Conversation retention |
| `identity` and `internal_inference` audit observations about a conversation | Agent | Agent | Agent levels, but suppressed when the conversation is excluded from audit |
| `agent_lifecycle` audit observations | Agent | Agent | Agent (unchanged) |

For checkpoint records, the internal-inference manager resolves the conversation's policy
before it opens the completion transaction. It then hands the strategy an append function that
applies canonical capture and enqueues the audit observation, instead of the raw
`records.append`.

Handoff, adapter switch, and reset keep the same `AgentConversation` and lifecycle, so they
keep the policy.

The committed-record event bus does not change. It publishes committed canonical records, so a
record the policy drops is never published.

### Always persisted

Capture governs conversation **records**. The library always writes the following operational
state, because it cannot function without it:

- the conversation row, including title, metadata, participants, sequence, and recency;
- provider-session mappings;
- metering state (the bounded counters, not the detailed records);
- identity delivery cursors;
- internal-inference jobs;
- audit outbox rows for the observations the audit policy selects.

A consumer that needs none of this for a conversation needs a separate Agent.

## Audit

### Projection

Conversation-scope observations are projected with the conversation's effective audit capture.
Projection is already a pure function of the observation and a policy
(`projectAgentAuditObservation`), so only the policy argument changes; the algorithm does not.

### Exclusion

`auditLog: false` guarantees that the audit stream contains no entry *about* the conversation:

- no conversation-scope observation for it;
- no `identity` observation caused by its records (`auditIdentityUpdate` is skipped);
- no `internal_inference` observation whose `agentConversationId` is this conversation.

Agent-scope observations keep the Agent's levels. Only their inclusion follows the
conversation.

### Fingerprints

Current behavior:

- Every outbox item and every written entry carries `captureFingerprint`
  (`enqueueAuditObservation`).
- `SqliteAuditOutboxPersistence.enqueue` also copies each item's fingerprint into
  `agent_audit_state.capture_fingerprint`.

With per-conversation policies:

- An entry's `captureFingerprint` identifies the policy that projected it:
  - for a conversation-scope entry, the conversation's effective audit capture;
  - for an agent-scope entry, the Agent's base policy.

  The fingerprint is computed exactly as today (`projectionSchemaVersion`, capture, limits), so
  a conversation whose override leaves audit capture alone stamps the base fingerprint.
- `agent_audit_state.capture_fingerprint` and `agent.audit.status().captureFingerprint` hold the
  Agent's base policy. Only `initialize` writes them; `enqueue` stops overwriting them.
- The entry format (v2), the segment header, and `auditLogId` do not change. A stream that uses
  overrides contains more than one fingerprint, and a reader can group entries by fingerprint.
- Duplicate detection (`samePendingAuditItem`) still compares fingerprints. The policy is fixed
  for the whole attempt, so an idempotent re-enqueue within one attempt still matches.

### Destination

The destination and its runtime (`AgentAuditRuntime`) cannot be selected per conversation. A
consumer that needs a separate audit file for some conversations needs a second Agent.

## Checkpointing, recovery, and identity

Checkpointing reads canonical records, so it can only use what the policy persisted.

- **Checkpoints.** Scheduling counts completed assistant message rows
  (`successfulResponseCount`), and a checkpoint covers the records up to the latest message
  sequence. A conversation whose effective `message` capture is `none` therefore gains no new
  checkpoint coverage. `agent.checkpointing.request()` for it is a no-op once earlier messages
  are covered.
- **Recovery.** Without a checkpoint, a provider-session load failure throws the structured
  `ProviderSessionError` instead of recovering.
- **Why `metadata` is rejected.** With `message: "metadata"`, checkpoints would be scheduled
  over messages with empty content, and identity would deliver empty lines. So while
  checkpointing is enabled, `metadata` is rejected at both conversation and Agent level.
- **Relaxed Agent guard.** The existing Agent-level check (`conversation checkpointing
  requires message capture at content or raw level`) is relaxed to reject only `metadata`.
  - An Agent may now enable checkpointing with a default of `message: "none"`, and the
    conversations that need recovery override to `content`.
  - The "broaden the Agent, then narrow every other conversation" pattern is no longer needed.
- **Identity.** Checkpoint-backed identity delivers other conversations' canonical messages and
  checkpoint summaries.
  - A conversation contributes exactly what its policy persisted. With `message: "none"`, it
    contributes nothing.
  - It still receives identity from its siblings. Controlling what a conversation receives is
    not persistence and is out of scope; a consumer that needs it uses a custom
    `AgentIdentityRuntime` or a separate Agent.
  - A custom runtime's `update()` already receives only the records the policy persisted.
- **Not retroactive.** Messages and checkpoints written before a policy change remain, and
  they stay identity sources. Recovery can restore only what was persisted.

## Behavior changes without a resolver

1. Checkpoint `native_action` records follow the Agent's `native_action` capture and enter the
   audit stream. Today they are always written and never audited.
2. Checkpointing accepts `message: "none"` at Agent level. It still rejects `metadata`.
3. `enqueue` no longer rewrites `agent_audit_state.capture_fingerprint`. An Agent with a single
   policy sees no difference.

Otherwise, an Agent without a resolver behaves exactly as before, including its records, its
audit entries, and their fingerprints. There is no schema change.

## Consumer migration: the Hub

Today the Hub (`agents-core/src/agent/chat/sqlite-session.ts` and `identity-store.ts`):

- opens one Agent per Profile, broadening `message` to `content` whenever either policy needs
  it; and
- passes `persistence: conversationPersistenceOverride(...)` on every `create()` and `open()`.

Without the 0.9.4 patch the library has no such field. The narrowing is lost, and user
conversations run on the broadened policy.

With this specification:

- **One resolver instead of two call sites.** Pass the resolver to `AcpAgent.open` and remove
  `persistence` from the `create()` and `open()` calls:

  ```ts
  const a2aOverride = conversationPersistenceOverride(agentToAgentPersistence);
  AcpAgent.open({
    capture: conversationCapture(agentCfg.persistence),
    auditLog,
    conversationPersistence: ({ agentConversationId }) =>
      db.conversations.getParticipantByChannel(agentConversationId) ? a2aOverride : undefined,
  });
  ```

  The Hub's database lookup is already synchronous. The participant-channel binding must exist
  before `create()` is called, which is already the order in `sqlite-session.ts`.
- **Resolution.** Omitted keys inherit the Agent's policy, where the 0.9.4 patch resolved
  canonical capture over library defaults. The Hub passes every canonical key except `error`,
  and its Agent-level `error` is also the default, so the result matches the patch.
- **No broadening.** The Hub can open the Agent with its ordinary policy and let participant
  channels override to more. It can enable checkpointing and identity when *either* policy
  captures message content.
- **Config reload.** A live channel keeps its start-time policy until it is stopped and opened
  again. Background writes pick up the new answer immediately.
- **Unsupported fields.** The Agent model cannot vary `transcript.path`, `audit_log.path`,
  `limits`, `session_configuration`, or `include_truncation_digests` per conversation. The Hub
  specification requires unsupported per-conversation behavior to fail explicitly, so
  `agent_to_agent_persistence` must reject values for these fields that differ from
  `persistence`.
- **Hub spec.** The consolidated Hub specification (§8.1 and acceptance #31 and #32 in
  `9-20_23-a2a_communication-conversations.md`) states that no per-conversation override
  exists. It must be amended to define `agent_to_agent_persistence` on top of this API.
- **Regression test.** The Hub unit test `agent-communication-persistence` depends on an
  acp-client internal API that 0.10.0 does not have. Rewrite it to assert the observable
  records and audit entries of two sibling conversations.

## Tests

Tests go in the new file `test/agent-conversation-persistence.test.ts` unless another file is
named.

1. Two conversations in one Agent: the resolver gives A `message: "none"` and B `undefined`
   (inheriting `content`). After a prompt, A has no message rows, B has them, and the event
   bus published only B's messages.
2. A partial override inherits omitted keys from the Agent, and `protocol` is replaced whole.
3. With `auditLog: false` for A, no entry has A's `agentConversationId`, and no `identity` or
   `internal_inference` entry refers to A. B is still audited.
4. With an audit capture override for A, A's entries use A's levels and fingerprint, while B's
   entries and agent-scope entries use the base fingerprint. `status().captureFingerprint` is
   still the base after A writes. (`test/audit-runtime.test.ts`)
5. At start, each of the following rejects the call before any write, leaving no conversation
   row, no error record, and no adapter launch:
   - a resolver that throws;
   - an unknown kind;
   - an invalid level;
   - an agent-scope audit key;
   - an audit override on an Agent without an audit log;
   - `metadata` message capture with checkpointing enabled.
6. `create()` passes the create input to the resolver (ID, participants, title, metadata).
   After a restart, `open()` passes the stored summary and the policy still applies.
7. Per-record writes do not call the resolver; a start calls it once. Identical overrides are
   validated and fingerprinted once per Agent.
8. A live conversation keeps its start-time policy after the resolver's answer changes. After
   `stop()` and `open()`, the new answer applies.
9. Error records:
   - A load failure under `error: "none"` writes no canonical row but still throws
     `ProviderSessionError`.
   - Under `auditLog: false`, the same failure writes no audit entry.
   - A create failure uses the policy resolved for `create()`.
10. Recovery: records written by the recovered provider thread follow the conversation's
    policy, and so does a `recovery_failed` record. The resolver is not called a second time.
11. The checkpoint action record respects `native_action` capture and audit, both with and
    without a resolver. A checkpoint that completes after a restart, before the conversation
    is reopened, uses the resolver's policy. (`test/checkpointing`)
12. A resolver that throws during a background checkpoint fails that attempt through the
    existing retry rules and writes nothing under the Agent defaults.
13. With `message: "none"`:
    - no checkpoint is scheduled;
    - `request()` is a no-op;
    - a load failure throws instead of recovering;
    - a sibling's identity context contains nothing from the conversation.
14. With `meteringRecords: "none"` for A, no detailed metering records are kept for A,
    including those from conversation-scoped internal inference, while B keeps them.
15. Handoff, switch, and reset keep the policy.
16. An Agent without a resolver produces the same records and audit entries as before, apart
    from behavior change 1.

## Implementation sequence

1. `refactor: carry a resolved persistence policy per conversation`
   - Split the per-conversation part out of `ManagerSettings`, so that the lifecycle and
     `recordConversationError` receive it.
   - `enqueueAuditObservation` takes the projecting capture and its fingerprint.
   - No behavior change.
2. `fix: stamp audit entries with the fingerprint of the projecting policy`
   - `enqueue` stops rewriting `agent_audit_state.capture_fingerprint`.
3. `fix: apply capture and audit policy to checkpoint action records`
4. `feat: conversation persistence resolver`
   - The types, the `AgentConfig` field, validation, and memoization.
   - Resolution at start and before background writes.
   - The relaxed checkpoint guard.
   - Per-conversation metering retention.
   - Audit exclusion of agent-scope observations about the conversation.
5. `test: cover per-conversation persistence policy`
6. `docs: document per-conversation persistence in the consumer guide`
   - The model table, the resolver contract, the "always persisted" list, the identity
     caveat, and the fingerprint semantics.
7. Hub follow-up:
   - upgrade to this release;
   - replace the per-call overrides with the resolver and drop the broadening;
   - amend the Hub specification;
   - rewrite the regression test.

Steps 2 and 3 are separable fixes and can land first.

## Acceptance criteria

- A caller can select canonical capture, audit inclusion and audit capture, and metering
  retention per conversation, over one Agent's database and audit destination.
- The policy covers every write made for the conversation, including error records, checkpoint
  records, recovery, transitions, and detached metering.
- No call site has to repeat the policy, and nothing about it is stored by the library.
- Per-record writes add no resolver calls.
- A resolver failure never causes a write under the Agent defaults.
- Omitted keys inherit the Agent policy.
- `auditLog: false` leaves no entry about the conversation in the audit stream.
- Audit entry fingerprints identify the policy that projected each entry, and the Agent state
  fingerprint is the base policy.
- The library infers no policy from participants, record kinds, or metadata.
- The override types derive from the exported contracts.
- An Agent without a resolver behaves as before, except for the listed fixes.

## Accepted limitations

- One SQLite file and one audit destination per Agent. Separate files require a second Agent.
- The resolver must be synchronous. Consumers with asynchronous lookups preload them.
- A live conversation keeps its start-time policy until it is stopped and opened again.
- A policy change is not retroactive.
- Operational state is always persisted.
- Checkpoint-backed identity still delivers sibling context to every conversation.
- Agent-scope audit levels cannot be tuned per conversation.
- The library does not record which policy a conversation used. Readers that need it ask the
  consumer's configuration, as they would for the Agent defaults.
- Canonical records do not say which policy captured them. For example, a message captured at
  `metadata` is indistinguishable from an empty message, as it is today.

## Alternatives considered

- **Pass an override on every `create()` and `open()` call** (the earlier draft).
  - Any call that forgets the override silently reverts the conversation to the Agent policy;
    this is the 0.10.0 regression.
  - Writes the library makes outside a live conversation, such as checkpoint jobs resumed after
    a restart, cannot know the policy.
  - Reopening a live conversation with a different override needs a conflict rule.
- **Store the override with the conversation in SQLite.**
  - It closes the same gaps as the resolver, but needs a schema migration, a custom-backend
    capability, rules for stored overrides that no longer validate, and a conflict error for
    live conversations.
  - It creates a second copy of consumer configuration that can drift from the original, while
    the Agent defaults themselves are not stored.
- **Infer the policy from `ParticipantRef.kind`.** Rejected. Participant kind does not express
  purpose, and mapping it to a policy is product semantics, which the SPEC.md principles
  (*Introspection over hardcoding*, *Surface, don't interpret*) reject.
- **Open a second Agent per policy.** This is possible today, but it splits the Profile's
  identity, database, and audit history. It remains the answer only when storage locations must
  differ.
