# Provider attachment lifecycle

Status: Stage 1 implemented; Stage 2 proposed.

An ACP logical conversation and the provider thread currently serving it are different
things. The logical `agc-*` conversation is owned by this library and can be persisted
immediately. A provider session ID is supplied by a harness and is only a candidate for a
later `session/load`; the library cannot guarantee that the harness has saved it or will
continue accepting it.

The current implementation nevertheless records a newly returned provider session ID as
the active continuation before a provider turn succeeds. It also records another provider
row whenever an existing conversation is opened through `session/load`. This specification
separates live attachment from recorded continuation and applies one lifecycle across
creation, loading, recovery, handoff, switch, reset, mode changes, and direct persistence.

“Recorded” throughout this document means selected locally as the provider attachment to
try on the next open. It does not mean durable, confirmed by the provider, or guaranteed to
remain loadable.

## Goals

- Keep a newly created provider ID in memory until a completed provider turn supplies
  enough evidence to retain it as a future load candidate.
- Never rotate or append a provider mapping merely because an existing mapping was loaded.
- Preserve the last recorded attachment until a replacement has crossed its confirmation
  boundary.
- Keep attachment state, final response persistence, identity delivery, transitions, and
  shutdown behavior internally coherent.
- Make runtime-only versus recorded attachment state explicit in internal contracts and in
  transition results where consumers need it.
- Apply the invariant to Agent-owned SQLite, recovery, transitions, direct/v2 persistence,
  and legacy/v1 persistence through explicitly owned implementation stages.

## Non-goals and accepted limitations

- The library does not promise that any provider session ID is durable or loadable later.
- The library does not probe `session/load` after every turn.
- Logical conversations are not drafts. An empty `agc-*` conversation may be durable while
  its current provider attachment exists only in memory.
- Provider execution and local SQLite writes cannot be one atomic transaction.
- The library does not automatically retry an uncertain prompt after a crash.
- Existing provider rows are not heuristically migrated, deleted, or declared valid.
- This change does not add error records or the public event bus. Those follow this work.

## Current failure modes

### Premature initial persistence

`Agent.conversations.create()` currently persists the logical conversation, starts a
provider with `session/new`, and then appends the returned ID to `provider_sessions` in
`src/agent.ts` before any prompt completes. Some harnesses return an ID before that ID is
actually available to a later `session/load`. Stopping at that point leaves an unloadable
active mapping.

### Loading rotates an unchanged mapping

The post-start persistence branch around `src/agent.ts:841` serves both
`providerSession: "new"` and `providerSession: "load"`. A successful `open()` therefore
appends a new provider row and deactivates the previous row even though both describe the
same provider thread. Create and load are distinct lifecycle operations and must not share
that branch.

### Handoff can destroy the valid source before the target is seeded

This is a concrete continuation-state corruption, not an ordering preference. In the
current `runHandoff()` flow in `src/agent-session.ts`:

1. `target_activated` is written.
2. `ownerLifecycle.transitionActivated()` records the target provider row.
3. The previous controller is stopped.
4. Only then is the continuation seed sent.

If seeding throws, the catch path restores `internalSessionId` only on the non-v2 path.
`targetActivated` is already true, so the target cleanup guard does not stop the target,
and the source controller is already gone. The stored continuation now selects an unseeded
target without the evidence that was meant to justify it.

Correcting this failure is the strongest justification for Stage 2.

## Evidence levels

Provider state advances through local evidence levels:

```text
session/new succeeded
    provider thread is usable by this process

completed provider turn on that thread
    provider ID is eligible to be recorded as a continuation candidate

future session/load succeeded
    provider ID was loadable on that attempt
```

None of these levels proves future durability.

## State model

The live conversation has exactly one attachment state:

```ts
export type ProviderAttachmentState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "runtime_only";
      readonly descriptor: ProviderAttachmentDescriptor;
    }
  | {
      readonly kind: "recorded";
      readonly descriptor: ProviderAttachmentDescriptor;
    };

export interface ProviderAttachmentDescriptor {
  readonly attachmentAttemptId: string;
  readonly internalSessionId: string;
  readonly adapterId: string;
  readonly mode: AgentMode;
  readonly model?: string;
  readonly acquiredAt: string;
  readonly transitionId?: string;
  readonly providerSessionRecordId?: string;
}
```

