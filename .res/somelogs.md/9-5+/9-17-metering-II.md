






For metering, we need to connect the existing live metering engine to SQLite. The calculation logic mostly exists; the missing piece is durable storage and restoration.

I would implement it as a focused subsystem, independent from conversation recovery.

## 1. Add durable metering storage

Use two related structures.

An immutable record table:

```text
metering_records
- metering_record_id
- agent_session_id
- agent_conversation_id
- operation_id
- internal_session_id
- adapter_id
- inference_sequence
- observed_at
- usage_json
- pricing_json
- metadata
```

And a current-state table:

```text
conversation_metering_state
- agent_conversation_id
- revision
- state_json
- updated_at
```

Why both:

- `metering_records` provides auditability and detailed history.
- `conversation_metering_state` allows fast restoration without recalculating every historical record.

I would not put metering state into `conversation_checkpoints` yet because those checkpoints are currently unused and their recovery semantics are still being designed. Metering can be completed independently.

## 2. Add a persistence contract

Something like:

```ts
interface MeteringPersistence {
  commit(input: {
    records: readonly MeteringRecord[];
    nextState: MeteringState;
    expectedRevision?: number;
  }): Promise<PersistedMeteringState>;

  state(
    conversationId: AgentConversationId,
  ): Promise<PersistedMeteringState | null>;

  list(
    conversationId: AgentConversationId,
    options?: MeteringListOptions,
  ): Promise<MeteringRecordPage>;

  listByOperation(
    operationId: string,
  ): Promise<readonly MeteringRecord[]>;
}
```

`commit()` should transactionally:

1. Insert any new metering records.
2. Deduplicate them by stable ID.
3. Update the cumulative state.
4. Increment its revision.

This is essentially what the test’s external `UsageRepository` currently does, but moved into the persistence backend.

## 3. Persist ordinary prompt metering

A completed prompt already returns:

```ts
result.metering
```

The agent-owned lifecycle currently persists the user and assistant messages but ignores this value.

After a prompt finishes, it should atomically persist:

- Assistant messages.
- Metering record or records.
- Updated cumulative metering state.

The records and metering should share `operationId`, allowing consumers to correlate them without copying usage into every message.

## 4. Persist failed-operation usage

This is important: a failed or cancelled prompt may still have consumed tokens.

The current owner lifecycle’s failure callback receives:

```ts
{
  messages,
  error,
}
```

It likely needs to receive any metering records produced before failure as well:

```ts
{
  messages,
  error,
  meteringRecords,
  nextMeteringState,
}
```

Otherwise failures can cause unrecorded billable usage.

## 5. Persist internal-operation metering

Handoff and switch already collect `meteringRecords` for operations such as:

- Generating the continuation summary.
- Seeding the replacement thread.
- Sending the optional target prompt.

Those records are returned from the operation but are not persisted by the new SQLite owner.

The owner lifecycle needs a metering commit hook usable by:

- Normal prompts.
- Handoff.
- Switch.
- Recovery.
- Future agent-initiated tool operations.

This argues for a general internal callback, rather than embedding persistence logic in every command:

```ts
ownerLifecycle.commitMetering({
  operationId,
  records,
  nextState,
});
```

## 6. Restore state before opening the provider thread

When opening an existing conversation:

```ts
const persistedMetering =
  await persistence.metering.state(conversationId);
```

That state must be supplied when constructing `AgentConversation`:

```ts
metering: {
  ...configuredMetering,
  initialState: persistedMetering?.state,
}
```

This must happen before the first new prompt. Otherwise cumulative provider counters may be attributed incorrectly after reopening.

## 7. Handle provider-session replacement

Metering state spans the logical `AgentConversation`, but its baselines are associated with provider sessions.

When recovery, reset, handoff, or switch creates a new provider thread:

- Preserve lifetime conversation totals.
- Start a new provider-session baseline.
- Record the new `internalSessionId`.
- Avoid interpreting the new session’s counters as continuations of the deleted session’s counters.

The existing `MeteringEngine.onThreadReplaced()` and engine reconstruction during handoff already contain much of this logic. We need to ensure its resulting state is committed to SQLite.

## 8. Decide record granularity

Use one row per actual metering observation/inference, not necessarily one row per visible prompt.

A normal provider may produce one record:

```text
operation A → inference 1
```

A tool-heavy turn might produce several:

```text
operation A → inference 1
operation A → inference 2
operation A → inference 3
```

The uniqueness constraint can be:

```text
(operation_id, inference_sequence)
```

or preferably a library-generated stable `metering_record_id`.

## 9. Keep pricing results reproducible

Each immutable record should retain enough information to explain the amount later:

- Raw reported usage.
- Attributable delta.
- Model.
- Provider/adapter.
- Pricing source/version.
- Rated amounts and currency.
- Coverage status.
- Any unavailable/ambiguous status.

We should not recalculate old invoices using whatever pricing catalog happens to be installed later.

## 10. Expose it through the Agent API

At minimum:

