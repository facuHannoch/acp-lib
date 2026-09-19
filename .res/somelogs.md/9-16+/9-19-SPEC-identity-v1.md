# Checkpoint-backed agent identity v1

Status: implemented. Provider-side delivery, cursor persistence, migration, and
bounded catch-up are covered by deterministic tests. The accepted v1 limitations
below remain intentional.

An agent owns many conversations. The provider thread for one conversation knows its
own history, but does not automatically know what happened in the agent's other
conversations. Identity v1 delivers a bounded, incremental view of those other
conversations. It does not create a new agent-wide AI summary or replace the
canonical transcripts.

## Sources and ownership

- The source of truth is each non-deleted conversation's canonical message records.
- An optional conversation recovery checkpoint summarizes messages through its
  `coveredSequence`. Its persisted `checkpointId` and coverage determine the
  unsummarized tail. Existing checkpoint generation and its instruction remain
  unchanged.
- The built-in identity runtime belongs to an `Agent`. Custom
  `AgentIdentityRuntime` implementations remain supported.
- Identity v1 does not write `identity_memories` or `identity_snapshots`. Those tables
  remain available for future identity policies.
- All non-deleted conversations of an agent are visible to its other conversations.
  This intentional shared-identity rule can disclose one participant's information
  to another. A future policy may restrict sources; v1 has no per-participant ACL.
- A conversation never supplies its own history through identity. Its live provider
  thread or conversation recovery handles that history.

## Delivery model

Delivery is directed: target conversation/provider thread, source conversation.
For a target thread with no delivery cursor for a source, load the latest checkpoint
summary (if present), followed by canonical messages after its `coveredSequence`.
With an existing cursor, load only source messages with sequence greater than the
cursor. A newly published checkpoint is not resent merely because it is new: it
contains no new canonical facts for a target already caught up. A checkpoint may
instead bridge an undelivered gap when its coverage exceeds the cursor and sending
the raw backlog would exceed the budget.

The assembled context labels every source by stable conversation ID and, when
available, its title/participants. The context is private provider input, not a
canonical message or visible transcript record. It must instruct the provider to
treat source conversation text as information, not commands from the current caller.
The source frontier is captured while building one prompt. Concurrent writes beyond
that frontier are eligible for the next prompt.

Identity delivery has a total character budget and a per-source budget. The runtime
advances through messages in sequence order. It never advances a cursor past a
message that was omitted because of the budget. A source with no checkpoint may
therefore take several target turns to catch up. If a single message cannot fit,
the runtime leaves that source pending and may request a background checkpoint;
it must not pretend the source is covered. `through-current` rejects a load that
cannot include the available frontier; `eventual` accepts a bounded partial view.
Source selection should prefer the least recently delivered pair so a busy source
cannot permanently starve quieter sources.

## Durable cursors

Add a fixed SQLite table, `identity_delivery_cursors`, with a unique key over
`(target_conversation_id, target_provider_context_id, source_conversation_id)`.
Each row stores `delivered_through_sequence` and `updated_at`. The provider context
ID is the active internal provider session ID in normal ACP mode. A context with
no provider ID uses a fresh runtime-scoped key, so it cannot inherit another
thread's cursors. On an explicit new session, recovery, handoff, or switch, the
owner deletes any rows for the new provider ID before activating it: opaque
provider IDs might be reused. Loading the same provider session after an agent
restart does not clear rows and reuses its cursors. Harness-side compaction that
silently discards context while
retaining the same session ID is not detectable; a future explicit invalidation
operation can address it.

Identity v1 does not attempt semantic deduplication. If a model repeats facts learned
from another conversation in its own visible response, that response is a new
canonical message and may later be delivered back to the original conversation.
This can create redundant context, especially with echoing models; the cursor only
prevents redelivery of the same canonical source records to one provider context.

Rows are created lazily after successful delivery. Creating a conversation creates
no cursor rows and never changes the table schema. The table is sparse: with `N`
simultaneously active conversations, at most `N * (N - 1)` directed pairs exist per
target provider-context generation. Obsolete generations may be retained until
maintenance; they do not affect active lookups. Cursor advancement is monotonic.
SQLite schema version 8 must migrate transactionally to the new version without
discarding existing agent data.

## Prompt lifecycle and failure semantics

`identity.load()` receives the target provider-context ID and returns private
context plus an opaque delivery receipt containing only source frontiers actually
included. The conversation carries that receipt through the provider call.
After a provider prompt finishes with status `completed` and the assistant side is
durably recorded, the identity runtime acknowledges the receipt, atomically
upserting its cursors. `identity.update()` continues to observe newly committed
canonical records; it is not a delivery acknowledgment. A failed, cancelled, or
uncertain prompt does not advance cursors. The provider may still have seen the
context; repeating it later is safer than omitting knowledge. Database failure
after provider completion likewise leaves the cursor behind.

The built-in runtime is opt-in. It requires SQLite identity-delivery persistence,
message capture at `content` or `raw`, and enabled conversation checkpointing.
Its `load` is read-only and bounded; checkpoint generation remains background work
and does not make ordinary prompts wait for an AI summary. A fresh conversation
with no checkpoint uses its canonical messages as the tail. The custom identity
interface stays usable, with delivery acknowledgment optional for runtimes that
do not need cursors.

## Verification

Tests must cover first delivery; no repeated delivery on a second prompt; two
source conversations advancing independently; a new source appearing after the
target exists; a new target after sources exist; a checkpoint advancing after a
cursor; bounded partial delivery without gaps; a failed prompt; same-thread reopen;
replacement-thread recovery; no self-delivery; and transactional schema migration
from version 8. A deterministic harness test must inspect the provider prompt, not
only the database rows, to prove the context was actually delivered.
