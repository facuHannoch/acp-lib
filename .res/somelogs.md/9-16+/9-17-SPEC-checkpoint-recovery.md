# Conversation checkpoint and recovery specification

Status: implemented.

## Purpose

Provider session IDs are useful continuation handles but are not durable conversation
authority. A provider may delete or lose a session while the SQLite conversation remains
complete. Recovery checkpoints provide bounded continuation context without flattening or
replacing the canonical conversation record stream.

## Artifact model

`conversation_recovery_checkpoints` stores immutable, revisioned artifacts per
`agentConversationId`:

- `checkpointId` (`chk-…`)
- monotonically increasing revision
- canonical message sequence covered by the summary
- previous checkpoint ID
- generating `internalInferenceId`
- continuation summary
- creation time and optional metadata

Publishing requires the expected previous checkpoint and strictly increasing coverage.
The checkpoint, generating inference completion, metering state, and optional timeline
action commit in one SQLite transaction.

The older `conversation_checkpoints` table stores bounded runtime state and is unrelated.

## Scheduling

Default successful-response milestones are 1, 5, 10, 15, 30, and 50, followed by every
50 responses. Consumers may replace both the milestones and continuing interval.

Successful responses are counted by stable prompt operation IDs persisted on assistant
message metadata. Multiple assistant message boundaries in one response count once.
Failures do not count.

Scheduling durably enqueues work before returning from prompt finalization, but generation
runs in the internal-inference worker and does not keep the visible conversation busy.
Concurrent requests coalesce. If a later milestone arrives while generation is active,
completion rechecks the latest due message boundary and schedules a catch-up checkpoint.

Coverage ends at a canonical message boundary. Activities or the checkpoint's own
`native_action` cannot recursively trigger another summary.

## Generation

The built-in versioned `conversation_checkpoint` strategy reads:

1. the previous recovery checkpoint, if present; and
2. canonical records after its coverage through the requested message boundary.

It asks an isolated internal-inference provider session to produce a continuation summary
preserving objectives, current state, decisions, facts, unresolved questions, pending
actions, and relevant resources. The generated prompt and response are not visible chat
messages. Normal internal-inference retries, leases, retention, progress, and metering
apply.

## Recovery

An owned conversation first attempts the recorded `session/load`. Automatic recovery is
considered only when:

- checkpointing is enabled;
- policy is `onLoadFailure: "recover"`;
- the failure is classified as a missing provider session; and
- a completed recovery checkpoint exists.

Authentication, network, configuration, and arbitrary provider failures fail closed.
ACP has no standardized missing-session error, so consumers may replace the classifier.

Recovery then:

1. loads the latest checkpoint;
2. reads canonical message boundaries written after it;
3. starts a fresh provider session on the recorded adapter;
4. privately seeds that session with the summary and tail messages;
5. meters the seed as `conversation_recovery`;
6. writes recovery native actions; and
7. atomically makes the fresh provider route active only after seeding succeeds.

The seed is never added as a participant message. A failed seed leaves the previous route
active so a later open can retry. Concurrent opens share one fenced recovery operation.

`OpenOwnedAgentConversationResult.providerSession` is `"recovered"` on success and carries
the checkpoint ID, old/new provider IDs, checkpoint coverage, and recovered-through
sequence. `onRecoveryProgress` reports load failure, checkpoint loading, fresh-session
creation, seeding, and completion.

## Boundaries

- SQLite remains the canonical transcript and audit source.
- A summary is lossy continuation context, never a replacement for stored records.
- The default tail limit is 100 messages and is configurable.
- Checkpoint retention is intentionally independent and currently retains all artifacts.
- Provider-private session reconstruction and historical-message import remain unsupported.
- The library cannot prove that harness-native tools are disabled during checkpoint work;
  launcher/container isolation remains the consumer's security boundary.
