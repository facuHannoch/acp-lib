# Internal inference runtime specification

Status: proposed design; implementation pending.

This document defines library-initiated model work that is not a participant turn in an
`AgentConversation`. Initial consumers are continuous conversation checkpoint generation,
conversation recovery, and agent-identity maintenance.

An internal inference is real provider work. It can take time, fail, consume tokens, and
produce billable usage. It must therefore be durable, observable, metered, cancellable,
and isolated from the provider thread serving the visible conversation.

The runtime must not make a completed user turn wait for background inference. A normal
turn waits only for its provider response, canonical persistence, and the inexpensive
durable enqueue of any resulting internal work.

---

## 1. Goals

1. Provide one reusable agent-level facility for AI work initiated by the library.
2. Run each inference in an isolated provider session without modifying a live
   conversation thread.
3. Make queued work survive process shutdown and agent reopening.
4. Let consumers observe background state without treating the conversation as busy.
5. Meter internal work without replacing the active conversation's provider baseline.
6. Reuse the agent's adapter registry and existing harness authentication where possible.
7. Permit consumers to replace the harness implementation with another inference service.
8. Establish a shared subscription contract reusable by conversations, turns, internal
   inferences, and future long-running operations.

## 2. Non-goals

- Defining the contents or scheduling policy of a conversation recovery checkpoint.
- Implementing identity extraction or consolidation.
- Reconstructing provider-private session files.
- Importing historical assistant/user messages into an ACP session.
- Treating internal inference output as a visible conversation message.
- Guaranteeing that a harness is authenticated. The runtime can reuse its environment and
  report authentication failure, but ACP does not standardize shared authentication.
- Keeping the owning conversation `isBusy` while background work executes.
- Providing distributed execution across machines in the first implementation.
- Claiming billing-grade inference coverage from ordinary ACP usage.

---

## 3. Terminology and identity

- `agentSessionId` identifies the durable agent owning the work.
- `agentConversationId` optionally identifies the conversation that caused the work.
- `internalInferenceId` identifies one durable execution attempt. IDs use the
  `aii-*` namespace.
- `internalSessionId` identifies the disposable provider thread used to perform an
  attempt. It is not the active provider thread of the owning conversation.
- An **execution attempt** is one durable `internal_inferences` row and one invocation of
  a runtime. Every retry receives a new `internalInferenceId` and may acquire a different
  `internalSessionId`.
- A **retry chain** is the original attempt plus all attempts linked to its root. It is a
  runtime projection, not an additional database record.
- A **runtime** performs one request. A **coordinator** persists, schedules, claims,
  retries, and publishes state for durable work.

Initial purposes are:

```ts
export type BuiltinInternalInferencePurpose =
  | "conversation_checkpoint"
  | "conversation_recovery"
  | "identity_update";

export type InternalInferencePurpose =
  | BuiltinInternalInferencePurpose
  | (string & {});
```

Purpose is extensible. Unknown persisted purposes must not execute unless the agent's
strategy registry contains the exact persisted strategy ID and version for that purpose.

---

## 4. Shared subscription contract

`Subscribable`, not `Subscriptable`, is the public name. A subscriptable value supports
indexing; a subscribable object publishes events.

```ts
export type Listener<TEvent> = (event: TEvent) => void;
export type Unsubscribe = () => void;

export interface Subscribable<TEvent> {
  subscribe(listener: Listener<TEvent>): Unsubscribe;
}

export interface StatefulSubscribable<TSnapshot, TEvent>
  extends Subscribable<TEvent> {
  readonly snapshot: TSnapshot;
}
```

The implementation uses composition through a shared `SubscriptionHub<TEvent>`, not a
base-class hierarchy. The hub must:

- Return an idempotent unsubscribe function.
- Snapshot listeners before emission so subscribe/unsubscribe during a callback is safe.
- Isolate listener exceptions from the operation and from other listeners.
- Preserve registration order for one emission.
- Never await listener work or treat it as operation authority.

Subscription events are ephemeral. Durable inference state lives in persistence and can
be queried after process restart. A subscriber must read `snapshot` before relying on
later events, because subscription does not replay an unbounded history.