- `absent`: no provider thread is attached.
- `runtime_only`: the running process can use the provider thread, but local persistence
  must not select it on a later open.
- `recorded`: a provider row or authoritative transcript checkpoint already selects it as
  the continuation candidate.

`attachmentAttemptId` is a process-local correlation ID minted whenever a provider
attachment is installed: after `session/new` for a created thread and after `session/load`
for a loaded thread. For a created thread it identifies that specific acquisition even if a
provider reuses an `internalSessionId`. The eventual provider row ID is allocated by the
persistence commit and returned in its acknowledgement. A loaded attachment already carries
the row ID read from persistence. Acknowledgements therefore key on
`attachmentAttemptId`, not on a record ID that did not exist when the attempt began and not
on `internalSessionId` alone.

The existing public `conversation.internalSessionId` continues to expose the current live
ID. It does not communicate whether that ID is recorded. Internal code must stop using the
ambiguous `setInternalSessionId(next, created)` boolean and use explicit operations such as:

```ts
installCreatedProviderAttachment(descriptor); // runtime_only
installLoadedProviderAttachment(descriptor);  // recorded
markProviderAttachmentRecorded(acknowledgement);
clearProviderAttachment();
```

## Pending replacement state

A transition that has selected a live target without recording it must retain both sides:

```ts
interface PendingProviderTransition {
  readonly transitionId: string;
  readonly transitionKind: "handoff" | "switch" | "reset" | "mode_change";
  readonly previousRecordedAttachment: ProviderAttachmentDescriptor | null;
  readonly targetAdapterId: string;
  readonly targetMode: AgentMode;
  readonly targetAttachment: ProviderAttachmentState;
  readonly createdAt: string;
}
```

The previous recorded descriptor remains the restart fallback until target activation is
committed. This is also required for ACP-to-degraded transitions, whose target has no
provider session ID.

## Local commit boundary

For an Agent-owned first completed prompt, one SQLite transaction should:

1. Append the final assistant records selected by canonical capture policy.
2. If the current attachment is `runtime_only`, append its provider row and supersede the
   prior recorded mapping, if any.
3. Reset identity delivery for the newly recorded provider context when required.
4. Enqueue selected audit observations.
5. Commit.

The transaction returns an acknowledgement containing `attachmentAttemptId` and the
persisted `providerSessionRecordId`. The live state changes to `recorded` only when the
acknowledgement matches the currently installed attempt.

Provider attachment persistence is independent of assistant-message capture. A completed
turn records the attachment even when message capture is `none`.

Cancelled, failed, and interrupted turns retain whatever records their existing policies
select, but do not record a runtime-only attachment.

### Provider-completed crash window

The provider can complete—and may charge for—a turn before `afterPrompt()` commits local
response and attachment state. If the process dies in that window, the accepted outcome is:

- the provider response may be lost locally;
- the provider mapping remains absent or the prior mapping remains active;
- reopening starts fresh or uses the prior recorded attachment;
- the library does not automatically replay the prompt.

Consequently, “atomic first-turn commit” refers only to related local persistence writes.
It does not include provider execution.

### Metering boundary

Metering currently closes and `meteringRecorded()` commits before `afterPrompt()`. This is
intentional: provider work may have been paid for even when final response persistence
fails. Metering is therefore not part of the response-plus-attachment transaction.

A metering row means that provider work was observed; it does not mean that the response or
provider attachment was recorded. Implementation must verify that discarding or replacing
a runtime-only thread:

- preserves already accumulated operation records and aggregate cost;
- calls the appropriate metering thread-replacement logic;
- establishes the correct provider-cumulative baseline for the replacement; and
- never double-counts a settled operation during attachment commit failure.

## Stage 1: Agent-owned creation, load, and recovery

Stage 1 owns the SQLite path used by `Agent.conversations`.

### Create

```text
persist logical agc conversation
→ start provider
→ session/new
→ install runtime-only attachment
→ configure provider
→ return live conversation
```

No provider row is appended during `start()` merely because `session/new` succeeded.

