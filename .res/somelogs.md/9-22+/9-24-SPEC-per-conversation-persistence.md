# Per-conversation persistence

Status: proposed.

The library resolves canonical `capture` and `auditLog` once, at `Agent.open`, into
`ManagerSettings` (`src/agent.ts:272`, `:552`) and reuses that value for every
`PersistedConversationLifecycle` (`src/agent.ts:1130`). An Agent owns one SQLite file and one
audit destination, and every conversation of that Agent shares them. There is today no way for
a caller to select a different **policy** for one conversation over those shared resources.

A consumer such as the Hub needs three settings: an ordinary `persistence` policy for user
conversations and a distinct `agent_to_agent_persistence` policy for participant channels
(direct pairs, Groups, inboxes), resolved per Agent. Because the Hub opens one acp-client Agent
(`ags`) per Profile and hosts all of that Profile's conversations (`agc`) inside it, the
distinction is only expressible as a per-conversation policy.

This specification adds a per-conversation persistence override to
`conversations.create()` / `conversations.open()`. The library provides the mechanism; the
consumer supplies the policy. The library does not learn what a conversation "is".

## Goals

- Let a caller select, per conversation, the canonical record capture policy and the audit
  capture policy over an Agent's shared storage and shared audit destination.
- Preserve one Agent = one SQLite file and one audit destination.
- Apply the selected policy uniformly across user turns, assistant turns, activity,
  checkpoint/identity writes, audit projection, recovery, and transitions.
- Keep the library agnostic about conversation semantics (no user/A2A/task kind).

## Non-goals

- No conversation `kind`, `purpose`, or `audience` field in the library.
- No per-conversation SQLite file or audit file/destination.
- No per-conversation audit rotation, retry, `filePrefix`, `shutdownGraceMs`, or `auditLogId`.
- No library-side persistence of the override; the consumer re-supplies it on every open.
- No change to agent-scope audit capture (`agent_lifecycle`, `identity`,
  `internal_inference`).
- No manager-level retry/recovery commands.

## Decision: mechanism, not policy

The library already carries `ParticipantRef.kind` (`"agent" | "user" | "external"`,
`src/persistence/backend.ts:20-22`), so it could attempt to infer "user chat" versus
"agent-to-agent". It must not:

- `kind` is not conversation purpose. A Profile's own channel, a direct pair, a Group, an
  inbox, and a task channel mix `agent`/`user`/`external` differently.