Existing subscription implementations may migrate incrementally. Introducing the common
contract does not require rewriting every event producer in the first slice.

---

## 5. Runtime contract

The low-level runtime performs exactly one attempt and owns no durable queue policy.

```ts
export interface InternalInferenceRequest {
  readonly internalInferenceId: InternalInferenceId;
  readonly purpose: InternalInferencePurpose;
  readonly agentSessionId: AgentSessionId;
  readonly agentConversationId?: AgentConversationId;
  readonly adapterId: string;
  /** Rendered just before execution; not the durable source of truth. */
  readonly prompt: string;
  readonly cwd?: string;
  readonly metadata?: string;
}

export interface InternalInferenceInputDescriptor {
  readonly version: number;
  readonly strategyId: string;
  readonly payload: PersistenceJsonValue;
}

export interface InternalInferenceResult {
  readonly internalInferenceId: InternalInferenceId;
  readonly internalSessionId: string;
  readonly adapterId: string;
  readonly model: string | null;
  readonly messages: readonly ResponseMessage[];
  readonly usage: TokenUsage | null;
  readonly stopReason?: string;
  readonly metadata?: string;
}

/** Durable result exposed after purpose-specific validation and publication. */
export interface InternalInferenceCompletion {
  readonly internalInferenceId: InternalInferenceId;
  readonly rootInternalInferenceId: InternalInferenceId;
  readonly internalSessionId: string;
  readonly purpose: InternalInferencePurpose;
  readonly artifactId?: string;
  readonly meteringOperationId?: string;
  readonly completedAt: string;
  readonly metadata?: string;
}

export interface InternalInferenceRuntime {
  run(
    request: InternalInferenceRequest,
    signal?: AbortSignal,
  ): Promise<InternalInferenceResult>;
}

export interface InternalInferenceStrategy<TPayload = PersistenceJsonValue> {
  readonly strategyId: string;
  readonly purpose: InternalInferencePurpose;
  readonly version: number;
  validatePayload(payload: PersistenceJsonValue): TPayload;
  prepare(
    context: InternalInferencePreparationContext,
    payload: TPayload,
  ): Promise<PreparedInternalInference>;
  complete(
    context: InternalInferenceCompletionContext,
    result: InternalInferenceResult,
  ): Promise<InternalInferenceCompletion>;
  classifyError(error: unknown): InternalInferenceRetryDisposition;
}
```

`messages` is canonical. A flattened `text` may be provided as a convenience projection,
but checkpoint or identity code must make its flattening policy explicit when message
boundaries matter.

The runtime does not persist the request, choose when it should run, or decide whether it
should retry. Those are coordinator responsibilities. The coordinator persists the input
descriptor, resolves its registered strategy and exact version, validates its payload,
reads its canonical source
records, and renders `prompt` immediately before execution. It must not persist raw
environment secrets or duplicate the complete conversation in the descriptor. An unknown
strategy or descriptor version fails terminally rather than silently using a different
prompt.

Strategies own input preparation, result validation/publication, and error classification.
Runtimes only execute prepared model work. A strategy registry belongs to the agent-level
subsystem; persisted jobs never contain executable callbacks.

---

## 6. Default harness-backed runtime

The default implementation uses an isolated `AgentController`:

```text
resolve adapter registration
→ construct restricted controller
→ initialize harness
→ session/new
→ session/prompt
→ collect session/update messages
→ return normalized result
→ stop controller in finally
```

It reuses the adapter definition and execution/security profile selected from the owning
`Agent` registry, including the harness command, launcher, working directory, spawn
environment, container boundary, authentication environment, network boundary, and other
relevant settings. It must never reuse the live `AgentConversation` controller or its
`internalSessionId`, and it must not silently start the harness in a different environment.
Persisted work stores stable adapter/profile identifiers; launchers, environment values,
and secrets are resolved from the live `Agent.open()` configuration.

`AgentController.prompt()` already folds `session/update` traffic into response messages;
the inference runtime must not implement a second ACP response assembler.

Default restrictions are:

- No additional MCP servers unless explicitly allowed by internal-inference policy.
- No consumer-provided tool handlers by default.
- Permission requests cancelled.
- No automatic fallback to degraded PTY mode.
- The source conversation's working directory and isolation boundary.
- No mutation of conversation configuration or provider-session history.