On the first completed prompt, `afterPrompt()` performs the local commit described above.
If provider creation happens lazily during `prompt()`, the controller acquisition callback
must install the runtime-only descriptor at that time, with the actual acquisition time.

Stopping before a completed prompt clears the runtime-only attachment and leaves no active
provider mapping. The logical conversation and already selected canonical records remain.

### Load

```text
read active provider row
→ session/load(recorded internalSessionId)
→ install that same descriptor as recorded
→ return live conversation
```

A successful load must not append, rotate, or otherwise mutate provider rows. This requires
splitting create and load explicitly rather than removing the shared branch without
replacing the load semantics.

If another `open()` occurs while the conversation is already live, the manager returns or
rejects according to the existing single-live-instance contract; it must not create a
second provider thread or attachment attempt.

### Recovery

The recovery path around `src/agent.ts:614` already approximates the intended ordering:

```text
session/load fails
→ create replacement provider
→ seed checkpoint continuation
→ record replacement mapping after seed success
```

Stage 1 replaces the private `deferProviderSessionPersistence` exception with the common
attachment lifecycle. The failed recorded descriptor remains active during seeding. On
successful seed, the replacement is recorded and supersedes it. On seed failure, the
replacement is stopped and the previous recorded descriptor remains the restart candidate.

Historical rows are not repaired. They continue to be attempted. Recovery only helps when
checkpointing is enabled, the error is classified for recovery, and a usable checkpoint
exists. Although `onLoadFailure` defaults to `"recover"` in checkpoint configuration, that
default is not a universal migration strategy. Without applicable recovery, the load error
is returned to the consumer.

### Identity delivery

`identityDelivery.reset()` for a new provider context belongs in the same SQLite transaction
that records that context. A failed first prompt must not reset delivery state for a provider
attachment that was never selected. After commit, identity delivery acknowledgement follows
the existing successful-prompt contract.

### Stop and concurrency

Stopping during the first prompt must wait for the active prompt queue and its final owner
writes:

- if local confirmation commits first, the mapping is recorded before stop completes;
- otherwise no mapping is created and the runtime-only attachment is discarded.

A concurrent `open()` during that prompt must observe the existing live conversation and
must not start or load another provider thread.

### Stage 1 tests

- `create()` persists the logical conversation but no provider row.
- The live conversation exposes its runtime-only `internalSessionId`.
- Pre-prompt configuration remains usable.
- Stop before prompt leaves no active provider mapping.
- Reopening a never-prompted conversation creates a fresh provider thread.
- Failed, cancelled, and interrupted first prompts leave no mapping.
- The first completed prompt records the mapping.
- Attachment and final assistant records either both commit or both fail locally.
- Capture level `message: none` does not suppress attachment recording.
- A later completed prompt can record an attachment after an earlier failed prompt.
- Later prompts do not append duplicate provider rows.
- Lazy provider creation is captured and recorded correctly.
- Opening/loading an existing mapping does not rotate or append provider rows.
- Stop and concurrent-open races during the first prompt preserve the invariant.
- Recovery records a replacement only after successful seeding.
- Failed recovery retains the previous recorded mapping.
- Attachment persistence failure leaves the live attachment runtime-only.
- Deferred recording interacts correctly with `identityDelivery.reset()`.
- Discarding and replacing a runtime-only thread preserves metering totals and baselines.

## Stage 2: transitions and non-Agent-owned persistence

Stage 2 applies the invariant everywhere a fresh provider thread can replace another.

### Handoff and switch

The confirmation boundary for ordinary handoff/switch is successful continuation seeding:

```text
generate or accept source summary
→ create a separate target controller
→ install target as runtime-only
→ configure target
→ write target_created observation
→ send continuation seed
→ on seed completion, atomically activate/record target
→ switch live controller
→ stop source
→ finish transition
```

Until seed completion:

- the source controller remains live;
- the source provider mapping remains active;
- `target_activated` is not written;
- the target can be stopped without reconstructing the source.

Both same-adapter and cross-adapter transitions use a distinct target controller. Calling
`newSession()` on the source controller replaces its internal live thread too early and
makes rollback unreliable.