- Mapping a kind to a preset/capture/audit policy is product semantics, which the library's
  own principles reject (SPEC.md: *Introspection over hardcoding*, *Surface, don't interpret*).
- Any inferred rule ages badly; the next policy (task channels, neighbor federation) would need
  a new enum and a new guess.

Therefore the override is caller-supplied and the library treats it as an opaque resolved
policy.

## Agent-level versus conversation-level

| Scope | Owned by | Contents |
|---|---|---|
| Agent (fixed at open) | shared resource | persistence backend/file, **audit destination** + rotation/retry/`filePrefix`/`shutdownGraceMs`/`auditLogId`, checkpointing/identity enablement, metering retention, agent-scope audit capture |
| Conversation (override at create/open) | effective policy over the shared resource | canonical `capture` (which kinds, what level), audit **capture** (conversation-scope kinds), and `false` to exclude the conversation from the shared audit |

The override never changes where records go; it changes which records are produced and how much
of each enters the shared destinations.

## API

```ts
export interface AgentConversationAuditCaptureConfig
  extends Omit<AgentAuditCaptureConfig,
    "agent_lifecycle" | "identity" | "internal_inference"> {}

export interface AgentConversationPersistenceOverride {
  /** Canonical capture for this conversation; omitted keys inherit the Agent policy. */
  readonly capture?: ConversationRecordCaptureConfig;
  /** Audit capture for this conversation; `false` excludes it from the shared audit. */
  readonly auditLog?: false | { readonly capture?: AgentConversationAuditCaptureConfig };
}
```

Add `readonly persistence?: AgentConversationPersistenceOverride` to
`CreateAgentConversationConfig` and `OpenAgentConversationConfig` (`src/agent.ts:159`,
`:170`), and export both new types from `src/index.ts`.

Both types must be **derived** from the existing exported contracts, never a copied field list:

- `ConversationRecordCaptureConfig` (`src/persistence/backend.ts:219`) already includes every
  canonical kind, including `error`; it is a `Partial` map, so future kinds flow through.
- `AgentAuditCaptureConfig` (`src/audit/config.ts:11`) is the source for the conversation-scope
  audit subset. The event-bus specification forbids a second hardcoded record-kind list; the
  same rule applies here.

## Resolution semantics

- Resolve the override once, when the conversation is created or opened, into the conversation's
  `ManagerSettings` slice, and hold it on `PersistedConversationLifecycle` for the
  conversation's lifetime. Do not re-evaluate it per observation.
- `capture` is merged over the Agent's resolved `ConversationRecordCapturePolicy`; omitted keys
  inherit. Unknown kinds fail through the existing `resolveConversationRecordCapture`
  (`src/persistence/backend.ts:765`).
- `auditLog.capture` is merged over the Agent's resolved `ResolvedAgentAuditCapturePolicy`;
  omitted keys inherit. Unknown kinds fail through `resolveAgentAuditCapture`
  (`src/audit/config.ts:143`).
- `auditLog: false` makes the conversation produce no audit observations. Per-conversation audit
  capture when the Agent was opened with `auditLog: false` is an error: there is no runtime to
  receive it.
- Validation happens before the durable conversation row and before provider start, consistent
  with the existing `prepareStart` ordering and the error-record rules.

## Audit: selectable, not replaceable

Two distinct questions, two distinct answers.

### Capture policy — per-conversation and effectively replaced

Projection is a pure function of `(NormalizedAgentObservation, ResolvedAgentAuditCapturePolicy)`
executed at enqueue time (`src/audit/projection.ts:7`). Nothing in the runtime assumes one policy
for all conversations. An override therefore supplies the conversation's **entire effective**
audit capture policy (after merging), and `auditLog: false` removes the conversation from the
shared log entirely. This is the whole of per-conversation audit.

### Destination and runtime — Agent-level, not replaceable

`AgentAuditRuntime` is opened once per Agent with one resolved config and one identity
(`auditLogId`, `captureFingerprint`; `src/audit/config.ts:127`, `src/audit/runtime.ts:41`,
`src/agent.ts:433`). A different destination, rotation, retry, or file prefix per conversation
would require a second runtime and a second log identity, fragment the audit history, and break
the "one durable audit identity per Agent" contract. A consumer that needs participant-channel
audits in a separate file must use a second Agent (second `ags`), not this override.

### captureFingerprint note

`captureFingerprint` is computed from the Agent-level capture policy and written once
(`src/audit/config.ts:127-131`). With per-conversation capture it remains the Agent **base**
policy, not a per-entry guarantee; each written entry already records its own `captureLevel`
(`src/audit/contracts.ts:57`). Readers keep validating `auditLogId` and `agentSessionId` as
today. No header or schema change is required, but the fingerprint's meaning must be documented
as the default/base policy.

### Agent-scope observations are untouched

`agent_lifecycle`, `identity`, and `internal_inference` observations have scope `"agent"` and no
conversation (`src/audit/contracts.ts:23-32`; `src/agent.ts:517-528`). They always use the
Agent-level capture. The override type excludes them structurally.

## Interaction with checkpointing and identity

When checkpointing is enabled, `Agent.open` requires the **Agent-level** `capture.message` to be
`content` or `raw` (`src/agent.ts:285-289`). Combined with one shared Agent, this forces the
"broaden at open, narrow per conversation" pattern:

- an Agent whose A2A channels need message content must be opened with message capture at
  `content`, even if user conversations want `none`;
- user conversations must then narrow back to `none` through the override.

This invariant must be explicit and enforced: **if the Agent-level policy is broadened to
satisfy Agent-wide enablement, every conversation must receive a narrowing override.** The
0.10.0 regression is exactly the failure of this invariant when the override is unavailable
(see "Regression and compatibility").

Alternative, not required for v1: make the `:285-289` guard aware that per-conversation capture
may be `none`, so checkpointing can coexist with per-conversation disabled message capture
(their checkpoints simply carry no messages).

Recovery, handoff, and switch targets must receive the same override as the conversation they
serve. Because the policy lives on the conversation lifecycle (not on the transient open call),
a recovered or replaced provider thread inherits it.

## Persistence of the override

Recommended: do **not** persist the override in acp-client. The consumer is the source of truth
for conversation purpose (the Hub stores the participant-channel binding) and supplies the
override on every create/open and recovery. Accepted limitation: an open without an override
falls back to the Agent default; consumers must pass it consistently.

Deferred alternative: store the resolved policy on the conversation row and apply it on reopen.
This adds schema and an acp-client-side notion of per-conversation policy and is not needed for
the Hub.

## Relationship to the in-flight specifications

- **Provider attachment lifecycle.** Attachment recording is independent of capture; a
  conversation still records its provider attachment on first completed prompt even when message
  capture is `none` (existing rule). The override must not disturb that.
- **Committed-record event bus.** The bus publishes exactly the canonical records that commit.
  The override decides which records exist; the bus is unchanged. Future kinds (e.g. `error`)
  flow through because the override type derives from the exported capture config.
- **Conversation error records.** `error` participates in `capture` and is already present in
  `ConversationRecordCaptureConfig` (`src/persistence/backend.ts:252`) and in
  `AgentConversationAuditCaptureConfig`. Pre-conversation failures (no live conversation) cannot
  be affected by an override.

## Regression and compatibility

In the Hub, the 0.9.4 patch supplied this override and the consolidated A2A specification §8.1
and acceptance #32 currently forbid it. Removing the patch (`d602e2a`) while the Hub still
broadens the Agent and then narrows per conversation leaves user chats on the broadened policy:
message content recorded and audit enabled where the resolved policy says otherwise. Until this
specification lands:

- the Hub must not broaden the Agent unless it can narrow every conversation, or
- the Hub must remove `agent_to_agent_persistence` and the broaden/narrow code.

Choosing the three-setting model means the consolidated Hub specification must be amended
(define `agent_to_agent_persistence`, permit the per-conversation override, and revise §8.1,
#31, and #32); the code follows the chosen model.

## Tests

Required deterministic coverage:

1. A conversation with `capture.message: none` writes no message rows while a sibling in the
   same Agent/file writes content.
2. A conversation with `auditLog: false` produces no audit entries while its sibling still does.
3. The Agent-level union plus per-conversation narrowing: a user conversation does not inherit
   A2A message capture or A2A audit capture.
4. Per-conversation capture partial merge inherits omitted keys from the Agent policy.
5. Unknown capture kinds and `auditLog: false` at Agent level with per-conversation audit
   capture fail before the conversation row and before provider start.
6. Reopen applies the override; recovery applies it to the replacement provider thread.
7. The override reaches user turns, assistant turns, activity, and metering, not only create.
8. Agent-scope audit observations are unaffected by any conversation override.
9. Checkpointing with a per-conversation `none` message policy behaves per the chosen option 1
   guard.
10. The Hub-side regression test is kept and asserts observable records/audit for a
    conversation (not the private `resolveConversationPersistence` method).

## Implementation sequence

1. `feat: per-conversation persistence override`
   - Add `AgentConversationPersistenceOverride` and `AgentConversationAuditCaptureConfig`.
   - Add `persistence?` to create/open configs and export the types.
   - Resolve into `PersistedConversationLifecycle` settings; thread through create/open/recovery.
2. `test: cover per-conversation persistence and audit selection`
3. Amend the consolidated Hub specification and keep the Hub regression test.

## Acceptance criteria

- A caller can select canonical capture and audit capture per conversation over one Agent's
  shared file and shared audit destination.
- One Agent still owns one SQLite file and one audit destination; no second runtime or log
  identity is introduced.
- The override applies for the whole conversation lifetime, including recovery and transitions.
- The library infers no conversation semantics; kinds and participant types never select a
  policy.
- Omitted keys inherit the Agent policy; `auditLog: false` fully excludes a conversation.
- Agent-scope audit capture and the audit destination remain Agent-owned.
- Types derive from existing exported contracts and absorb future record kinds automatically.

## Accepted limitations

- One audit destination per Agent. Separate A2A audit files require a second Agent.
- The override is not persisted; consumers must supply it on every open.
- `captureFingerprint` describes the Agent base policy, not every entry.
- Agent-scope observations cannot be tuned per conversation.