ACP capability announcements do not disable filesystem or terminal tools implemented by
the harness itself. The prompt should instruct the model not to use tools, but that is only
behavioral guidance. Actual restriction requires the consumer's existing OS/container
sandbox, read-only mounts, namespaces, or a custom launcher. The library must preserve
that boundary and must not claim that an isolated provider session is itself a security
sandbox.

The default adapter policy is `"same"`, meaning the active adapter of the conversation
that caused the job at enqueue time. Enqueue resolves this policy immediately and persists
the concrete `adapterId` and execution-profile ID. A later conversation switch therefore
does not change already queued work. Consumers may select a fixed registered adapter for
cheaper or more specialized internal work.

---

## 7. Durable persistence

SQLite schema versioning adds an `internal_inferences` table. The logical schema is:

```text
internal_inferences
- internal_inference_id         primary key
- root_internal_inference_id
- retry_of_internal_inference_id nullable
- attempt_number
- agent_session_id
- agent_conversation_id         nullable foreign key
- purpose
- status
- adapter_id
- execution_profile_id          nullable
- input_json
- model                         nullable
- internal_session_id           nullable
- source_checkpoint_id          nullable
- source_from_sequence          nullable
- source_through_sequence       nullable
- requested_at
- started_at                    nullable
- completed_at                  nullable
- next_attempt_at               nullable
- worker_id                     nullable
- lease_token                   nullable
- lease_expires_at              nullable
- heartbeat_at                  nullable
- revision
- result_json                   nullable
- error                         nullable
- failure_code                  nullable
- metering_operation_id         nullable
- metadata                      nullable
```

Checkpoint-chain coordination uses a second small table rather than overloading an
execution attempt:

```text
internal_inference_chains
- root_internal_inference_id    primary key
- agent_session_id
- agent_conversation_id         nullable
- purpose
- status                        active | completed | failed | cancelled
- active_internal_inference_id  nullable
- requested_through_sequence    nullable
- revision
- created_at
- updated_at
```

For checkpoint work, a partial unique database constraint permits at most one `active`
chain per conversation and purpose. Triggering checkpoint work atomically creates that
chain or advances its `requested_through_sequence`. The table is coordination state, not
an additional execution attempt or provider operation. Retry attempts remain in the same
chain. When successful work still leaves a later requested boundary, completion closes the
old chain and creates a new active chain and root attempt in the same transaction. Once no
later boundary remains, the chain becomes `completed`; a future trigger creates a new
chain.

Statuses are:

```ts
export type InternalInferenceStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
```

`result_json` stores operational result metadata, not a duplicate of a checkpoint or
identity projection produced by the inference. For example, it may reference the
`checkpointId` produced by a checkpoint job.

`input_json` is the versioned `InternalInferenceInputDescriptor`. Inputs refer to canonical
records by sequence boundary rather than duplicating them. The purpose-specific
coordinator reconstructs the prompt from those durable sources. Sensitive prompts,
environment data, and summaries must not be copied into generic metadata by default.

The dedicated source/checkpoint columns are indexed projections used for claiming and
coalescing. `input_json` remains the immutable semantic source of truth. Enqueue validates
that projections match the strategy payload and writes both atomically; callers cannot
update them independently. `requested_through_sequence` belongs to chain coordination and
is not part of an immutable attempt input.

One row represents exactly one actual execution attempt. A failed, cancelled, abandoned,
or completed row is immutable as an attempt. A retry inserts another row with a new ID,
the same root ID, `retry_of_internal_inference_id` pointing to the preceding attempt, and
an incremented `attempt_number`. No separate attempts table is needed.

Persistence exposes enqueue, claim, complete, fail, cancel, get, and paginated list
operations. Every state transition uses compare-and-swap semantics against the expected
status, revision, and lease owner. A worker must not complete work it no longer owns.

---

## 8. Enqueue and background semantics

A visible prompt follows this ordering:

```text
provider response settles
→ canonical turn records and eligible internal-work enqueue commit atomically
→ prompt result returns
→ background coordinator claims and executes work
```