Transition event meanings are normative:

- `target_created`: the provider returned an ID; it remains runtime-only.
- `target_activated`: the target crossed the confirmation boundary and became the recorded
  continuation candidate.
- `completed`: the handoff/switch operation completed.
- `failed`: the operation failed, with `failedAfter` identifying the last completed stage.

### Optional target-prompt failure

An optional `targetPrompt` runs after a successful continuation seed. Seed completion has
already confirmed and activated the target. If the target prompt fails:

- the target remains active and recorded;
- the source is not resurrected;
- the handoff/switch call preserves its current rejection semantics;
- `AgentSessionHandoffError` carries the target session ID, attachment state `"recorded"`,
  metering records, and enough partial result information for a consumer to distinguish
  activation success from complete transition failure.

This is an operation failure after successful activation, not an activation rollback.
The structured error contract is:

```ts
class AgentSessionHandoffError extends Error {
  readonly handoffId: string;
  readonly fromInternalSessionId: string | null;
  readonly toInternalSessionId?: string;
  readonly providerAttachment?: "runtime_only" | "recorded";
  readonly activationCompleted: boolean;
  readonly summary?: string;
  readonly targetResult?: PromptResult;
  readonly meteringRecords: readonly OperationMeteringRecord[];
}
```

When a target prompt returns a non-completed result, that result is assigned to
`targetResult` before the handoff error is thrown. Failures before target creation omit the
target fields; failures before activation report `activationCompleted: false`.

### Promptless reset

`reset({ continuation: none })` has no provider turn with which to confirm its target:

- the live conversation may switch to the runtime-only target;
- the pending transition retains the previous recorded descriptor;
- the result reports `providerAttachment: "runtime_only"`;
- a restart falls back to the previous recorded attachment;
- the first later completed prompt records the target and activates the transition.

If reset includes a completed seed or target prompt, that completed provider turn may be the
confirmation boundary.

The first later prompt must finish its response and pending transition with one local atomic
operation. For v2 this likely requires a transcript operation such as
`finishOperationWithTransitionActivation(...)`, because separate terminal writes could
leave response state and authoritative continuation state disagreeing after a crash.

### Mode changes

- Degraded to ACP creates a runtime-only attachment and follows the regular first-turn
  confirmation rule.
- ACP to degraded has no replacement provider ID to record. The previous provider row
  remains the restart fallback while the process runs in degraded mode.
- ACP to ACP with a fresh thread follows regular replacement semantics.

The runtime `PendingProviderTransition` is mandatory for ACP-to-degraded fallback. If the
process stops or crashes while degraded, reopening uses the previous ACP attachment. A
later confirmed ACP attachment may supersede it normally. Persisting degraded mode as an
independent restart target is outside this version and is an accepted limitation.

### Direct/v2 ownership

Stage 2B is explicitly owned by the direct v2 transcript runtime:

- Initial checkpoints do not select a newly issued provider ID before a completed turn.
- `target_created` remains observational and does not change authoritative continuation.
- `target_activated` changes authoritative continuation only at the confirmation boundary.
- Promptless targets are ignored by reduction after restart until activated.
- The first later completed prompt combines prompt finalization and transition activation.

Opening a never-prompted direct conversation creates a fresh provider thread without
requiring recovery.

### Legacy/v1 ownership

Stage 2C is explicitly owned by the legacy transcript adapter. It must either:

1. implement the same runtime-only/recorded boundary in its representation; or
2. be documented and tested as an explicit legacy limitation before Stage 2 is closed.

It must not disappear into an unspecified later task. The v1 representation must not weaken
the v2 state machine.

### Stage 2 tests

- Same-adapter handoff retains the source through target seed completion.
- Cross-adapter switch retains the source through target seed completion.
- Seed failure stops the target and leaves source controller and mapping intact.
- No `target_activated` event or target provider row exists after seed failure.
- Successful seed records the target before stopping the source.
- Target-prompt failure rejects with an activated-target error contract and retains target.
- Promptless reset reports a runtime-only target.
- Restart after promptless reset uses the previous recorded mapping.
- First completed prompt after reset activates the pending target atomically.
- Crash/failure injection between target creation and seed preserves the source.
- ACP-to-degraded restart fallback retains the previous recorded descriptor.
- Degraded-to-ACP follows first-turn confirmation.
- Direct v2 creation has no authoritative provider ID before a completed prompt.
- Direct v2 reduction ignores unactivated targets.
- Direct v2 combined completion/activation survives truncation and failure injection.
- Legacy/v1 behavior is implemented and tested or called out as an accepted limitation.