```ts
agent.persistence.metering.state(conversationId);
agent.persistence.metering.list(conversationId);
agent.persistence.metering.listByOperation(operationId);
```

A friendlier conversation-level API can sit on top:

```ts
conversation.meteringSnapshot;
conversation.listMetering();
```

The existing live `conversation.meteringSnapshot` should reflect the restored state.

## 11. Tests required

The important end-to-end test is:

1. Create SQLite agent.
2. Create conversation.
3. Send two metered prompts.
4. Verify immutable metering rows.
5. Verify cumulative state.
6. Close agent.
7. Reopen agent and conversation.
8. Verify `meteringSnapshot` was restored.
9. Send another prompt with cumulative provider counters.
10. Verify only the new delta was attributed.
11. Verify lifetime totals span both object lifetimes.

Additional tests should cover:

- Duplicate commits are idempotent.
- Failed prompts still persist consumed usage.
- Handoff/switch internal prompts are persisted.
- New provider sessions establish a new baseline.
- State revision conflicts are detected.
- Transcript queries do not load metering data.
- Metering data can be joined to messages/actions through `operationId`.

The existing `test6-metering` smoke test is a useful behavioral contract, but it currently uses `AgentSession` and an external JSON repository. We should preserve it and add an equivalent SQLite `Agent` smoke path.

The essential implementation order is:

1. Schema and persistence interfaces.
2. SQLite implementation.
3. Restore state in `AgentConversationManager.open()`.
4. Persist normal prompt metering.
5. Persist failure and internal-operation metering.
6. Add SQLite reopen tests.
7. Update the smoke test and consumer guide.

This closes the current gap without depending on the still-undecided conversation recovery checkpoint design.







No—the JSONL transcript does not store only the last response cost.

It stores a bounded cumulative metering state. That state contains:

- Total attributable tokens by category.
- Operation counts.
- Metered and unmetered operation counts.
- Accumulated rated costs.
- Coverage information.
- Unallocated usage.
- The active provider counter baseline.

It does not contain the full operation history or even the complete last operation record.

The live `meteringSnapshot` exposes `lastOperation`, but that is held in memory by the metering engine. `lastOperation` is not part of the persisted `AgentSessionMeteringState`.

The JSONL file also keeps one lightweight `metering_reference` per operation, but not its complete usage and pricing details.

## Separate restoration from billing

I agree with your concern. We should distinguish:

1. Operational metering state.
2. Local metering history.
3. Authoritative billing records.

These have different requirements.

### Operational state

This is the compact `AgentSessionMeteringState`. It is required to resume cumulative provider counters correctly and prevent double counting.

It is small and bounded, so it should normally remain in the agent SQLite database.

It is not an invoice or billing ledger.

### Local metering history

These are complete immutable `OperationMeteringRecord` entries.

They are useful for:

- Debugging.
- Local reporting.
- Joining usage with conversation operations.
- Auditing how cumulative state was calculated.

But a consumer may reasonably not want them in the agent database.

### Authoritative billing store

This might be a separate database organized by:

- Customer.
- Organization.
- Subscription.
- Project.
- Billing account.
- Cost center.

The agent database should not pretend to be authoritative for this unless the consumer chooses that architecture.

## Recommended configuration

I would separate state persistence from record retention:

```ts
metering: {
  persistence: {
    state: "sqlite",
    records: "all",
  },
}
```

Possible record policies:

```ts
records: "all"
records: "none"
records: { retain: 100 }
```

Meaning:

- `"all"`: keep the complete local metering history.
- `"none"`: keep only cumulative restoration state.
- `{ retain: 100 }`: retain the most recent records for diagnostics.

The default could reasonably be `"all"` because SQLite is intended to provide complete local persistence, but consumers building billing infrastructure can choose `"none"`.

I would make state persistence separately configurable, but strongly default it on:

```ts
state: "sqlite" | "none"
```

Using `"none"` would mean metering totals and cumulative baselines do not survive reopening unless the consumer supplies restored state itself.

## External metering repository

We should retain the existing ability for consumers to receive every immutable metering record:

```ts
metering: {
  sink: billingRepository,
  persistence: {
    state: "sqlite",
    records: "none",
  },
}
```

Conceptually:

```ts
interface MeteringSink {
  commit(
    record: OperationMeteringRecord,
    nextState: AgentSessionMeteringState,
  ): Promise<void>;
}
```

Then the consumer can associate it with whichever billing identity it owns:

```ts
await billingDb.commit({
  customerId,
  projectId,
  agentSessionId,
  agentConversationId,
  record,
});
```

The agent library should provide correlation identifiers, but not decide who is financially responsible.

## Delivery reliability

If the external sink is authoritative, there is a consistency problem:

```text
provider operation completes
→ SQLite transcript commits
→ external billing database write fails
```

We cannot make SQLite and an arbitrary external database participate in one atomic transaction.

For reliable delivery, use the existing durable-outbox direction:

1. Commit conversation state, compact metering state, and an outbox item in one SQLite transaction.
2. Deliver the metering record to the external sink.
3. Mark the outbox item delivered.
4. Optionally delete delivered items according to retention policy.