The model call is never awaited by `conversation.prompt()`. For automatic work in the same
SQLite database, the canonical records, chain trigger/update, and enqueue are one durable
turn-finalization transaction. This removes the crash window in which a response exists
without its required checkpoint job. Explicit consumer-initiated enqueue remains an
independent transaction.

If atomic turn finalization fails, neither the canonical records nor automatic enqueue is
committed. For persistence backends unable to provide this transaction, capabilities must
report that limitation and policy determines whether automatic work is unsupported or
best-effort; it must not be represented as atomic durability.

Internal work does not set `conversation.isBusy`. It has its own snapshot and events.

---

## 9. Coordinator and concurrency

`Agent` owns an `InternalInferenceCoordinator`. It:

- Restores durable queued work when the agent opens.
- Recovers stale `running` work by terminally fencing it and creating a linked retry.
- Claims jobs with compare-and-swap persistence.
- Enforces an agent-wide concurrency limit.
- Enforces purpose-specific coalescing rules.
- Resolves adapters from the agent registry.
- Invokes the configured runtime.
- Persists completion or failure before emitting terminal events.
- Stops launching work when agent shutdown begins.

Multi-process coordination is part of the initial implementation because more than one
process may open the same agent database. A claim atomically changes an eligible `queued`
row to `running`, assigns `worker_id` and a unique `lease_token`, establishes
`lease_expires_at`, and increments its revision. Only the holder of the current lease token
may heartbeat, cancel, fail, or complete that attempt.
Heartbeats extend the lease while the runtime remains active.

Initial defaults are a 30-second lease and a 10-second heartbeat interval, configurable
for slow or remote persistence. Timestamps are UTC instants produced and compared by the
SQLite connection executing the transition, avoiding worker clock disagreement. A
`worker_id` identifies one coordinator process instance; the random lease token fences
late continuations from an earlier claim by that same process.

An expired lease does not cause the same execution row to run again. The coordinator marks
the stale attempt terminal (`failed` with an abandonment reason) and creates a new linked
retry row when policy permits. This preserves the invariant that one row describes one
provider execution and avoids concurrent workers writing different outcomes into one row.
Lease fencing prevents duplicate publication, not necessarily duplicate provider cost: an
unreachable worker may continue consuming tokens until its process or controller stops.
Internal work must therefore remain side-effect-free at the strategy level, and consumers
must size leases conservatively.

Checkpoint jobs coalesce per conversation through `internal_inference_chains`. At most one
active `conversation_checkpoint` chain may exist for a conversation. A later trigger advances
`requestedThroughSequence` rather than launching a concurrent summarizer from the same
old checkpoint. `sourceThroughSequence` is immutable for an attempt, so its successful
artifact covers only the source it actually read. If `requestedThroughSequence` is later,
the coordinator schedules a new job starting from the newly published checkpoint. There
is at most one active checkpoint chain per conversation.

The default agent-wide concurrency should be conservative, initially one. Consumers may
raise it when their harness and resource limits permit parallel subprocesses.

---

## 10. Retry and stale-work recovery

An attempt failure never changes a successfully completed user turn. It persists the
error and emits an internal-inference event.

Retry policy is owned by the coordinator:

```ts
export interface InternalInferenceRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: readonly number[];
}

export type InternalInferenceRetryDisposition =
  | { readonly kind: "terminal"; readonly code: string }
  | { readonly kind: "retryable"; readonly code: string };
```

`maxAttempts` includes the initial attempt. `backoffMs[n]` is the delay before attempt
number `n + 2`; when fewer delays than retries are supplied, the last delay is reused.

Rules:

- An execution row starts with its immutable `attemptNumber` and becomes `running` only
  after a successful lease claim.
- A retryable failure makes that attempt terminal and inserts a new `queued` row with a
  new inference ID and `nextAttemptAt`.
- A terminal failure stores `failed` and retains its error.
- Authentication and unsupported-purpose errors are terminal by default.
- Process crashes leave `running`; a coordinator may recover it only after its durable
  lease expires, by terminating that attempt and creating a linked retry.
- Retrying never publishes a partial purpose-specific output.
- A completed job is immutable and cannot be retried under the same ID.