## Public and internal observability

The ordinary prompt result need not expose attachment state. Transition APIs can produce a
runtime-only target without a completed prompt, so `HandoffResult` should include:

```ts
readonly providerAttachment: "runtime_only" | "recorded";
```

Structured transition errors must carry the same state when a target was created or
activated. This reports local lifecycle state only.

Provider-load success and failure remain observable through the existing open/recovery APIs
for this change. The later event-bus and error-record work will provide a common live and
durable observation contract; this lifecycle refactor must not invent a competing bus.

## Persistence and file organization

The attachment state model belongs with persistence lifecycle code:

```text
src/persistence/provider-attachment.ts
```

It contains state types, transition guards, and acknowledgement matching. It does not own a
controller or perform I/O.

Existing owners remain:

- `src/agent-session.ts`: live controller, runtime attachment, pending replacement.
- `src/agent-conversation-owner.ts`: live-to-owner lifecycle contract.
- `src/agent.ts`: Agent-owned SQLite lifecycle and manager coordination.
- `src/persistence/backend.ts`: provider-session repository contracts.
- direct transcript runtime: v2 authoritative checkpoint transitions.
- legacy transcript adapter: v1 compatibility behavior.

Do not create a new `src/conversation/` hierarchy for this single persistence-lifecycle
model, and do not add another unrelated abstraction over the existing owner boundary.

No SQLite schema migration is expected. `provider_sessions` continues to mean provider
attachments selected as future continuation candidates.

## Implementation sequence and commits

Each implementation commit must leave its owned path coherent; types are introduced with
their first consumer rather than as a disconnected types-only commit.

### Stage 1

1. `fix: defer sqlite provider attachment confirmation`
   - Add the attachment model.
   - Split create from load.
   - Add first-completed-prompt acknowledgement.
   - Fold checkpoint recovery into the same lifecycle.
   - Keep identity reset inside attachment confirmation.
2. `test: cover sqlite provider attachment lifecycle`
   - Include no-row-before-prompt, load without rotation, failure paths, stop/concurrent
     open, identity delivery, metering, and recovery.

Run targeted tests and a manual Claude or Codex create/stop/reopen/first-prompt/load test
before Stage 2 begins.

### Stage 2

3. `fix: confirm handoff targets after successful seeding`
   - Use separate target controllers.
   - Preserve source through target confirmation.
   - Define target-prompt failure results.
4. `fix: retain fallback attachments for promptless transitions`
   - Cover reset and mode changes, including ACP-to-degraded fallback.
5. `fix: align direct v2 provider attachment lifecycle`
   - Add combined completion/activation behavior and reducer tests.
6. `fix: align legacy v1 provider attachment lifecycle`
   - Implement the invariant or land the explicit, tested legacy limitation.
7. `test: verify provider attachment lifecycle end to end`
   - Run failure injection, shutdown races, transcript reduction, and real-provider smoke
     coverage.

Only after both stages pass review and end-to-end testing should work proceed to:

1. the generic committed-record event bus; and
2. conversation error records persisted and emitted through that bus.

## Acceptance criteria

The lifecycle work is complete when:

- no newly created provider ID is selected for future loading before a completed provider
  turn;
- opening a recorded provider session does not create another provider row;
- failed target seeding cannot destroy or supersede the valid source continuation;
- response/attachment atomicity claims are limited to local persistence;
- metering remains accurate across failures and replacements without being falsely included
  in that transaction;
- promptless and degraded transitions have an explicit previous-attachment fallback;
- target-prompt failure has a stable API contract;
- Agent-owned, recovery, direct/v2, and legacy/v1 paths each have an assigned outcome; and
- tests cover the identified concurrency, identity-delivery, metering, load-rotation, and
  transition regressions.