This lets the consumer store no permanent local metering history while still ensuring records are not lost during external delivery.

A useful configuration might eventually be:

```ts
metering: {
  persistence: {
    state: "sqlite",
    records: "none",
  },
  sink: billingRepository,
  delivery: "durable_outbox",
}
```

## Should we support “last N records”?

Yes, but as a diagnostic retention option—not as the accounting model.

```ts
records: {
  retain: 100,
}
```

That gives local visibility without retaining an unbounded ledger. The authoritative external sink would still retain the full history.

However, this is not required for restoration. Correct restoration only needs the compact cumulative state.

## Recommended defaults

I would start with:

```ts
metering: {
  persistence: {
    state: "sqlite",
    records: "all",
  },
}
```

Then support:

```ts
metering: {
  persistence: {
    state: "sqlite",
    records: "none",
  },
  sink: externalBillingStore,
}
```

The important invariant is:

> Every completed metering operation must commit its immutable record and resulting state together somewhere authoritative.

Locally, SQLite can do that transactionally. Externally, the consumer’s sink can do it. When external delivery crosses database boundaries, a durable outbox should bridge the failure window.


Almost. The architecture is clear enough to begin, but four policy details should be fixed before implementation so we do not accidentally encode the wrong billing behavior.

My recommended decisions are:

1. Default local behavior:

```ts
persistence: {
  state: "sqlite",
  records: "all",
}
```

2. Initial record retention options:

```ts
records: "all" | "none"
```

Defer `{ retain: number }` until later. Rotation introduces deletion and external-delivery interactions that are not necessary for the first implementation.

3. External sink failures:

- Without durable delivery: fail the originating operation if the sink fails.
- With durable outbox: commit locally, return successfully, and retry delivery separately.

For the first implementation, I recommend supporting the sink contract but requiring synchronous delivery. Add the durable outbox integration as a following step.

4. Existing `metering_recorded` events and `result.metering` remain available regardless of persistence policy.

With those decisions, the implementation scope is complete:

- Add SQLite metering record and state tables.
- Add persistence interfaces and SQLite implementations.
- Add configuration for local state and record persistence.
- Persist normal prompt metering.
- Persist metering from failed prompts.
- Persist handoff/switch/internal-operation metering.
- Restore cumulative state before reopening a conversation.
- Correlate metering with `agentConversationId`, `operationId`, and provider session.
- Preserve idempotency by operation ID.
- Expose query APIs.
- Add backend, lifecycle, reopening, failure, and transition tests.
- Add a new SQLite metering smoke test.
- Update `CONSUMER_GUIDE.md`.

One correction to the proposed external sink interface: the sink should receive conversation identity explicitly because `OperationMeteringRecord` currently contains `agentSessionId` but not `agentConversationId`:

```ts
interface MeteringSink {
  commit(input: {
    agentSessionId: AgentSessionId;
    agentConversationId: AgentConversationId;
    record: OperationMeteringRecord;
    nextState: AgentSessionMeteringState;
  }): Promise<void>;
}
```

So yes, we have enough to implement the SQLite metering portion once we accept the four defaults above. Recovery and identity reconstruction can remain a separate subsequent task.




Yes. Regardless of whether complete metering records are retained, we should always save the bounded metering state needed for continuity.

And yes, `meteringRecords` is clearer than merely `records`, especially in configuration that may sit near conversation records.

For example:

```ts
metering: {
  persistence: {
    state: true,
    meteringRecords: "all", // or "none"
  },
}
```

After every metered operation, the persisted state would include:

- Accumulated token totals.
- Accumulated rated costs.
- Metered/unmetered operation counts.
- Coverage and unavailable-usage counts.
- Unallocated usage.
- Current provider-session baseline.
- State version.

It would not contain:

- Every individual operation’s usage.
- Per-operation pricing provenance.
- Start/completion timestamps for every operation.
- Detailed reconciliation results.
- The complete last metering record.

Those details belong to `meteringRecords`.

So:

```text
metering state/checkpoint
    bounded
    always updated
    required for correct restoration

meteringRecords
    potentially unbounded
    optional local retention
    required somewhere for detailed billing/audit
```

If configured as:

```ts
metering: {
  persistence: {
    state: true,
    meteringRecords: "none",
  },
}
```

then reopening remains correct:

- Totals are restored.
- The cumulative provider baseline is restored.
- The next operation calculates only its own delta.
- Lifetime totals continue correctly.

But the local database cannot later explain each individual charge. That history must have been delivered through `result.metering`, events, or an external metering sink.

One naming detail: internally, I would use a dedicated `conversation_metering_state` table rather than immediately place this inside the still-undefined general `conversation_checkpoints.state_json`. Semantically it is a checkpoint, but giving it dedicated storage lets us complete metering without prematurely defining the full conversation recovery checkpoint.

The update should be transactional:

```text
assistant/tool/native records
+ optional meteringRecords
+ mandatory metering state
= one SQLite transaction
```

Thus `meteringRecords: "none"` changes retention, not accounting continuity.