Failure cause, not merely `AbortError`, controls retry behavior:

- Explicit consumer cancellation is terminal `cancelled` and is never retried.
- Agent shutdown interruption is recorded as abandoned and is retryable.
- Lease expiration is recorded as abandoned and is retryable.
- Runtime timeout is classified by strategy/policy and is retryable by default.
- Unsupported strategy/version, authentication failure, and malformed validated output
  are terminal by default.

The original attempt's handle rejects when that attempt fails. An `InternalInferenceRun`
is the virtual retry-chain handle. It follows `rootInternalInferenceId` to the active
attempt and settles only when the chain completes, is explicitly cancelled, or exhausts
policy. It adds no database row. Attempt-specific inspection remains available by ID.

---

## 11. Cancellation and shutdown

Queued jobs can become `cancelled` without starting a harness. Running cancellation
aborts the runtime signal, interrupts the controller when possible, stops the subprocess,
and persists `cancelled` only after cleanup is attempted.

Ordinary `agent.close()` must not wait for background model completion:

```text
stop accepting/claiming jobs
→ abort running attempts
→ wait for bounded cleanup (`shutdownGraceMs`, initially 2 seconds)
→ force-stop remaining controllers
→ transactionally fence owned attempts and create eligible linked retries
→ close persistence
```

Queued work remains queued. Once the grace period expires, the coordinator invalidates
each remaining lease token transactionally before closing persistence. Local execution
objects are detached from the repository, so late promise continuations cannot write even
if they settle after close. A fenced attempt can never publish; its linked retry is the
only resumable work. Force-stopping controllers and fencing their writes must finish before
SQLite closes.

An explicit future drain option may wait for completion:

```ts
await agent.close({ internalWork: "drain" });
```

It is not required for the initial implementation and must never become the default.

---

## 12. Observation and progress

An `InternalInference` attempt handle implements:

```ts
export interface InternalInference
  extends StatefulSubscribable<InternalInferenceSnapshot, InternalInferenceEvent> {
  readonly id: InternalInferenceId;
  readonly result: Promise<InternalInferenceCompletion>;
  cancel(): Promise<void>;
}

export interface InternalInferenceRun
  extends StatefulSubscribable<InternalInferenceRunSnapshot, InternalInferenceEvent> {
  readonly rootId: InternalInferenceId;
  readonly activeAttempt: InternalInference;
  readonly result: Promise<InternalInferenceCompletion>;
  cancel(): Promise<void>;
}
```

`agent.internalInferences.enqueue()` durably enqueues and returns this handle quickly.
Background checkpoint scheduling does not await `result`; synchronous recovery work may.
The handle resolves to the durable, validated completion rather than the runtime's raw
provider response. Reopening a completed inference therefore resolves immediately from
the persisted artifact reference and completion metadata without duplicating raw output;
failed and cancelled attempt handles reject. `InternalInferenceRun.result` follows linked
attempts and is the handle used when recovery must await the eventual result.

The agent exposes an `InternalInferenceManager` with `enqueue`, `getAttempt`, `getRun`,
paginated `list`, `cancel`, and `subscribe`. `enqueue` returns an
`InternalInferenceRun`; its `activeAttempt` exposes the first row immediately. The manager,
individual handles, run projections, and durable status all refer to the same persisted
operations.

Minimum snapshot:

```ts
export interface InternalInferenceSnapshot {
  readonly id: InternalInferenceId;
  readonly rootId: InternalInferenceId;
  readonly retryOfId?: InternalInferenceId;
  readonly revision: number;
  readonly purpose: InternalInferencePurpose;
  readonly status: InternalInferenceStatus;
  readonly stage: InternalInferenceStage;
  readonly adapterId: string;
  readonly agentConversationId?: AgentConversationId;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly attemptNumber: number;
  readonly progress?: {
    readonly completed: number;
    readonly total?: number;
    readonly percentage?: number;
  };
  readonly error?: string;
}
```

Initial stages are:

```ts
export type InternalInferenceStage =
  | "queued"
  | "claiming"
  | "preparing_input"
  | "starting_harness"
  | "creating_session"
  | "prompting"
  | "persisting_result"
  | "completed"
  | "retry_wait"
  | "failed"
  | "cancelled";
```

Percentages appear only when a meaningful total exists. Harness initialization and model
generation are indeterminate stages rather than fabricated percentages.

State transitions may be observed through:

- The individual inference handle.
- Agent-level `internal_inference_changed` events.
- Purpose-specific conversation events referencing `internalInferenceId`.

Persisted status is authoritative. Progress between durable transitions is ephemeral.
Snapshots and events carry monotonically increasing revisions; consumers must ignore an
event older than the latest revision they have observed.

---

## 13. Metering

Internal inference consumes real tokens. Every attempt capable of provider inference must
produce an `OperationMeteringRecord`, including failed attempts when usage is available.

Metered operation kinds expand to include:

```ts
type InternalMeteredOperationKind =
  | "conversation_checkpoint"
  | "conversation_recovery"
  | "identity_update";
```

The record is attributed to the owning agent and, when present, the causing conversation.
It references the disposable `internalSessionId` and `internalInferenceId`.

The disposable session must not replace `conversation_metering_state.activeBaseline`.
That baseline belongs to the active visible conversation thread. The metering engine must
provide a detached-operation accrual path: the new disposable session starts from a
trusted zero baseline, produces a normal immutable operation record, increments logical
totals and operation counts, and leaves the visible thread's active baseline unchanged.
Reusing the conversation's cumulative-delta path directly is invalid because the
disposable thread has independent counters.

Conversation-caused work is attributed to that conversation. Agent-level identity work
without a conversation is attributed to an agent-level internal metering scope rather
than arbitrarily changing a conversation's totals.

The internal inference row stores `meteringOperationId`; normalized details live in
`metering_records` according to the configured retention policy:

```ts
export type MeteringRecordRetention = "all" | "none" | { retain: number };
```

The cumulative metering state is always persisted. `"all"` retains every detailed record,
`{ retain: 100 }` keeps the latest 100 detailed records in that scope, and `"none"` keeps
no full record history. Pruning old operation details does not subtract their already
accrued totals. Consumers requiring authoritative permanent billing history should export
records to their own billing repository; metering enforcement and detail retention are
independent settings. Idempotency is guaranteed for the retained operational window and
need not create indefinite tombstones for deliberately pruned records.

Each attempt has at most one metering operation ID. Successful completion persists it as
part of the completion transaction. When a failed attempt reports usage, the failure
status, detailed record when retained, cumulative state, and any linked retry row are
committed in one transaction. Repeating finalization for the same attempt is idempotent;
it cannot accrue totals twice. Metering persistence must complete before an inference
becomes durably `completed` or terminally `failed` with known usage.

---

## 14. Relationship to conversation records and produced artifacts

An internal inference is operational state, not itself a chat message. It is stored in
`internal_inferences` rather than flattened into `conversation_records`.

Purpose-specific durable artifacts reference the inference that produced them. For a
future checkpoint:

```text
conversation_checkpoint.generator_internal_inference_id → internal_inferences
```

The conversation timeline may also contain a `native_action` record that references the
inference and artifact:

```json
{
  "kind": "native_action",
  "action": "conversation_checkpoint",
  "state": "completed",
  "output": {
    "internalInferenceId": "aii-...",
    "checkpointId": "chk-...",
    "coveredSequence": 142
  }
}
```

This record explains the action chronologically without duplicating provider protocol,
prompt input, summary output, or metering details.

Internal inference input and output must not update agent identity merely because they
were generated. The purpose-specific consumer decides whether a completed artifact feeds
identity projection.

Completion is one SQLite transaction. It validates and writes the purpose-specific
artifact, metering record and cumulative state, optional timeline `native_action`, and the
inference's `completed` transition together. The runtime only returns a normalized result;
the purpose completion handler owns validation and publication. If the transaction fails,
the attempt is not completed and no partial artifact is visible.

Artifacts are retained independently of operational inference rows. References to an
inference are soft/opaque or nullable so pruning old runtime details never cascades into
deleting checkpoints, conversation records, or metering totals.

---

## 15. Consumer configuration

Proposed agent configuration:

```ts
const agent = await Agent.open({
  // existing configuration
  internalInference: {
    runtime: new HarnessInternalInferenceRuntime(),
    adapter: "same",
    maxConcurrency: 1,
    retry: {
      maxAttempts: 3,
      backoffMs: [1_000, 10_000, 60_000],
    },
    shutdownGraceMs: 2_000,
    retention: "all", // or { retain: 100 }
  },
});
```

The exact default-runtime constructor may remain internal. A consumer-supplied runtime is
responsible for producing normalized results but not for persistence or scheduling.

The runtime is optional until a feature requiring it is enabled. Opening an agent without
internal-inference configuration must not spawn a harness or background worker.

`internalInference.retention` controls completed/terminal operational rows independently
from checkpoint and metering retention. `"all"` is supported and is the initial SQLite
default. A bounded `{ retain: number }` policy may prune the oldest terminal rows after
their artifacts are safely published; queued/running rows and required retry-chain state
are never removed.

---

## 16. Failure semantics

- Provider/harness failure marks the inference failed or retryable; it does not roll back
  the user turn that caused it.
- Persistence failure prevents publication of purpose-specific output and prevents a
  completed status.
- Listener failure is logged or ignored and never changes operation state.
- Unsupported adapter or purpose fails before spawning a process.
- A missing conversation referenced by queued work cancels or terminally fails the job;
  it must not recreate a deleted conversation.
- Malformed model output is a purpose-specific validation failure, not a successful raw
  completion.
- If usage is unavailable, the metering record says so; it never fabricates zero usage.
- Partial provider output may be retained for diagnostics according to capture policy but
  is not published as a successful checkpoint or identity artifact.

---

## 17. Code organization

Internal inference is a vertical feature package. New implementation files must not be
added as a collection of root-level `src/internal-inference-*.ts` modules, and inference
SQL must not enlarge the monolithic `persistence/sqlite-backend.ts`.

```text
src/
  observation/
    contracts.ts
    subscription-hub.ts

  internal-inference/
    index.ts
    contracts.ts
    config.ts
    errors.ts

    runtime/
      runtime.ts
      harness-runtime.ts
      execution-profile.ts

    strategy/
      strategy.ts
      registry.ts

    coordination/
      manager.ts
      attempt-handle.ts
      run-handle.ts
      coordinator.ts
      claim-loop.ts
      retry-policy.ts
      shutdown.ts

    persistence/
      repository.ts
      records.ts
      sqlite-repository.ts
      sqlite-schema.ts

    testing/
      deterministic-runtime.ts

  checkpointing/
    index.ts
    config.ts
    schedule.ts
    strategy.ts
    prompt.ts
    artifact.ts
    recovery.ts
```

`observation` is shared infrastructure rather than an internal-inference child because
conversations, turns, and future operations may adopt it. `checkpointing` is a consumer of
the generic runtime and owns checkpoint prompts, schedules, payloads, artifacts, and
recovery behavior. Identity-specific inference likewise remains in the identity feature.

The dependency direction is:

```text
Agent composition root
  → internal-inference coordination
    → strategy + runtime + repository contracts
      → shared observation/contracts

checkpointing/identity
  → register strategies with internal inference

SQLite persistence
  → implements the internal-inference repository
```

The coordinator orchestrates but does not contain SQL, ACP response assembly, purpose
prompts, or artifact schemas. `claim-loop.ts` owns polling, concurrency permits, claims,
heartbeats, and lease fencing. The attempt and run handles own their respective promise
and subscription projections. `Agent` only constructs the subsystem, exposes
`agent.internalInferences`, and delegates bounded shutdown.

The internal-inference repository is a focused capability exposed by persistence rather
than dozens of new top-level `PersistenceBackend` methods. The initial integration may use
an optional feature repository to avoid a broad persistence refactor:

```ts
interface PersistenceBackend {
  // Existing members.
  readonly internalInferences?: InternalInferenceRepository;
}
```

SQLite schema migration registration may remain centralized, but its inference DDL and
queries live in the feature repository. Shared SQLite connection and transaction helpers
are injected so automatic turn finalization and inference enqueue can participate in the
same transaction.

Files should remain responsibility-focused. A file approaching roughly 500 lines is a
signal to split it; it is not a mechanical limit. Tests mirror the subsystem boundaries
under `test/internal-inference/` rather than accumulating in one integration file.

---

## 18. Implementation slices

### Slice 1: shared observation primitives

- Add `Subscribable`, `StatefulSubscribable`, `Listener`, and `Unsubscribe`.
- Add internal `SubscriptionHub` with exception isolation tests.

### Slice 2: contracts and SQLite persistence

- Add internal-inference IDs, request/result/snapshot/event contracts.
- Add schema migration, chain coordination, and persistence repository.
- Test state transitions, input descriptors, leased CAS claims, pagination, linked retry
  scheduling, heartbeats, expiration, and stale rows.

### Slice 3: harness runtime

- Implement restricted disposable `AgentController` execution.
- Verify separate provider sessions and cleanup on success, failure, and abort.

### Slice 4: agent coordinator

- Add strategy registry and attempt/run handles.
- Restore queued work on open.
- Claim with bounded concurrency.
- Retry and cancel.
- Stop with bounded cleanup on `Agent.close()`.
- Publish agent and handle events.

### Slice 5: metering

- Add internal operation kinds and disposable-session attribution.
- Add detached-operation accrual and preserve the visible conversation baseline.
- Persist metering before durable completion.

### Slice 6: first consumer

- Implement continuous conversation checkpointing in a separate specification.
- Keep schedule, summary prompt, checkpoint schema, and recovery policy outside this
  runtime specification.

---

## 19. Required tests

1. Automatic enqueue and canonical conversation records commit atomically before the
   caller observes turn-finalization success.
2. A visible prompt can finish while its internal inference remains queued or running.
3. Internal work does not set `conversation.isBusy`.
4. The harness runtime creates a provider session distinct from the conversation thread.
5. Response message boundaries are preserved.
6. No additional MCP servers, permissions, or client tools are exposed by default; tests
   do not misrepresent this as disabling harness-native filesystem or terminal tools.
7. Listener exceptions do not fail work or suppress other listeners.
8. Unsubscribe is idempotent.
9. Snapshot reflects durable terminal state for late subscribers.
10. Duplicate claims cannot execute the same inference concurrently, including from two
    processes opening the same database.
11. Only the lease owner can heartbeat or terminate a running attempt.
12. An expired running attempt becomes terminal and recovery creates a new linked ID.
13. Retry creates a new row with the correct root, predecessor, and attempt number.
14. Explicit cancellation never retries, while shutdown, lease expiration, and retryable
    timeout follow their specified classifications.
15. Agent close performs bounded abort/lease cleanup, fences late continuations, and leaves
    work recoverable.
16. A completed artifact, timeline action, and metering state commit atomically with
    completed status.
17. Failed-attempt usage, failure state, totals, and linked retry commit atomically and
    repeated finalization cannot double-accrue usage.
18. Internal metering does not replace the visible conversation baseline.
19. `meteringRecords: "none"` and bounded retention preserve cumulative state without an
    unbounded detail history.
20. Durable input can be rendered after process restart without persisting secrets or a
    duplicate transcript; unknown strategy versions fail.
21. A completed attempt handle reopened from persistence settles immediately, and a run
    handle follows linked retries to eventual completion or exhaustion.
22. Snapshot revisions let consumers discard stale events.
23. Database-enforced coalescing prevents two processes from creating concurrent active
    checkpoint chains.
24. Coalescing never claims that a checkpoint covers records beyond its immutable source
    boundary, and schedules follow-up work when requested input advanced.
25. Resolving adapter `"same"` at enqueue makes queued execution stable across a later
    conversation adapter switch.
26. Purpose-specific output is not published after malformed or partial completion.
27. Existing conversation and controller subscription behavior remains compatible.

---

## 20. Deferred questions

- Whether prompts/results receive an optional encrypted diagnostic store.
- Whether a dedicated cheap default model can be selected portably across harnesses.
- Whether `AgentTurn` becomes a first-class `StatefulSubscribable` operation in the same
  release or a later refactor.
- Whether explicit drain-on-close is valuable after durable background resumption exists.

These questions do not block the initial runtime contract.
