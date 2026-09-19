So, I'm thinking on this...
We are currently storing the transcripts in jsonl files.
We also allow to write to a second file with a different policy (auditLog), also in jsonl
Ok... but maybe we have to review that. Because I'm not sure this is very scalable.
So let's question this, see if there's a better option, or if this is not so bad.
For this, think of a conversation as something that can become very large. So not just a couple hundred messages.
Also, the full thing should be retrievable. And we need also to log for auditability.

So lets review the full model, think about things.

---


My conclusion: JSONL is a reasonable append/archive format, but the current “one ever-growing file per conversation” implementation should not remain the sole online persistence model if conversations are genuinely unbounded.

The filesystem will tolerate large files. The current algorithms will become painful much earlier.

## What is already good

The V2 model is considerably stronger than basic JSONL:

- Append-only records with stable transcript identity and contiguous sequence numbers.
- One writer per generation, enforced by a lock.
- Writes are serialized.
- Structural boundaries and checkpoints are synchronized before important provider actions.
- Transcript recovery tolerates and truncates a torn final record.
- Record sizes are bounded.
- Readers use byte-offset cursors and stable snapshot boundaries.

Those are solid event-log foundations. Append performance itself is approximately proportional to the new record size rather than the historical conversation size. See [session-log-writer.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/session-log-writer.ts:287).

A single writer per conversation is also probably appropriate: operations within one logical conversation are serialized anyway. Different conversations have separate files and can write independently.

## Where the current design stops scaling

The biggest issue is not JSON serialization. It is repeated full-file work.

1. Resuming a transcript scans and validates the entire file.

   [transcript-scanner.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/transcript-scanner.ts:79) walks every complete record to recover the latest checkpoint and state. Every reopen is therefore `O(total transcript size)`.

2. Resuming an audit log loads the entire file into memory.

   [session-log-writer.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/session-log-writer.ts:233) uses `readFile()`, converts the complete log to a string, splits it, and parses every record. A multi-gigabyte audit log becomes both a latency and memory problem.

3. Pagination looks random-access, but snapshot validation hashes the entire prefix.

   [transcript-reader.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/transcript-reader.ts:1062) computes SHA-256 from byte zero to the snapshot boundary. This happens when establishing a snapshot and again when consuming cursors. Reading 50 recent items from a huge transcript can therefore still read the whole file. Paging repeatedly can approach `O(pages × file size)`.

4. Folded presentation pagination scans from the beginning on every page.

   [transcript-reader.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/transcript-reader.ts:282) scans the snapshot to fold revisions. Its memory is bounded, which is good, but its I/O and parsing are not. Activity-state queries similarly scan and fold the entire transcript at [transcript-reader.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/transcript-reader.ts:398).

5. There is no segmentation or archival boundary.

   One corrupt middle record can make the strict V2 authority after it unavailable. Old data cannot be compressed, moved, or retained under a different storage tier without rewriting or replacing the whole logical artifact.

6. The registry has a separate scale ceiling.

   Every registry mutation clones, validates, serializes, and atomically replaces the complete registry at [file-registry-store.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/file-registry-store.ts:317). Even if individual conversations scale, a very large number of sessions eventually makes the catalog a global bottleneck.

So the honest assessment is:

- Small/medium local deployments: the current design is good and pleasantly portable.
- Huge conversations opened infrequently: workable, although increasingly slow.
- Huge conversations with interactive pagination, frequent reopening, rich capture, or many sessions: not scalable enough.

## “The full thing should be retrievable”

The current model does not guarantee that.

Capture policy intentionally discards information before persistence. The default `activity` preset omits reasoning and tool contents, while `conversation` omits nearly all operational history. See [config.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/config.ts:110).

Captured values may then be truncated. The defaults allow a 1 MiB record and a 256 KiB captured field, and truncation can replace content with an omission marker or prefix at [truncation.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/truncation.ts:30). An optional digest can prove what was omitted had a particular hash, but cannot recover it. Attachments are also not part of the persisted user-message record.

Before choosing storage, “full” needs a normative definition:

- Full human conversation: every user/assistant message and attachment.
- Full normalized execution history: tools, permissions, transitions, configuration, usage, and revisions.
- Full wire record: every raw ACP request/update.
- Full sensitive internals: reasoning text and raw tool data.

Those are very different retention, privacy, and volume commitments.

For any class declared “complete,” truncation should not silently be the terminal outcome. Oversized values should be chunked or stored as immutable blobs, with the event containing a hash, byte count, media type, and blob reference. The transcript should also expose explicit completeness and gap markers.

## Auditability is a separate guarantee

The second file is useful as a policy and access boundary, but it is not currently an audit-grade trail.

The project correctly documents that the files provide no encryption, tamper resistance, retention, or billing authority in [CONSUMER_GUIDE.md](/home/ffacu/q/apps/libs/acp-lib/CONSUMER_GUIDE.md:590).

Additionally:

- Transcript and audit writes are separate operations.
- Ordinary events are sent to both sinks concurrently.
- Terminal state is written to the transcript first and then to the audit log.

That orchestration is visible in [audit-runtime.ts](/home/ffacu/q/apps/libs/acp-lib/src/persistence/audit-runtime.ts:110). A crash or partial storage failure can leave valid but divergent suffixes. There is no atomic commit shared by both files.

The cursor prefix digest detects mutation relative to a cursor held elsewhere. It is not a tamper-evident ledger: an actor able to replace the file can also create a new internally consistent file.

A serious audit trail normally needs:

- Stable event IDs shared with the originating event.
- Actor, action, target, authorization decision, outcome, and correlation IDs.
- Durable gap/failure records.
- Hash chaining or signed sealed-segment manifests.
- Immutable/WORM or independently controlled storage.
- Encryption and key rotation.
- Defined retention and legal-hold behavior.
- Access auditing.
- An atomic transaction or durable outbox so audit delivery cannot silently diverge.

Audit data also should not automatically duplicate all transcript content. Long-lived audit retention often conflicts with deletion and minimization requirements. Audit records can reference the canonical content by event ID and hash while retaining only operational evidence.

## Recommended target model

I would separate four concepts currently mixed into the transcript:

```text
normalized event
      │
      ▼
durable canonical journal + latest checkpoint + audit outbox
      ├── conversation/presentation projection
      ├── searchable operational indexes
      ├── sealed archive segments and payload blobs
      └── audit exporter → immutable audit store
```

The canonical journal would be lossless for the event classes promised by the product. The presentation transcript and audit trail would be projections with different access and retention policies.

For local/single-host persistence, SQLite in WAL mode is the practical next backend:

- Indexed lookup by session, sequence, type, operation, logical item, and timestamp.
- Cheap retrieval of the latest checkpoint.
- Transactional journal, projection, and audit-outbox updates.
- No full-file scan on every open or page.
- Crash recovery already solved.
- Streaming ordered retrieval of arbitrarily long conversations.

Large tool outputs, attachments, and raw protocol bodies should live in content-addressed blob storage or immutable sidecar files instead of repeatedly occupying SQL rows.

For larger or distributed deployments, the same logical backend interface could be implemented with PostgreSQL plus object storage.

JSONL should remain valuable as:

- A compatibility backend for simple local use.
- A streaming export/import format.
- A sealed archive segment format.
- A disaster-recovery representation.

I would not build increasingly elaborate custom indexes, transactions, and compaction directly on top of one JSONL file; that slowly recreates a database.

## If retaining the file backend

The minimum credible evolution would be:

- Rotate into immutable segments by byte or record count.
- Maintain a durable manifest covering sequence ranges and segment hashes.
- Keep a small indexed current-state/checkpoint store.
- Replace whole-prefix cursor hashing with sealed-segment hashes and a rolling active-segment hash.
- Record byte offsets for sequence, type, presentation position, activity ID, and checkpoints.
- Resume by validating the last sealed segment plus the active tail.
- Stream audit validation rather than calling `readFile()`.
- Store oversized lossless content in hashed blobs.
- Give each normalized event a sink-independent `eventId`.
- Emit explicit audit-gap and completeness records.

That can preserve the current record schema and reader semantics while removing the worst asymptotic behavior.

## Bottom line

The right decision is not “JSONL or database?” in isolation:

- JSONL is fine for sequential append and archival.
- The current unbounded JSONL implementation is not fine as an indexed, frequently reopened, strongly auditable online store.
- The transcript and audit concepts should remain distinct.
- Their writes should originate from one durable canonical event and an outbox/transaction, rather than two loosely coordinated files.
- “Full retrieval” requires changing the truncation/blob/completeness contract, not merely changing the container format.

I made no edits; this was a read-only review.





# Proposed new shape

Yes. Given “very large conversations,” frequent retrieval, and audit requirements, I would make an actual database the primary online backend—and SQLite is the best default for a local, embedded library.

I would not completely remove JSONL. I’d demote it to:

- A simple optional filesystem backend.
- An import/export format.
- A sealed archival format.
- A debugging and portability tool.

## Recommended direction

Introduce a storage abstraction such as:

```ts
interface PersistenceBackend {
  appendEvents(...): Promise<void>;
  getCheckpoint(...): Promise<...>;
  readEvents(...): Promise<...>;
  readPresentation(...): Promise<...>;
  readAuditEvents(...): Promise<...>;
}
```

Then provide:

```text
SQLitePersistenceBackend   ← recommended default
JsonlPersistenceBackend    ← lightweight/legacy mode
PostgresPersistenceBackend ← future distributed option
```

Avoid exposing paths as the core persistence identity. Consumers should select a backend and logical session ID; paths are configuration specific to the JSONL implementation.

## Suggested SQLite model

Use one database per persistence root or application—not one database per conversation.

```text
sessions
  session_id
  generation
  current_checkpoint
  next_sequence
  capture_policy
  completeness
  ...

events
  session_id
  generation
  sequence
  event_id
  timestamp
  type
  operation_id
  logical_item_id
  revision
  payload
  payload_blob_id

presentation_items
  session_id
  logical_item_id
  first_sequence
  latest_sequence
  latest_revision
  type
  payload

audit_events / audit_outbox
  event_id
  session_id
  sequence
  type
  payload
  previous_hash
  delivery_status

blobs
  blob_id
  sha256
  byte_length
  storage_location
```

Important fields should be ordinary indexed columns. The variable event body can remain JSON.

The transaction for an event would atomically:

1. Append the canonical event.
2. Update the current checkpoint if necessary.
3. Update its presentation projection.
4. Insert the audit record or audit-outbox entry.

That removes the current transcript/audit dual-write gap.

## Why SQLite fits

SQLite gives this library:

- Indexed pagination without scanning the entire history.
- Fast latest-checkpoint loading.
- Atomic updates across events, checkpoints, and audit delivery.
- WAL-backed crash recovery.
- One portable application file.
- No separate database service.
- Streaming reads of the complete history.
- Straightforward schema migrations.

SQLite technically has one writer at a time, but transactions here should be small. For ordinary agent workloads, provider latency will dominate database-write latency. If the application eventually has very high concurrent write volume across many sessions, it can shard by tenant/root or move to PostgreSQL using the same backend interface.

SQLite should not be placed on an ordinary network filesystem or used as the shared database for multiple machines. That is the boundary where PostgreSQL becomes the appropriate backend.

## Large payloads

Even with SQLite, I would not put arbitrarily large tool outputs, attachments, or raw protocol bodies directly into the event table.

Store smaller payloads inline. Store large ones as immutable content-addressed blobs:

```json
{
  "blobId": "sha256:...",
  "sha256": "...",
  "byteLength": 48291023,
  "mediaType": "application/json"
}
```

This lets “full retrieval” remain true without allowing a single event row to become enormous. Required content should be chunked or externalized, not truncated. Truncation should only be permitted for explicitly lossy capture policies.

## Audit caveat

SQLite improves consistency but does not by itself make the audit trail tamper-proof. Anyone with write access to the database can alter it.

There are two reasonable levels:

- Operational auditing: audit events in the same SQLite transaction, optionally hash-chained.
- Compliance-grade auditing: transactionally write an audit outbox, then deliver records to independently controlled immutable/WORM storage with signed segment manifests.

The second JSONL file should therefore not remain the definition of auditability. At most, sealed and signed JSONL segments could be one audit export format.

## Migration posture

I’d preserve the current V2 record model where possible:

- Import an existing JSONL generation into SQLite without changing sequence numbers or identities.
- Allow exporting any SQLite-backed transcript to canonical JSONL.
- Keep the current JSONL backend available for small deployments.
- Mark JSONL as unsuitable for unbounded/high-query workloads.
- Make backend choice explicit initially; change the default only in a major version if compatibility matters.

So: **SQLite as the primary local persistence backend, JSONL as an optional compatibility/export/archive mode, and a backend interface that leaves room for PostgreSQL or another remote store.** That is the cleanest long-term direction.





# 

› Ok, so first, concurrency is something important. Like I might be running 10 different acp sessions, each of them
  will write to its own session.
  You then say to keep one sqlite private without allowing to select the path. No... I think we need to still maintain
  this as an option, even if now it means providing a path to where the db would be located (or path + a name).
  The point of being able to select the locations is kind of important. Same with the commands and env variables.
  The main use is as a kind of reverse proxy for harnesses within an orchestration library. So we need concurrency, but
  we also need to define where things will be, because I may want to mount, or maybe I can't write in HOME, or maybe I
  want to have all the chats and information along the respository. An arbitray location breaks that.
  Though setting the path only translates to something like sqlite, AND if we make a db per agent. Which... I think is
  the direction we should follow, but I hear you.
  And I'm thinking on 1 agent = 1 db, because it would allow us to have contained identities of an agent. Which means
  that a) is portable; but also b) separated. So if I mount each agent in a different container, each can have its own
  identity. It also seems much more scalable, like I don't think it adds much weight, and instead now we have a
  different file for each agent that can scale independently.
  Im not sure if postgress ads value here. What would we gain ? Maybe if we want the library to become like a hub of
  harnesses

  Also, theres a concept of identities that I'm thinking, which concerns because of the following:
  So, this is not to implement now, but I'm thinking of something like

  Three agents: atlas, bob, orion
  to talk to each other, while allowing to talk with the user, they need to talk under the hood.
  But each conversation has to affect the main conversation. So what Im thinking is something like each agent has its
  own conversation, and also other conversations. Like suppose we have the main one with the user, and then we have the
  conversation that atlas had with bob, and the conversation that atlas had with orion. Similarly, Bob would have its
  own main conversation, plus the conversation it had with atlas, and the conversation it had with orion.
  And I was going to say to have different tables or something, but maybe here applies what you said about filtering by
  session_id, not per tables or something.


  and as per the auditLog, this seems something that is mostly useful if I can write to a place separately. Your
  suggestions are valuable, but also... is there a better format than jsonl ? Like maybe a simple text with the format
  I see usually like
  [TIMESTAMP] value value
  and you say it is normal for these types of files to grow very big ?



I agree with your direction: for this library, **one explicitly located SQLite database per durable agent identity** is a strong default.

My earlier suggestion of one database per application root was too centralized for your deployment model. It would introduce shared write contention and weaken portability/isolation.

## Location must remain configurable

The database path should absolutely remain selectable. Something like:

```ts
persistence: {
  backend: "sqlite",
  path: "/repo/.acp/agents/atlas.sqlite",
  auditLog: {
    backend: "jsonl",
    path: "/mounted-audit/atlas/",
  },
}
```

Possibly also allow directory shorthand:

```ts
persistence: {
  backend: "sqlite",
  directory: "/repo/.acp/agents",
}
```

The library could derive a filename from the immutable agent ID, but it should expose the fully resolved path.

The same configuration needs to be available through:

- Programmatic options.
- CLI flags.
- Environment variables.
- Manager-level defaults.
- Per-agent overrides.

There should be no mandatory dependency on `HOME`. A default location can exist for convenience, but explicit configuration should always win.

One operational detail: a live SQLite database may also create `atlas.sqlite-wal` and `atlas.sqlite-shm`. Therefore, the configured directory—not only the database file—must be writable and mounted persistently. When closed and checkpointed, it can return to being a single portable database file.

## One agent = one database

This has several useful properties:

- Atlas, Bob, and Orion do not contend for the same SQLite writer lock.
- Each agent’s state is independently portable.
- Each database can be mounted into a different container.
- Retention, backup, encryption, and deletion can differ by agent.
- A damaged database affects one agent rather than the entire hub.
- Databases can grow independently.
- Moving an agent can mean moving one database and any associated artifact directory.

Ten agents writing to ten databases are ten independent SQLite write domains.

Within one agent, several simultaneous conversations will share that agent’s database. SQLite serializes their brief write transactions, but WAL mode allows concurrent readers and normally makes this reasonable. I would use:

- WAL mode.
- A nonzero busy timeout.
- Short transactions.
- One controlled writer queue or connection per agent database.
- Separate read connections where useful.
- An explicit durability setting, likely `synchronous=FULL` for structural/audit boundaries.

If one agent somehow sustains extremely high write volume across many concurrent conversations, that one database becomes the unit to shard. But that seems like the right isolation boundary.

SQLite should remain on a local filesystem or conventional container bind volume. A database mounted independently into one container is fine. A single live SQLite database shared through NFS/FUSE across several machines is not the deployment to optimize for.

## Identity hierarchy

The multi-agent scenario suggests that the model should explicitly distinguish four identities:

```text
Agent
  └── Conversation
        └── Harness session/incarnation
              └── Operation and events
```

- `agentId`: Atlas, Bob, or Orion as a durable actor. Prefer an immutable UUID; `atlas` is a mutable/display name.
- `conversationId`: A logical dialogue.
- `internalSessionId`: The provider/harness thread currently backing that dialogue.
- `operationId` and `eventId`: Individual prompts, transitions, messages, tools, and deliveries.

The current `AgentSession` is effectively a durable conversation. A future durable `Agent` concept would sit above it and own an agent database containing multiple conversations.

Inside `atlas.sqlite`, use one shared `conversations` table—not one table per conversation:

```text
agent
conversations
conversation_participants
events
checkpoints
presentation_items
blobs
outbox
inbox
audit_outbox
```

Every event is keyed by `conversation_id`, with a per-conversation sequence:

```text
PRIMARY KEY (conversation_id, generation, sequence)
```

Indexes can support:

```text
(conversation_id, sequence)
(conversation_id, type, sequence)
(conversation_id, logical_item_id, revision)
(operation_id)
(event_id)
```

Separate tables per conversation would make schema migrations, indexing, searching, and lifecycle management much harder without providing useful isolation.

## Atlas talking to Bob

An Atlas–Bob conversation should have a stable `conversationId` and explicit participants:

```text
conversation_id: conv-atlas-bob-...
participants: [atlas-id, bob-id]
kind: agent_to_agent
```

Because Atlas and Bob have separate databases, there are two possible ownership models.

### Central ownership

A hub owns the canonical Atlas–Bob conversation, while agent databases keep references or projections.

This is simpler for global consistency but reintroduces centralized storage and makes agents less independently portable.

### Replicated agent perspectives

Atlas records its outgoing event in `atlas.sqlite`. The hub delivers it to Bob, and Bob records the same globally unique event in `bob.sqlite`.

This better matches your isolated-agent/container direction:

```text
Atlas DB transaction:
  conversation event
  + outbound delivery

Hub delivers event, possibly more than once

Bob DB transaction:
  inbox receipt
  + local conversation event
  UNIQUE(event_id) deduplicates retries
```

This is an outbox/inbox model. It accepts that no atomic transaction can span Atlas’s and Bob’s independent databases. Instead, delivery is durable, retryable, and idempotent.

Use the same:

- `conversationId`
- `eventId`
- sender and recipient IDs
- causal parent event
- originating/root conversation

in both databases.

## How sub-conversations affect the main conversation

I would not physically merge every Atlas–Bob event into Atlas’s user conversation. That would blur boundaries and could make the model context enormous.

Instead, model causality:

```text
Atlas main conversation
  └── delegation/request event
        └── Atlas–Bob sub-conversation
              └── result event
                    └── injected/referenced from Atlas main conversation
```

Useful fields are:

```ts
rootConversationId
parentConversationId
spawnedFromEventId
causedByEventId
resultForEventId
```

The complete Atlas–Bob exchange remains retrievable from its own conversation. The main conversation receives a selected result, summary, or reference as a new event. A UI can still show an expandable subthread by following the relationship.

This preserves both:

- Full provenance.
- A coherent main conversation.

## What PostgreSQL would add

PostgreSQL becomes valuable if the library evolves into a centralized multi-host hub.

It would provide:

- Many concurrent writers to one shared store.
- Safe access from multiple machines and containers.
- Central querying across all agents and conversations.
- Cross-agent transactions where they are genuinely possible.
- Server-managed access control.
- Replication, failover, managed backup, and point-in-time recovery.
- Better support for queues, worker coordination, and centralized audit ingestion.

The costs are:

- A required service.
- Network dependency and latency.
- More operational configuration.
- Loss of the “copy one agent database” portability model.
- A shared failure and scaling domain.

So I would not make PostgreSQL necessary now. I would make the persistence interface capable of supporting it later. PostgreSQL is primarily the answer to “acp-lib is now the backend for a distributed harness hub,” not the answer to “ten locally orchestrated agents.”

## Audit format

A line like this:

```text
[2026-09-14T12:34:56Z] atlas tool_called shell result=success
```

is excellent for humans and poor as the canonical audit representation.

It has problems with:

- Escaping multiline values.
- Unambiguous field boundaries.
- Schema evolution.
- Nested permission/tool details.
- Machine parsing.
- Stable canonical hashing.
- Adding new fields without breaking parsers.

It also does not materially solve file growth. The payload dominates; changing JSON braces into spaces saves little compared with tool inputs and outputs.

JSONL is actually a good external audit format because it is structured, streamable, inspectable, and easy to rotate. The problem is the unbounded file, not JSONL itself.

Normal production logs do grow very large, but they are generally:

- Rotated by time or size.
- Compressed after rotation.
- Given a retention period.
- Shipped to another system.
- Indexed separately.
- Written as immutable sealed segments.

A sensible audit configuration could support multiple sinks:

```ts
auditLog: {
  backend: "sqlite" | "jsonl" | "custom",
  path: "/mounted-audit/atlas",
  rotation?: {
    maxBytes: 128 * 1024 * 1024,
    maxAgeHours: 24,
  },
  compression?: "gzip" | "zstd",
}
```

For local queryability, a separate SQLite audit database is reasonable. For portable append-only export, rotated JSONL remains better. For serious compliance, the audit outbox should eventually deliver to independently controlled immutable storage.

So the refined direction is:

- **One explicitly located SQLite database per agent.**
- **Multiple conversations represented as rows, not tables.**
- **Outbox/inbox delivery for cross-agent conversations.**
- **Causal links between main and subordinate conversations.**
- **PostgreSQL only when a centralized distributed hub needs it.**
- **JSONL retained for rotated audit output, export/import, and lightweight compatibility—not as the primary unbounded online store.**




---


Yes, I understand it—and the diagrams expose an important distinction we were missing:

> There is one shared logical conversation, but each participating agent has its own conversation endpoint, provider thread, local transcript, and identity.

That resolves the “whose session is this?” problem.

## The conceptual model

I would frame it as:

```text
Agent
  ├── durable identity
  ├── private database
  └── AgentConversation[]
        ├── local transcript perspective
        ├── provider-session identity
        └── AgentController, while active
```

For a conversation between Atlas and Bob:

```text
Shared logical conversation: conversation-123
Participants: Atlas, Bob

atlas.sqlite
  AtlasConversationEndpoint
  provider thread running as Atlas
  remote participant: Bob

bob.sqlite
  BobConversationEndpoint
  provider thread running as Bob
  remote participant: Atlas
```

So it is incorrect to say that the conversation “belongs to the receiver.” The shared conversation belongs to both participants, while each agent owns its endpoint.

When Bob sends a message, the library invokes Atlas’s endpoint. When Atlas sends one, it invokes Bob’s endpoint.

## Duplicating the conversation is reasonable

I agree with you: the complete conversation should be present in both agent databases.

That duplication is intentional replication, not accidental redundancy. It provides:

- Independent portability of each agent.
- Complete conversation display from either database.
- Identity/memory processing without needing the other agent online.
- Container isolation.
- Independent backup and deletion.
- One locally consistent perspective per agent.

The same logical messages should carry identical global IDs in both databases:

```text
conversationId
messageId
exchangeId
authorAgentId
causedByMessageId
timestamp
```

But the local perspective differs.

In `atlas.sqlite`:

```text
Bob message:
  direction = remote
  authorAgentId = bob

Atlas response:
  direction = local
  authorAgentId = atlas
```

In `bob.sqlite`:

```text
Bob message:
  direction = local
  authorAgentId = bob

Atlas response:
  direction = remote
  authorAgentId = atlas
```

I would avoid storing roles such as `"atlas"` or `"bob"`. Store authorship and direction separately:

```ts
interface StoredMessage {
  messageId: string;
  conversationId: string;
  sequence: number;

  author:
    | { kind: "user"; userId?: string }
    | { kind: "agent"; agentId: string };

  direction: "local" | "remote";
  content: MessageContent;
}
```

When sending the conversation to a harness:

- `local` messages map to assistant history.
- `remote` messages map to user history.
- `authorAgentId` remains metadata for display and provenance.

That also prevents identity spoofing: the text `"Hello, I'm Bob"` does not establish that the sender is Bob. The authenticated message envelope does.

## Reconstructing chats

Your objection to generic “events” is correct. “Persist the events” is not enough of a data model.

The database should have an explicit conversation model:

```text
conversations
messages
message_parts or message_revisions
activities
permissions
provider_sessions
deliveries
```

The chat UI should not reconstruct a conversation by interpreting every lifecycle event. It should perform essentially:

```sql
SELECT *
FROM messages
WHERE conversation_id = ?
ORDER BY sequence;
```

Operational records—tool execution, permissions, session transitions, delivery retries—can remain event-like data, but messages are first-class entities.

A useful distinction is:

- `messages`: authoritative human/agent-visible conversation.
- `activities`: tools, reasoning, and execution details displayed around messages.
- `operations`: invocation boundaries and outcomes.
- `audit records`: security and operational evidence.
- `identity revisions`: durable changes to the agent’s memory/identity.

The display transcript is therefore directly queryable. It is not reconstructed from vaguely defined events.

## The missing object is `AgentConversation`

I think your intuition is right, but I would place it like this:

```text
Agent
  └── AgentConversation
        └── AgentController
```

Rather than:

```text
AgentSession
  └── AgentConversation
        └── AgentController
```

The current `AgentSession` already behaves much like the proposed `AgentConversation`: it represents one durable logical thread and owns a controller.

A clean future mapping would be:

```text
Current                    Future meaning

AgentSession          →    AgentConversation
AgentController       →    active harness connection/runtime
internalSessionId     →    provider session backing one conversation endpoint
SessionManager        →    conversation manager inside or beneath Agent
```

Then add a new higher-level object:

```ts
const atlas = await Agent.open({
  agentId: "...",
  databasePath: "/agents/atlas.sqlite",
});

const main = await atlas.openConversation("main");
const withBob = await atlas.openConversation(sharedConversationId);
```

For compatibility, `AgentSession` could initially remain as an alias or facade over `AgentConversation`.

Importantly, an `AgentConversation` should exist without an active controller. The complete transcript can be viewed from SQLite without starting the harness. A controller is attached only when the agent needs to speak or perform work.

## Message delivery flow

The flow in your diagrams would become:

1. Bob’s main conversation decides to contact Atlas.
2. Bob calls a library-provided capability:

   ```ts
   sendMessage({
     targetAgentId: atlasId,
     message: "...",
   });
   ```

3. The library records the outbound message and delivery in `bob.sqlite`.
4. The coordinator finds or creates the shared Bob–Atlas conversation.
5. It records the mirrored incoming message in `atlas.sqlite`.
6. It opens or creates Atlas’s local conversation endpoint.
7. It retrieves Atlas’s current identity snapshot.
8. It loads or starts Atlas’s provider session/controller for that conversation.
9. It prompts Atlas.
10. Atlas’s response is written to `atlas.sqlite` as local and to `bob.sqlite` as remote.
11. The response is returned to Bob’s original `sendMessage` invocation.

The last step addresses the infinite-loop concern in Image #2.

Ideally, `sendMessage` behaves like a tool/RPC call:

```text
Bob inference
  └── sendMessage(Atlas, "...")
        └── Atlas inference
              └── response returned as tool result
```

Atlas’s response should not automatically become a fresh prompt telling Bob to answer again. Bob receives it as the result of the call and decides within the current operation whether another message is necessary.

Nested agent calls can still cycle:

```text
Bob → Atlas → Bob → Atlas
```

So the coordinator needs:

- `exchangeId`
- `parentCallId`
- maximum call depth
- message/turn budget
- timeout
- cancellation propagation
- detection of reentrant calls into a currently blocked endpoint

That is better than asking agents to respond `"ok"` to terminate the loop.

## Conversation sequencing

Because both databases contain a replica, the coordinator should allocate one stable sequence for the shared logical conversation:

```text
conversation-123:
  1 Bob → Atlas
  2 Atlas → Bob
  3 Bob → Atlas
```

Both databases store those same sequence numbers.

If messages can be sent concurrently in both directions, the conversation coordinator serializes their admission. Delivery into each database is idempotent:

```sql
UNIQUE(conversation_id, message_id)
UNIQUE(conversation_id, sequence)
```

The delivery can use an outbox/inbox protocol:

```text
Bob database transaction:
  insert message
  insert outbound delivery

Atlas database transaction:
  insert inbox receipt
  insert mirrored message
```

Cross-database atomicity is impossible, but retries are safe because `messageId` is stable.

## Main conversations and agent conversations

The “main” conversation is not fundamentally a different storage type:

```text
Main:
  participants = [human user, Bob]
  kind = user_agent

Bob–Atlas:
  participants = [Bob, Atlas]
  kind = agent_agent
```

Both contain ordered messages. Both may have provider sessions. Both affect the appropriate agent’s identity.

The important difference is what is local and remote:

```text
Bob main conversation:
  user = remote
  Bob = local

Bob–Atlas conversation in Bob’s DB:
  Atlas = remote
  Bob = local
```

## Agent identity

I understand the identity concept as persistent state shared across all conversations of one agent:

```text
Atlas conversations
  ├── user main
  ├── Atlas–Bob
  └── Atlas–Orion
          │
          ▼
     Atlas identity
          │
          ▼
retrieved before Atlas speaks in any conversation
```

That works, but I would not let conversations directly overwrite one identity document without provenance. Concurrent conversations could race, and private information could leak between contexts.

Instead, make identity versioned:

```text
identity_revisions
identity_items / memories
identity_sources
identity_scopes
```

A settled turn can contribute identity updates:

```text
identity item
  value: "Bob prefers concise status reports"
  sourceConversationId: ...
  sourceMessageId: ...
  committedAtRevision: 42
  scope: relationship:bob
```

Before Atlas speaks, the library resolves an identity snapshot appropriate to that conversation:

```text
global identity
+ persona/instructions
+ relationship memory for the participant
+ relevant retrieved memories
```

Scopes matter:

- `global`: applicable everywhere.
- `relationship:bob`: knowledge used when talking to Bob.
- `conversation:<id>`: local thread memory.
- `private`: not eligible for propagation.
- `user-visible` or `agent-visible`: optional policy boundary.

Otherwise, something Atlas learns privately from Bob could unexpectedly appear in Atlas’s user conversation.

Each operation should use a fixed identity revision captured before dispatch. Identity changes become visible on the next operation, not halfway through an active response.

## Refined architecture

The model I think your diagrams imply is:

```text
Agent
  identity store
  private SQLite database
  conversation registry

  AgentConversation A
    full local transcript
    provider-session checkpoint
    optional active controller

  AgentConversation B
    full local transcript
    provider-session checkpoint
    optional active controller
```

And cross-agent communication is:

```text
Shared Conversation ID
  ├── local endpoint and replica in atlas.sqlite
  └── local endpoint and replica in bob.sqlite
```

That is coherent. It preserves full chat reconstruction, makes agent identities portable, allows independent containers, and gives every participant its own harness thread.

The rotated audit log remains separate from this: it records deliveries, identity changes, permission decisions, failures, and operations, while the SQLite `messages` tables remain the authoritative reconstructable chats.



› The way you are thinking it is quite rigid. You are thinking it as this library controls the communication between bob and atlas, so it writes to one as outbound, then to the other, and then ensures... and that
  is quite rigid. When was saying duplication, I was saying it a little different from what you see to see. Like, the duplication would be just a natural cause, not really duplication, in the same sense that two
  people having knowledge of the same chat is not duplication.
  Bob sends a message, and we could record that or not,  but that is not connected in any way to what happens then to atlas, and that is kind of the point.
  Like then we have atlas, which gets a message. We retrieve the identity, and start a session and save it to atlas.conv-bob (for example).
  Like, I don't think we should force a relationship in that sense, but that the relation is kind of implicit or learnable trhough the data.
  Like, this is atlas, and this is a chat with the user, and this is a chat with an agent it had called bob.
  And this is bob, which has a chat with the user and with an agent called atlas.

  We could still have ids or something, because we need to in some way identify the receiver.
  I still have to define the specifics, but I think I would have to write tools for the agent, so it is able to send messages.


  One thing I will concede though is on the "main". Because I was thinking on a "main" chat but you are right that theres nothing special about the chat the user has with the ai. It is just a chat that has
  prompt("user input") all the way down. The consumer could make this the main chat, but thats up to them. We could have a small "default" attribute, but your point is good becausae then nothing stops us from
  having like 3 different users talking to the agent

  Now, here appears a problem that you highlighted, which I never thought, but with lets say multiple agents could appear, which is race condition.

  But here is the other point you sayd that I dont like which is the identity system. Maybe I understood it wrong, but as I got it, you want to turn it into a kind of programmatic thing, where we define exactly
  what the agent knows or its memory.

  So the race condition is certainly something, but what you said made me think a little bigger, because the model, if race condition is not a problem, then becomes quite scalable, and then a postgres db could
  even make sense. But thats a thing for later




---


Yes—I had made the architecture much more coordinated than what you intended.

I modeled Atlas’s and Bob’s records as synchronized replicas of one formally shared conversation. Your model is looser:

- Bob has a local conversation involving Atlas.
- Atlas independently has a local conversation involving Bob.
- Those conversations may describe the same interaction.
- The storage layer does not need to know they are the same interaction.
- It does not coordinate delivery, replication, acknowledgements, or shared sequencing.
- Any relationship between them is implicit in their contents and optional metadata.

That is a meaningful difference, and your version leaves much more room for the consumer to decide how communication works.

## Independent local conversations

The data could look like this:

```text
bob.sqlite
  conversations/
    conv-1: user Alice
    conv-2: agent Atlas

atlas.sqlite
  conversations/
    conv-8: user Alice
    conv-9: agent Bob
```

`bob/conv-2` and `atlas/conv-9` are not database replicas and do not require a shared ID.

Bob might not even record a dedicated Atlas conversation. Bob could merely have a tool call in `conv-1`:

```text
send_message(target="atlas", message="Investigate this")
```

Atlas then receives the message and independently records it in `atlas/conv-9`.

Bob’s local record of the operation and Atlas’s received conversation are causally related in reality, but acp-lib does not have to formalize that relationship.

If the messaging tool or consumer wants correlation, it can attach optional metadata:

```ts
{
  deliveryId?: string;
  senderAgentId?: string;
  sourceConversationId?: string;
}
```

But the transcript model should not require it.

## What acp-lib would own

Under this looser model, acp-lib owns:

- Durable agent identities.
- A collection of conversations belonging to each agent.
- Local conversation persistence.
- Opening a harness session for a conversation.
- Retrieving the agent’s identity before prompting.
- Recording what happens locally.

It does not necessarily own:

- How an agent discovers another agent.
- How messages are transported.
- Whether the sender records an outbound conversation.
- Whether two local conversations are correlated.
- Whether a response is forwarded automatically.
- Whether communication uses MCP, custom tools, RPC, or consumer code.

A tool could be implemented externally along these lines:

```ts
async function sendMessage(sender, targetId, message) {
  const target = await agentResolver.resolve(targetId);

  const conversation = await target.findOrCreateConversation({
    counterpart: {
      kind: "agent",
      id: sender.id,
      name: sender.name,
    },
  });

  return await conversation.prompt(message);
}
```

The library provides the primitives. The consumer provides the communication policy.

## Conversations are local to an agent

That suggests a conversation model such as:

```ts
interface AgentConversationRecord {
  conversationId: string;       // Local to this agent database
  agentId: string;              // The agent whose conversation this is

  counterpart?: {
    kind: "user" | "agent" | "service" | "unknown";
    id?: string;
    name?: string;
  };

  labels?: string[];
  metadata?: JsonObject;
}
```

No global conversation ID is required.

For Atlas receiving a message from Bob:

```text
conversation owner: Atlas
counterpart: Bob
incoming prompt: represented to the harness as user input
response: produced by Atlas as assistant
```

For Bob’s independently retained Atlas conversation:

```text
conversation owner: Bob
counterpart: Atlas
Bob’s speech: locally authored
Atlas’s responses: remote speech
```

These can be reconstructed separately without proving that individual messages correspond.

## “Main” should indeed be consumer policy

I agree with your revised view: there is no inherently special main conversation.

The library sees:

```text
Agent
  Conversation with Alice
  Conversation with Charlie
  Conversation with Atlas
  Conversation used by a background job
```

A consumer may designate one as the main UI conversation, but that is application state.

A single global `default: true` may become limiting once three users can talk to one agent. A slightly more flexible mechanism would be named aliases or labels:

```text
alias: "default"
alias: "user:alice:primary"
alias: "user:charlie:primary"
label: "interactive"
label: "background"
```

But even that is optional. The foundational model only needs an agent with multiple independently addressable conversations.

## Reconstructing the chat

We also do not need to make “events” the primary abstraction.

The database can store messages directly:

```text
conversations
messages
activities
permissions
provider_sessions
```

A conversation UI queries its messages:

```sql
SELECT *
FROM messages
WHERE conversation_id = ?
ORDER BY ordinal;
```

A message could have:

```ts
interface ConversationMessage {
  messageId: string;
  conversationId: string;
  ordinal: number;

  speaker: {
    kind: "local_agent" | "remote_agent" | "user" | "system";
    id?: string;
    name?: string;
  };

  content: MessageContent;
  status: "in_progress" | "completed" | "cancelled" | "error";
  createdAt: string;
}
```

Tools, reasoning, permissions, and lifecycle records can be stored separately and interleaved by ordinal when rendering a detailed timeline.

So “event” can remain a generic implementation term for operational records. The reconstructable chat consists of concrete message records.

## Identity should remain opaque

You understood my earlier suggestion correctly, and your objection is fair. I had begun defining the semantics of identity—facts, memories, scopes, relationship knowledge—and that is too prescriptive for acp-lib.

The library only needs a contract like:

```ts
interface AgentIdentityProvider {
  resolve(context: {
    agentId: string;
    conversationId: string;
  }): Promise<ResolvedAgentIdentity>;

  observe?(interaction: SettledConversationInteraction): Promise<void>;
}
```

What `resolve()` does is outside the persistence model. It might:

- Return a Markdown identity document.
- Query a vector database.
- Perform RAG over all prior conversations.
- Load files from a repository.
- Ask another model to synthesize an identity.
- Retrieve a serialized opaque object.
- Combine several sources.
- Do nothing.

Similarly, `observe()` might update that system—or the consumer might process identity asynchronously without using a library hook at all.

acp-lib does not need to define what the agent knows. It only needs to offer lifecycle boundaries where identity can be retrieved and where settled conversation data becomes available.

## The actual identity race

There are two different races.

### Same conversation

Two simultaneous prompts to the same conversation should remain serialized. The existing `AgentSession` operation queue already follows this principle.

### Different conversations of the same agent

Atlas could respond to Bob and Alice concurrently:

```text
Atlas/Bob conversation  ── reads identity revision X
Atlas/Alice conversation ─ reads identity revision X

both finish and potentially update identity
```

SQLite serializing the final writes does not by itself solve the semantic conflict if both updates replace the same identity document.

However, the race only becomes a lost-update problem when identity is modeled as mutable overwrite state.

If identity processing consumes append-only observations:

```text
observation 101: result from Atlas/Bob
observation 102: result from Atlas/Alice
```

then both survive. The identity implementation can reconcile them later. That works whether it is RAG, a reducer, a model-generated document, or something else.

acp-lib could remain neutral and expose several consistency primitives:

- A stable identity snapshot resolved before each prompt.
- A monotonically versioned opaque identity value.
- Compare-and-swap for consumers that overwrite identity.
- An append-only stream of settled conversation observations.
- Optional serialized identity-update execution.

The consumer chooses the semantics.

The important rule is that the library should not hold a database transaction or identity lock while waiting for a model response. That would serialize every conversation for an agent and eliminate most of the scalability benefit.

A reasonable default is:

1. Resolve identity immediately before dispatch.
2. Use that fixed snapshot for the operation.
3. Complete the conversation turn.
4. Publish the settled interaction as an identity input.
5. Let the identity system process it independently.
6. The next operation sees whatever identity has committed by then.

That gives snapshot-style consistency without defining what identity means.

## Object hierarchy

The conceptual distinction I would preserve is:

```text
Agent
  └── Conversation
        └── optional live harness runtime/controller
```

There are two valid naming approaches.

Minimal API disruption:

```text
Agent
  └── AgentSession          // remains one durable conversation
        └── AgentController
```

More explicit terminology:

```text
Agent
  └── AgentConversation     // persistent and readable while offline
        └── AgentSession    // optional live harness binding
              └── AgentController
```

The latter distinguishes a stored conversation from a running provider session, but it adds another public concept. The former may be sufficient if documentation clearly says that `AgentSession` is one conversation belonging to an agent.

I would decide the lifecycle first and the names afterward:

- Can a conversation be read without starting a harness? Yes.
- Can it have no current provider session? Yes.
- Can it resume onto a new controller? Yes.
- Can one agent have many concurrently active conversations? Yes.
- Does each conversation maintain its own provider thread? Normally yes.

## Where PostgreSQL enters

This looser model actually makes the backend abstraction more important.

SQLite per agent works very well when:

- One process/container owns that agent database.
- Different agents live in different databases.
- Conversations within one agent have short serialized commits.
- Portability and explicit filesystem placement matter.

PostgreSQL becomes interesting when:

- Several processes may concurrently operate conversations for the same agent.
- Agent databases cannot be pinned to one container or host.
- Identity resolution/update runs across distributed workers.
- A hub needs global discovery and querying.
- Conversations must survive ephemeral workers without mounted volumes.
- Central coordination is more valuable than per-agent file portability.

PostgreSQL still does not decide the identity semantics, but it provides shared transactions, compare-and-swap, row locking, and concurrent access from multiple workers.

So I would keep that as a future backend rather than allowing it to shape the local model now.

The revised core is simpler:

> Each agent owns an identity and a set of local conversations. Conversations are independently reconstructable. Communication between agents is consumer/tool behavior, not a synchronized storage relationship. Every operation may consult the agent’s opaque identity, and completed conversations may feed whatever identity system the consumer chooses.




I think AgentConversation is a good name for what currently is AgentSession more or less. What I was saying is that AgentSession could still be the front part, but it would now contain what currently is an AgentSession, for each participant.
Or we can just name it Agent, but AgentSession is not bad.
But in any case, I think
Agent / AgentSession -> AgentConversation -> AgentController
Is a good model
w u think ? 


Then, we would have, for all the conversations:
- Identity
- storage / persistence (dont know? or backend, maybe this latter too vague)
- tools (we didn't define them, but I think they would be here)

Session manager would still exists as a collection of higher level objects, altough maybe some things have to be revised.
So things like switch, or handoff or that are tools the library offers via api, are applied on top of what we now naming AgentConversation.
So maybe the current SessionManager needs to be split in two parts: a SessionManager for the agent entitites, and a Session Manager as a thing that acts on a single agentConversation.
And also, while I said that I didn't want the library to make things rigid, and two conversations is not because of deliberate duplication but because each model is independent and knows about the things it happened to it, we should allow for two things:
- discoverability
- tool sending

bob talking with atlas is basically two harness processes getting the response of the other and answering. In principle that is doing something like prompt("things +" responseFromAtlas()). But the models need to get to the point where they are talking, which means:
- one agent discovered an agent: The actual discoverability part does not seem that difficult, is just saving the name somewhere, maybe even an id. We could even delegate this to the user (which they may want to take on if they are building an orchestration system), altough the agent needs to in some way be able to retrieve the list of agents it can talk to (or, it doesn't, but it would be nice). And this could mean two things: consumer provides the list, or the library provides the list. Both seem vluable
- one agent started talking to the other: this requires a capability on the agent to do that. And I think this includes two levels again: the actual conversation agent shuold have the tool, but then the tool has to transcend the conversation and even the agent, and look for the specific receiver (this were SessionManager could be of help), and send the output

On the actual tools, that is something to define, altough one of the last things to implement. One option is to implement as an mcp server. This is not bad, most harnesses support mcp. But another option is to do something much more native, like actual harnesses do, and have actual tool definitions and such. I would need to research how this is done because I actually don't know how harnesses achieve this.

Also, if there is no main chat, then we need a new level of ids. Because we currently have `ags-xxx` which has a very fundamental property: never changes. This is important. But if now we have what were multiple of that, within one umbrella, then we need something. I think we could leave the `ags-xxx` as the front-facing id, and have a different system of ids for each AgentConversation.
At the same time, we should map the sender. Because the user could be like
send_message(agentSessionId, "bob") <-- note that "bob" is not the target, but the sender identity. Thats an important part, that seems confusing, but here we would say "I want to talk to agentSessionId, I'm bob", and then the actual library would save the record as "bob", and ideally it would open the same internalSessionId (altough at this point we need for the recovery mechanism to just work naturally).




Yes, I think this is a good model:

```text
Agent / AgentSession
  ├── Identity
  ├── Persistence
  ├── Tool capabilities
  └── AgentConversation[]
        └── AgentController
```

More precisely, `AgentController` is only present while the conversation is live. The stored conversation exists independently:

```text
AgentSession
  └── AgentConversation
        ├── durable messages/checkpoint
        ├── provider session identity
        └── optional active AgentController
```

## `Agent` versus `AgentSession`

Semantically, `Agent` is cleaner because this object is stable and may outlive every harness process. But preserving `AgentSession` has real advantages:

- `ags-xxx` remains the public stable ID.
- Existing consumers already understand that type.
- It describes an orchestration session containing several conversations.
- Migration is easier.

So this is reasonable:

```text
AgentSession ID: ags-xxx
AgentConversation ID: acv-xxx
Internal provider session ID: provider-specific
```

The meanings become:

- `agentSessionId`: immutable identity of the library-level agent entity.
- `agentConversationId`: immutable identity of one conversation belonging to it.
- `internalSessionId`: the current provider/harness thread backing that conversation.

The important migration is that `internalSessionId` moves from being a property of the top-level `AgentSession` to being a property of each `AgentConversation`.

If designing entirely from scratch, I would call the top object `Agent`. Given this library’s existing API, keeping `AgentSession` is defensible.

## Responsibilities at each level

### AgentSession

Owns shared agent-level concerns:

```ts
interface AgentSession {
  readonly agentSessionId: string;

  readonly identity: AgentIdentityProvider;
  readonly persistence: AgentPersistence;
  readonly tools: AgentToolRegistry;

  readonly conversations: AgentConversationManager;
}
```

The identity remains opaque. Persistence is one explicitly configured agent database. Tools are capabilities made available to conversations, possibly filtered per conversation.

### AgentConversation

Owns everything currently associated with one `AgentSession`:

- Messages and presentation.
- Prompt queue.
- Provider session identity.
- Adapter and mode.
- Configuration.
- Recovery.
- Checkpoints.
- Handoff.
- Mode switch.
- Metering.
- Optional active controller.

Methods such as these move here:

```ts
conversation.prompt(...)
conversation.handoff(...)
conversation.setMode(...)
conversation.setConfig(...)
conversation.resolveRecovery(...)
```

### AgentController

Remains the low-level active harness control plane:

- Starts and stops a harness.
- Creates or loads a provider session.
- Sends ACP requests.
- Receives updates.
- Does not own durable agent identity.
- Does not own the collection of conversations.

## Persistence terminology

I would use `persistence` in the public configuration because it communicates purpose. `backend` or `driver` describes the implementation:

```ts
persistence: {
  backend: "sqlite",
  path: "/repo/.agents/bob.sqlite",
}
```

Internally, a class such as `AgentStore` would be clear:

```text
AgentPersistenceConfig  public configuration
AgentStore              internal persistence interface
SQLiteAgentStore        implementation
JsonlAgentStore         compatibility implementation
```

One SQLite database belongs to one `AgentSession`, and all its conversations are rows inside it.

## Managers should be split by responsibility

I would avoid having two unrelated types both called `SessionManager`.

A clean split would be:

```text
AgentSessionManager
  create/open/list/delete AgentSession entities
  resolve agents
  coordinate library-owned agents
  expose discovery

AgentConversationManager
  scoped to one AgentSession
  create/open/list/delete conversations
  resolve an incoming message to a conversation
  load/recover conversation checkpoints
```

And then operational actions live directly on `AgentConversation`.

In other words:

```ts
const bob = await agents.open("ags-bob");

const conversation = await bob.conversations.open("acv-atlas");

await conversation.setMode("degraded");
await conversation.handoff(...);
await conversation.prompt(...);
```

The current `SessionManager` contains some agent-level registry responsibilities and some conversation-level persistence responsibilities. Splitting along that boundary makes sense.

## Discoverability should be pluggable

There are two valuable discovery sources:

1. Library-managed agents.
2. Consumer-provided agents.

Model that as a directory:

```ts
interface AgentDirectory {
  list(context: AgentDiscoveryContext): Promise<AgentDescriptor[]>;
  resolve(reference: string): Promise<AgentDescriptor | null>;
}
```

Implementations could include:

```text
ManagedAgentDirectory
ConsumerAgentDirectory
CompositeAgentDirectory
```

An agent descriptor might contain:

```ts
interface AgentDescriptor {
  agentSessionId: string;
  name: string;
  description?: string;
  capabilities?: string[];
  metadata?: JsonObject;
}
```

Names are for humans and models; IDs are for routing. Names need not be unique.

The consumer should be able to control visibility:

```ts
directory.list({
  requesterAgentSessionId: bob.agentSessionId,
});
```

That prevents the library from assuming that every agent can discover every other agent.

The model could receive the available agents through either:

- A `list_agents` tool.
- Identity/context injected before prompting.
- Static tool configuration.
- Consumer-provided prompt material.

## Tool semantics and tool transport are separate

I would define the capability first, independently from MCP:

```ts
interface AgentMessagingService {
  sendMessage(input: {
    sender: AgentPrincipal;
    receiverAgentSessionId: string;
    message: MessageContent;
    conversationHint?: string;
  }): Promise<AgentMessageResult>;
}
```

Then expose that service through different tool transports:

```text
AgentMessagingService
  ├── MCP tool adapter
  ├── native harness tool adapter
  ├── direct TypeScript API
  └── possible prompt/emulation fallback
```

MCP is likely the best initial implementation because it is already supported by many harnesses. A native tool adapter may eventually provide tighter integration, but it should call the same semantic service.

This avoids designing the core messaging behavior around MCP-specific request shapes.

## The sender must not be model-supplied

Your routing distinction is important:

```text
target: ags-atlas
sender: Bob
```

But ideally the agent should not be permitted to claim arbitrary sender identities.

The model-facing tool should probably be:

```ts
send_message({
  target: "ags-atlas",
  message: "Can you investigate this?",
});
```

The tool binding already knows it was installed for Bob:

```text
trusted tool context:
  senderAgentSessionId = ags-bob
  senderName = Bob
```

Internally:

```ts
messaging.sendMessage({
  sender: {
    agentSessionId: "ags-bob",
    name: "Bob",
  },
  receiverAgentSessionId: "ags-atlas",
  message,
});
```

For a direct consumer API, both IDs may be explicit:

```ts
agents.sendMessage({
  from: "ags-bob",
  to: "ags-atlas",
  message,
});
```

But the manager should verify that the caller is authorized to act as Bob. A plain model-controlled string saying `"I'm Bob"` should not establish identity.

The receiver transcript can retain both:

```ts
{
  speaker: {
    kind: "agent",
    agentSessionId: "ags-bob",
    displayName: "Bob"
  },
  protocolRole: "user",
  text: "..."
}
```

That lets the harness receive it as user input while the displayed transcript correctly says Bob spoke.

## Resolving the receiver’s conversation

When Atlas receives a message from Bob, something must decide which Atlas conversation receives it.

That policy should be pluggable:

```ts
interface IncomingConversationResolver {
  resolve(input: {
    receiver: AgentSession;
    sender: AgentPrincipal;
    conversationHint?: string;
  }): Promise<AgentConversation>;
}
```

The default policy could be:

```text
Find Atlas conversation whose counterpart is ags-bob.
If absent, create one.
```

But consumers could instead:

- Create a fresh conversation for every request.
- Use a named channel.
- Route by project or task.
- Use a consumer-supplied conversation ID.
- Put several agents in one conversation.
- Reject unsolicited messages.

For example:

```ts
send_message({
  target: "ags-atlas",
  channel: "repository-review",
  message: "...",
});
```

The default lookup key could then be:

```text
(receiverAgentId, senderAgentId, channel)
```

This is not a forced relationship between Bob’s and Atlas’s transcripts. It is only Atlas’s local rule for reusing its own conversation with Bob.

A uniqueness constraint or transactional upsert prevents two concurrent first messages from accidentally creating two default Bob conversations.

## Recovery becomes naturally conversation-scoped

Each `AgentConversation` stores its own continuation state:

```text
agentConversationId
adapterId
internalSessionId
generation
checkpoint
recovery status
```

When Bob contacts Atlas again:

1. Resolve Atlas.
2. Resolve Atlas’s local conversation for Bob.
3. Load that conversation.
4. Apply the ordinary existing recovery mechanism.
5. Load or reconstruct its provider thread.
6. Prompt it with Bob as the speaker.

No special messaging recovery system is needed. It is just normal `AgentConversation` opening and prompting.

## No special main conversation

Agreed: the user conversation is simply another conversation.

Instead of a global boolean `default`, I would lean toward optional aliases:

```text
"default"
"user:alice"
"user:charlie"
"agent:bob"
"project:acp-lib"
```

A consumer can choose any conversation as its UI’s main chat. Another consumer may expose several user conversations simultaneously.

The library does not give `"default"` special execution semantics; it is a lookup convenience.

## One remaining naming wrinkle

There are now two meanings of “handoff”:

- Current handoff: replace a provider thread inside one conversation.
- Agent delegation: one agent contacts another agent.

I would keep these distinct in terminology:

```text
conversation.handoff()       provider/thread continuation operation
agent messaging/delegation   cross-agent capability
```

Otherwise, users may assume `handoff()` transfers the conversation from Bob to Atlas, which is not what the existing operation does.

## Recommended model

I would settle provisionally on:

```text
AgentSessionManager
  └── AgentSession (ags-xxx)
        ├── IdentityProvider
        ├── AgentStore
        ├── AgentToolRegistry
        └── AgentConversationManager
              └── AgentConversation (acv-xxx)
                    ├── transcript/messages
                    ├── checkpoint/recovery
                    ├── internalSessionId
                    └── AgentController while active
```

Alongside it:

```text
AgentDirectory
AgentMessagingService
IncomingConversationResolver
Tool adapters: MCP, native, direct API
```

This preserves the flexibility you want:

- The library may manage discovery, or the consumer may provide it.
- Messaging can be MCP, native, or direct.
- Sender identity is trusted and explicit.
- The receiver decides how to select its local conversation.
- Conversations remain independent records.
- Recovery applies naturally at the conversation level.
- `ags-xxx` remains the permanent front-facing identity.
- The library does not force Bob’s transcript to correlate with Atlas’s transcript.










Okay, but note that the higher SessionManager is not necessarily the front part of the library. Like 



"But the manager should verify that the caller is authorized to act as Bob" -> I'm not sure we have the authority to do that.
Like I think we could allow to reference an existing ags and then the name, but other than that, I'm not sure we are in the right place to put a system of trust like verify that the one that is talking is actually bob. How would we do it ? Again, providing the id could be one thing, which would be akin to use the same phone number, and then the receiver sees the same id (phone number) and then it correctly expects the same entity as before.
And that could be one option for the not necessarily trust, but for avoiding collisions. Like a sort of phone number for each one.
Then a method like identify could return a sort of phone number, than the consumer can use along the name. Altough I'm afraid this could complicate communication. Like if bob wants to send a message to atlas, it does 

send_message("atlas-ags", "Hello")
Internally the library does something like
send_message("atlas-ags", "Hello", "bob")
if we have a sort of "phone number" then bob would get that phone number... which could be reused for every other thing, so thats something... and it could even be the same ags, but what about other participants?
What about a user ? 
Well... that would go directly into the logic wouldnt it? No but we still need different objects for user1 and user2. One option would be that both users are kind of identified, maybe with a userId? Or maybe theres a getPhoneNumber() method that returns some kind of id (we wouldnt call the method that of course).
But what if the consumer is an agent, with an mcp endpoint (not implemented yet but thats another thing)? Then it would need to call the method to get a "phone number" and then use that ? Which is not so different from providing a name in any case, and providing a name risks small typos, and it makes it also difficult for the library to ensure collisions. If the library generates those, then it can always generate a new one

?















































# mmmmmm

You’re right. I used “authorized” too strongly.

The library does not necessarily have enough information—or the correct responsibility—to prove that an external caller really is Bob. What it can provide is stable identification and attribution:

> “This message claims to come from the same participant identifier previously recorded as Bob.”

That prevents collisions and supports continuity. It is not authentication.

## Identifier versus trust

The phone-number analogy works well:

- The ID is stable and unique.
- The display name can change.
- Conversations are matched using the ID.
- Seeing the same ID lets Atlas associate the sender with the same prior participant.
- Possessing or presenting the ID does not necessarily prove ownership of it.

So the library should promise:

```text
stable identity reference
collision avoidance
consistent attribution
conversation lookup
```

It should not automatically promise:

```text
authenticated identity
authorization
proof that the caller controls that identity
```

Consumers that need authentication can add it at their transport boundary.

## Managed agents already have their number

For library-managed agents, `agentSessionId` can be the address:

```ts
{
  agentSessionId: "ags-atlas",
  name: "Atlas"
}
```

There is no need for another generated “phone number” for Atlas.

A model-facing messaging tool can be exactly what you described:

```ts
send_message("ags-atlas", "Hello");
```

Because the tool is installed in Bob’s `AgentSession`, its runtime context already knows the local sender:

```ts
messaging.send({
  receiver: "ags-atlas",
  message: "Hello",

  // Supplied by the tool host, not by the model:
  sender: {
    id: "ags-bob",
    name: "Bob",
  },
});
```

This is not really authentication. It is contextual attribution: the call happened through the tool instance associated with Bob.

The model does not need to call `getPhoneNumber()` for itself on every message. Its own identity is bound when the tool is created.

## Direct API calls

A direct consumer API has two reasonable forms.

Bound to an agent:

```ts
await bob.sendMessage({
  to: "ags-atlas",
  message: "Hello",
});
```

The sender naturally comes from `bob`.

Or manager-level:

```ts
await agents.sendMessage({
  from: "ags-bob",
  to: "ags-atlas",
  message: "Hello",
});
```

In the second form, the library records what the consumer asserted. Unless the consumer provides an authentication integration, it does not claim to have proven it.

The library can still catch structural mistakes. For example, a tool bound to Bob should not simultaneously claim `from: "ags-orion"`. Rejecting that is consistency checking, not a general authorization system.

## Users and other participants

This suggests a more general concept underneath agents: a participant or actor reference.

```ts
interface ParticipantRef {
  id: string;
  kind: "agent" | "user" | "service" | "external";
  name?: string;
}
```

A managed agent naturally uses its `ags-` ID:

```ts
{
  id: "ags-bob",
  kind: "agent",
  name: "Bob"
}
```

A user could use an ID supplied by the consumer:

```ts
{
  id: "my-app:user:4831",
  kind: "user",
  name: "Alice"
}
```

Or the consumer could ask the library to mint one:

```ts
const alice = await participants.create({
  kind: "user",
  name: "Alice",
});

// alice.id = "participant-..."
```

For consumers that already have user accounts, generating another unrelated ID every time would be undesirable. A `resolveOrCreate` mapping would be more useful:

```ts
const alice = await participants.resolveOrCreate({
  namespace: "my-app",
  externalId: "user-4831",
  kind: "user",
  name: "Alice",
});
```

The library stores a mapping from the consumer’s identity namespace to an opaque participant ID.

This remains optional. A consumer can provide its own stable IDs directly.

## Not every participant is addressable

It helps to distinguish:

- Participant identity: who spoke.
- Agent address: something the messaging system can route to.

Every managed `AgentSession` is both:

```text
participant identity: ags-atlas
routable agent address: ags-atlas
```

A user may only be a participant:

```text
participant identity: app:user:4831
routable agent address: none
```

An external agent could be registered as a participant and optionally have a route:

```ts
{
  participant: {
    id: "external-agent-...",
    kind: "agent",
    name: "Orion"
  },
  route: {
    kind: "mcp",
    endpoint: "..."
  }
}
```

The participant model should not require every speaker to expose a callable endpoint.

## Recording incoming prompts

The prompt API will eventually need speaker metadata:

```ts
await conversation.prompt("Can you review this?", {
  speaker: {
    id: "ags-bob",
    kind: "agent",
    name: "Bob",
  },
});
```

Internally, the ACP harness may still receive this as a `user`-role prompt. But persistence can preserve the actual speaker:

```text
protocol role: user
speaker ID: ags-bob
speaker kind: agent
display name at the time: Bob
```

That allows Atlas to find its existing conversation with the same participant ID even if Bob is renamed later.

The name is presentation. The ID establishes continuity.

## Remote MCP callers

An MCP endpoint introduces the exact trust boundary you identified.

There are several possible deployments:

### MCP server bound to a managed agent

If Bob’s `AgentSession` owns the MCP client/tool configuration, the library knows that calls from that tool context are locally attributed to Bob.

No self-identification call is required.

### External caller supplies a participant ID

The caller sends:

```ts
{
  sender: {
    id: "some-stable-id",
    name: "Bob"
  },
  target: "ags-atlas",
  message: "Hello"
}
```

The library records this as a claim. It does not authenticate it.

### Consumer authenticates the transport

The hosting application authenticates an API key, process, Unix socket, OAuth identity, or some other credential and maps it to a participant:

```ts
resolveCaller(requestContext): ParticipantRef
```

The library receives the resolved participant and does not need to implement the authentication system itself.

This could be an optional integration hook:

```ts
interface ParticipantResolver {
  resolveCaller(context: unknown): Promise<ParticipantRef | null>;
}
```

But it should not be required for local orchestration.

## Discovery

Discovery results should contain both ID and name:

```ts
[
  {
    id: "ags-atlas",
    kind: "agent",
    name: "Atlas",
    description: "Repository and architecture agent"
  },
  {
    id: "ags-orion",
    kind: "agent",
    name: "Orion"
  }
]
```

The model sends to the ID:

```ts
send_message("ags-atlas", "Hello");
```

Names can still be accepted as a convenience, but resolution should fail explicitly if the name is ambiguous. IDs avoid typos, renames, and collisions.

A `who_am_i` or `describe_self` capability may be useful for introspection, but messaging correctness should not depend on the model calling it. The tool runtime already knows its local participant.

## Local contact records

Each agent database can naturally accumulate its own local knowledge of participants:

```text
atlas.sqlite contacts

ID          KIND    LAST KNOWN NAME
ags-bob     agent   Bob
user-4831   user    Alice
```

This does not create a global relationship between databases. It simply lets Atlas recognize a participant it has encountered before.

When an incoming message identifies the sender as `ags-bob`, Atlas’s conversation resolver can find the local conversation associated with that contact.

## Recommended contract

I would use this rule:

> acp-lib provides stable participant references and records attribution. It only provides authentication when the consumer supplies an authenticated binding.

Concretely:

- `ags-xxx` is both the stable participant ID and routing address of a managed agent.
- Users and external participants can use consumer-provided or library-minted IDs.
- Display names are mutable metadata, never primary identity.
- A tool bound to an `AgentSession` injects the sender ID automatically.
- External calls may contain asserted sender IDs.
- Consumers may install an authentication-to-participant resolver.
- The database records where attribution came from if useful, without declaring it universally trusted.

So Bob’s ordinary model-facing interaction stays simple:

```ts
send_message("ags-atlas", "Hello");
```

The complexity remains behind the tool boundary, where it belongs.





# Refactor

• Yes, the code would benefit from refactoring—but selectively. The problem is not primarily that src/ contains many files. The main issue is that a few modules, especially agent-session.ts, own too many
  responsibilities and sit across unclear architectural boundaries.

  I made no changes.

  ## Current size

  The source has roughly 27,500 lines of TypeScript, excluding the generated 8,797-line pricing catalog.

  The largest handwritten files are:

   File                                        Lines    Assessment
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/agent-session.ts:1                      3,687    Clear refactoring priority
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/persistence/transcript-reader.ts:1      1,212    Too many reader concerns combined
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/metering/engine.ts:1                      999    Large, but relatively cohesive
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/client.ts:1                               967    Large, but represents one ACP client state machine
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/persistence/records.ts:1                  912    Types and validation should separate
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/persistence/file-registry-store.ts:1      740    File I/O, locking, validation, and cursors combined
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/persistence/transcript-runtime.ts:1       737    Large but likely superseded by backend work
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/persistence/restoration.ts:1              689    Complex transaction coordinator
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/controller.ts:1                           644    Reasonably cohesive
  ──────────────────────────────────────────  ───────  ─────────────────────────────────────────────────────
   src/index.ts:1                                554    Very broad public barrel

  There is one obvious outlier: agent-session.ts is more than three times the size of the next TypeScript file and imports around 35 internal modules.

  ## AgentSession is the main structural problem

  The file begins with roughly 500 lines of public types, errors, configuration, continuation types, events, and queue definitions before the class itself starts at src/agent-session.ts:609.

  The class then handles:

  - Direct and managed construction.
  - Transcript and audit initialization.
  - Provider continuation strategies.
  - Provider-thread reconstruction.
  - Configuration restoration.
  - Recovery resolution.
  - Prompt queueing.
  - Prompt execution.
  - Handoff.
  - Mode switching.
  - Configuration mutation.
  - Metering.
  - Activity aggregation.
  - Presentation persistence.
  - Legacy V1 transcript compatibility.
  - V2 persistence.
  - Managed registry publication.
  - Lifecycle notifications.
  - Controller delegation.
  - Session listing and bridging.

  That is effectively several state machines inside one class.

  It also matches our architectural discussion: the current AgentSession is already doing the work of a future AgentConversation, but it additionally knows too much about managed storage transactions and registry
  coordination.

  ## Recommended target grouping

  I would move toward this structure conceptually:

  src/
    agent/
      agent-session.ts
      identity.ts
      tools.ts
      directory.ts

    conversation/
      agent-conversation.ts
      config.ts
      types.ts
      events.ts
      operation-queue.ts
      prompt-operation.ts
      continuation.ts
      configuration.ts
      transitions.ts
      presentation.ts

    controller/
      agent-controller.ts
      commands.ts
      config.ts

    persistence/
      contracts/
        agent-store.ts
        conversation-store.ts
        audit-sink.ts

      sqlite/
        sqlite-agent-store.ts
        schema.ts
        migrations.ts

      jsonl/
        writer.ts
        transcript-reader.ts
        audit-reader.ts
        migration.ts

    metering/
    protocol/
    degraded/
    repl/
    cli/

  This is a direction, not a recommendation to move every file immediately.

  ## How I would divide the current AgentSession

  The public class should eventually be mostly a facade:

  class AgentConversation {
    private readonly operations: ConversationOperationQueue;
    private readonly continuation: ConversationContinuation;
    private readonly configuration: ConversationConfiguration;
    private readonly presentation: ConversationPresentation;
    private readonly metering: MeteringEngine;
    private readonly controller: AgentController;
    private readonly persistence: ConversationPersistence;
  }

  ### Public contracts and types

  Move the types currently occupying the beginning of agent-session.ts into focused files:

  conversation/types.ts
  conversation/config.ts
  conversation/events.ts
  conversation/errors.ts
  conversation/continuation-types.ts

  This also fixes dependencies such as persistence progress code importing AgentSessionPromptability from the giant high-level module.

  ### Operation queue

  The queue beginning around src/agent-session.ts:1702 handles prompts, handoffs, configuration, mode changes, and recovery operations.

  Extract a general conversation operation queue responsible for:

  - FIFO ordering.
  - Cancellation before dispatch.
  - Phase changes.
  - Pump lifecycle.
  - Queue-length state.

  It should invoke operation handlers without knowing their implementation.

  ### Continuation and opening

  Creation, opening, provider loading, reconstruction, and configuration restoration occupy a very large portion of the class.

  This can become something like:

  ConversationOpener
  ConversationContinuationCoordinator

  It would return an initialized runtime rather than mutating dozens of fields on an incompletely constructed AgentSession.

  ### Configuration coordinator

  Configuration restoration and mismatch resolution are already a distinct subsystem:

  restore configuration
  detect mismatch
  accept effective state
  replace provider thread
  apply selections
  checkpoint results

  This is a good independent component.

  ### Transition coordinator

  Mode switches and handoffs share several concepts:

  - Start transition.
  - Create target provider session.
  - Activate target.
  - Persist checkpoint.
  - Complete or fail transition.

  A ConversationTransitionCoordinator could own that common lifecycle while exposing separate handoff() and setMode() operations.

  ### Presentation/activity persistence

  The activity and presentation queue around src/agent-session.ts:3035 is another clean extraction candidate:

  ConversationPresentationRuntime

  It would own:

  - ActivityAggregator.
  - Assistant message revisions.
  - Presentation write ordering.
  - Activity projection.
  - Live presentation_recorded events.

  ### Prompt execution

  runPrompt() is one of the most coupled areas because it touches the controller, persistence, presentation, metering, and recovery. I would extract it last, after those dependencies have interfaces.

  Otherwise it risks becoming a large helper that still reaches into every private field of AgentSession.

  ## Persistence needs different treatment

  The persistence directory already has many files—about 11,200 lines—but its problem is not insufficient splitting. It has implementation concepts mixed with domain contracts.

  For example:

  - src/persistence/records.ts:97 contains all transcript/audit record types and all validation.
  - AuditLogReader imports SESSION_LOG_READER_INTERNALS from TranscriptReader, meaning shared physical file I/O is hidden inside one specific reader.
  - SessionManager mixes legacy and managed modes, using runtime checks to determine which kind of store it owns.
  - Managed creation/restoration modules directly construct AgentSession, tying filesystem transactions to the high-level runtime.

  Before adding SQLite, I would establish backend-neutral contracts:

  interface AgentStore {
    conversations: ConversationStore;
    identity: IdentityStore;
    audit: AuditSink;
  }

  interface ConversationStore {
    create(...): Promise<...>;
    appendMessage(...): Promise<...>;
    appendActivity(...): Promise<...>;
    getCheckpoint(...): Promise<...>;
    readMessages(...): Promise<...>;
  }

  Then:

  SQLiteAgentStore
  JsonlConversationStore

  The existing JSONL implementation can move behind the latter without needing to beautify every current file first.

  ### Refactors worth doing in existing persistence code

  - Separate record declarations from validators.
  - Extract shared physical line reading, snapshot boundaries, hashing, and cursor primitives from TranscriptReader.
  - Separate file registry validation/cursor code from file locking and atomic replacement.
  - Move legacy transcript code into an explicitly named compatibility area.
  - Remove backend-specific paths from domain-level checkpoint types over time.

  ### Refactors I would defer

  I would not deeply redesign:

  - transcript-runtime.ts
  - restoration.ts
  - reconfiguration.ts
  - JSONL generation replacement logic

  until the SQLite/backend design is decided. Much of that complexity exists specifically because multiple JSONL files and a registry file must simulate transactions. SQLite will change those workflows
  substantially.

  ## SessionManager

  src/session-manager.ts:70 is only 379 lines, but its abstraction is already strained:

  - It supports a legacy SessionStore.
  - It supports the managed AgentSessionStore.
  - It manages creation, loading, deletion, restoration, reconfiguration, checkpoints, maintenance, and legacy import.
  - It will soon need to distinguish top-level agents from conversations.

  Our discussed split fits the code:

  AgentSessionManager
    manages ags-xxx entities
    discovery
    agent persistence locations
    identity/tool configuration

  AgentConversationManager
    scoped to one agent
    manages acv-xxx entities
    creates/loads/deletes conversations

  Conversation operations such as prompt, mode switch, provider handoff, and recovery should be methods on AgentConversation, not methods on either manager.

  I would also eventually isolate the old compatibility manager instead of keeping one class with two mutually exclusive modes.

  ## Other large files

  ### AcpClient

  At 967 lines, src/client.ts:187 is large, but it mostly represents one cohesive ACP client state machine. It could eventually extract:

  - Permission request handling.
  - Session switching/replay.
  - Terminal capability handlers.

  It is not an urgent refactor.

  ### AgentController

  src/controller.ts:109 is similarly cohesive: it swaps between ACP and degraded clients and exposes the richer controller API. Configuration string parsing could move out, but the class itself has a reasonable
  boundary.

  ### Metering engine

  src/metering/engine.ts:168 is large but internally organized around one metering state machine. Its pure policy resolution, rating, and cost reconciliation could be extracted, but I would prioritize AgentSession
  first.

  ### Public exports

  src/index.ts:1 is a 554-line flat barrel. It makes the public surface difficult to understand.

  Eventually, subpath exports would help:


  The test suite is strong and provides good refactoring protection: roughly 13,700 lines with focused persistence, activity, continuation, restoration, and metering coverage.

  One outlier is test/agent-session-metering-records.test.ts:64 at 1,328 lines. Its existing describe sections are already natural file boundaries. Splitting it would improve navigation without affecting product
  design.

  Shared fixture builders could also reduce some repetition across the agent-session persistence tests.

  ## Refactoring order

  I would not perform a broad folder reorganization first. A safer order is:

  1. Decide the new domain vocabulary: AgentSession, AgentConversation, and their IDs.
  2. Extract public types/errors from agent-session.ts without behavior changes.
  3. Introduce backend-neutral persistence contracts.
  4. Extract presentation/activity handling.
  5. Extract the operation queue.
  6. Extract configuration and transition coordinators.
  7. Extract continuation/opening.
  8. Extract prompt execution last.
  9. Add the top-level multi-conversation AgentSession.
  10. Introduce SQLite behind the new persistence contracts.
  11. Move JSONL into a clearly named compatibility/archive backend.
  12. Reorganize folders and exports once the boundaries are real.

  The central principle is: use the upcoming AgentSession/AgentConversation split to drive the refactor. Avoid spending time merely making the existing JSONL-centered architecture look tidier before replacing its
  underlying boundaries.



I suggest proceeding in layers, deliberately separating architectural decisions, refactoring, storage replacement, and agent communication. Trying to do them together would make regressions difficult to diagnose.

## 1. Freeze the core model first

Before changing code, write a short architecture document establishing these provisional decisions:

```text
AgentSession              ags-xxx
  durable agent-level entity
  identity
  persistence location
  default tools
  conversations

AgentConversation         acv-xxx
  one locally stored conversation
  prompt queue
  messages and activities
  provider continuation
  recovery, mode, configuration, metering

AgentController
  one active harness connection/runtime
  attached to an AgentConversation when needed

internalSessionId
  provider-owned thread ID
  belongs to an AgentConversation
```

Recommended invariants:

- `ags-xxx` remains stable and becomes the top-level ID.
- Every conversation receives a new stable `acv-xxx` ID.
- Conversations belonging to the same agent may run concurrently.
- Operations within one conversation remain serialized.
- There is no intrinsically special “main” conversation.
- Conversations are local and independently reconstructable.
- Cross-agent conversations need not be correlated.
- Identity is opaque and consumer-defined.
- Persistence location remains explicitly configurable.
- Discovery, messaging, and tool transports are deferred.

This document should also establish the migration rule:

> Every existing `ags-xxx` becomes a new top-level `AgentSession` containing one generated `AgentConversation`.

That prevents existing IDs from changing meaning unpredictably.

## 2. Refactor the current `AgentSession` without changing behavior

The first implementation work should be purely structural. No SQLite, new top-level agent, or public rename yet.

Keep the existing public `AgentSession` API working while extracting internal components.

Suggested sequence:

### 2.1 Extract contracts

Move types and errors out of the 3,687-line file:

```text
src/conversation/
  types.ts
  config.ts
  events.ts
  errors.ts
  continuation-types.ts
```

Existing root exports remain unchanged.

### 2.2 Extract presentation/activity handling

Create:

```text
conversation/presentation-runtime.ts
```

Move:

- Activity aggregation.
- Assistant message revisions.
- Presentation persistence queue.
- Transcript activity projection.
- `presentation_recorded` emission.

This subsystem already has a relatively clean boundary.

### 2.3 Extract the operation queue

Create:

```text
conversation/operation-queue.ts
```

It owns:

- FIFO scheduling.
- Conversation phase.
- Queued-operation count.
- Cancellation before dispatch.
- Pump lifecycle.

It dispatches operations to handlers but does not implement prompts, handoffs, or configuration itself.

### 2.4 Extract configuration and transitions

Create:

```text
conversation/configuration-runtime.ts
conversation/transition-runtime.ts
```

The transition runtime owns the common start/create/activate/complete/fail lifecycle used by mode changes and provider handoffs.

### 2.5 Extract continuation/opening

Create:

```text
conversation/continuation.ts
conversation/opener.ts
```

Construction should eventually return a fully initialized conversation runtime rather than gradually mutating a partially initialized object.

### 2.6 Extract prompt execution last

Prompt execution touches almost everything. Extract it only after controller, persistence, presentation, and metering have clear interfaces:

```text
conversation/prompt-operation.ts
```

At the end, the current public class should primarily compose these components.

Exit criterion for this stage:

- No observable behavior change.
- No persistence format change.
- Existing exports remain compatible.
- Full test suite passes after every extraction.

## 3. Define backend-neutral persistence

Before writing SQLite code, define the contract it must implement.

Avoid mirroring the JSONL implementation. Model what the domain needs:

```ts
interface AgentStore {
  readonly conversations: ConversationStore;
  readonly identity: IdentityStore;
  readonly audit: AuditSink;
  transaction<T>(operation: AgentStoreTransaction<T>): Promise<T>;
}

interface ConversationStore {
  create(...): Promise<ConversationRecord>;
  get(...): Promise<ConversationRecord | null>;
  list(...): Promise<ConversationPage>;

  appendMessage(...): Promise<StoredMessage>;
  appendActivity(...): Promise<StoredActivity>;
  readMessages(...): Promise<MessagePage>;

  getCheckpoint(...): Promise<ConversationCheckpoint | null>;
  saveCheckpoint(...): Promise<void>;
}
```

Important decisions here:

- Messages are first-class rows, not vaguely reconstructed “events.”
- Activities, permissions, and operations are separate but can share timeline ordinals.
- Provider continuation belongs to a conversation.
- Database paths do not appear inside domain checkpoint identities.
- Oversized content can eventually use a blob abstraction.
- Identity storage may be opaque.
- Audit is a sink/interface, not necessarily another table in the same database.

The existing file implementation can then become a backend:

```text
JsonlAgentStore
SQLiteAgentStore
```

Even if JSONL cannot support every future feature efficiently, it can implement a documented subset.

## 4. Implement SQLite per agent

Once the contract exists, implement one SQLite database per `AgentSession`.

Configuration:

```ts
persistence: {
  backend: "sqlite",
  path: "/repository/.agents/atlas.sqlite",
}
```

Initial schema:

```text
schema_migrations
agent
conversations
messages
activities
permissions
operations
conversation_checkpoints
provider_sessions
identity_state
blobs
audit_outbox
```

SQLite requirements:

- WAL mode.
- Busy timeout.
- Foreign keys enabled.
- Explicit schema versioning.
- Short transactions.
- Atomic message/checkpoint updates.
- Separate read connections if useful.
- Document the `-wal` and `-shm` files.
- Do not support unsafe shared-network-filesystem usage.

Add backend contract tests that run against SQLite and, where applicable, JSONL.

Concurrency tests should cover:

- Ten different agent databases writing concurrently.
- Several conversations in one agent database.
- Concurrent first-time creation of the same conversation lookup.
- Readers during active writes.
- Process interruption around transaction boundaries.
- Reopening and recovering without scanning full history.

## 5. Introduce the new top-level `AgentSession`

After the current implementation has become conversation-shaped internally, introduce the aggregate:

```ts
class AgentSession {
  readonly agentSessionId: string;
  readonly identity: AgentIdentityProvider;
  readonly conversations: AgentConversationManager;
  readonly tools: AgentToolRegistry;
}
```

The extracted current implementation becomes:

```ts
class AgentConversation {
  readonly agentConversationId: string;
  prompt(...): Promise<...>;
  handoff(...): Promise<...>;
  setMode(...): Promise<...>;
  resolveRecovery(...): Promise<...>;
}
```

For compatibility, the old API could temporarily be provided through:

- A legacy facade.
- A deprecated single-conversation helper.
- A major-version migration.

Avoid making `AgentSession` simultaneously mean old conversation and new agent aggregate without an explicit compatibility plan.

## 6. Split the managers

Once the aggregate exists:

```text
AgentSessionManager
  creates, opens, lists, and deletes ags-xxx entities
  owns agent database resolution
  may provide local discovery

AgentConversationManager
  scoped to one AgentSession
  creates, opens, lists, and deletes acv-xxx entities
  resolves local conversation aliases/counterparts
```

Operational methods remain on `AgentConversation`.

The existing legacy/managed dual-mode `SessionManager` can then become a compatibility layer rather than the foundation of the new model.

## 7. Add identity hooks, without defining identity

The first identity API should be intentionally narrow:

```ts
interface AgentIdentityProvider {
  resolve(context: {
    agentSessionId: string;
    agentConversationId: string;
  }): Promise<ResolvedIdentity>;

  observe?(interaction: SettledConversationInteraction): Promise<void>;
}
```

Do not initially define RAG, memory facts, scopes, merging, or synchronization.

Establish only:

- Identity is resolved immediately before dispatch.
- One operation uses one fixed identity snapshot.
- Settled interactions may be reported afterward.
- The provider controls concurrency and update semantics.

## 8. Add discoverability and messaging later

Once agents and conversations are real concepts:

```text
AgentDirectory
AgentMessagingService
IncomingConversationResolver
ParticipantRef
```

Then implement tool transports separately:

```text
direct TypeScript API
MCP adapter
native harness adapter
```

The semantic messaging service should not depend on MCP.

## 9. Address audit rotation independently

Do not block the core SQLite work on compliance-grade auditing.

Initially support:

- Audit table or outbox in SQLite.
- Existing JSONL audit sink.
- Rotation by size/time.
- Compression of sealed files.
- Configurable retention hooks.

Later, add immutable external sinks if required.

## Practical delivery slices

I would make the work reviewable in roughly these slices:

1. Architecture document and ID/lifecycle definitions.
2. Extract `agent-session` public types and errors.
3. Extract presentation runtime.
4. Extract operation queue.
5. Extract configuration and transition runtimes.
6. Extract continuation/opening.
7. Define persistence contracts.
8. Implement SQLite store and contract tests.
9. Introduce `AgentConversation`.
10. Introduce top-level `AgentSession`.
11. Split managers.
12. Add identity hooks.
13. Add discovery and messaging.
14. Add MCP/native tool adapters.
15. Improve audit rotation and external delivery.

The immediate next step should be the architecture document—not code. It needs to pin down the three identities (`ags`, `acv`, provider session), ownership boundaries, lifecycle, and old-data migration. Once that is agreed, the first code change should be a behavior-preserving extraction from `agent-session.ts`.




Yes—that sequencing makes sense:

1. Define the basic architecture and invariants.
2. Refactor toward it through roughly step 7, preserving current behavior and compatibility.
3. Stop and reassess using what the refactor revealed.
4. Specify the less-settled areas—identity, discovery, participants, messaging, and tools—in more detail.
5. Continue implementation through roughly step 12.

The first definition should be deliberately narrow. We should commit to:

- `AgentSession` (`ags-...`) as the persistent agent-level entity.
- `AgentConversation` (`agc-...`) as one conversation belonging to that agent.
- `AgentController` as the active harness/process controller used by a conversation.
- Multiple independent conversations per agent.
- No intrinsically special “main” conversation.
- Stable participant identifiers, without claiming they provide authentication.
- Explicitly configurable persistence location.
- Conversations independently reconstructable from stored messages.
- Identity as an opaque agent-level capability, without defining its internal memory model yet.
- No enforced relationship between the conversations stored by two communicating agents.

And yes, `agc` is better than `acv`. It reads naturally as **agent conversation**, is immediately distinguishable from `ags`, and avoids the slightly ambiguous “conversation/view” feel of `acv`:

```text
ags-...  AgentSession
  ├── agc-...  conversation with user A
  ├── agc-...  conversation with user B
  └── agc-...  conversation with Atlas
```

I would avoid fully specifying messaging and identity before the refactor. We should reserve the necessary boundaries—identity provider, participant metadata, tool registry, conversation resolver—but keep them minimal. After the current `AgentSession` has become `AgentConversation` internally and the ownership boundaries are real in code, we will be in a much better position to define steps 8–12 without designing around today’s accidental structure.

So the immediate next artifact should be a short architecture document containing:

- terminology and ownership;
- stable IDs (`ags`, `agc`, provider/internal session ID);
- lifecycle relationships;
- persistence boundaries;
- concurrency invariants;
- compatibility and migration rules;
- explicitly deferred decisions.

Then the first implementation tranche is primarily structural refactoring, with no SQLite, identity semantics, discovery, or cross-agent messaging yet.


Yes. I have enough context to proceed through the initial architecture definition and the behavior-preserving refactor, up to roughly step 7.

I’ll use these constraints:

- `AgentSession` / `ags-...` becomes the agent-level owner.
- `AgentConversation` / `agc-...` represents each independent conversation.
- `AgentController` remains the harness/process layer.
- Existing behavior and public APIs remain compatible during the structural refactor.
- Persistence interfaces become backend-neutral, but SQLite is not implemented yet.
- Existing JSONL behavior remains operational.
- Identity gets only an opaque boundary—not a prescribed memory model.
- Discovery, messaging, participant trust, MCP/native tools, and detailed identity behavior remain deferred.
- Existing user changes in the worktree are preserved.
- Each extraction is verified with the existing tests, with focused tests added only where necessary to preserve behavior.

I can also choose sensible internal file boundaries and documentation placement without needing further decisions from you. The natural stopping point is when the ownership model exists cleanly in code and the remaining steps—identity, discovery, messaging, and tools—can be designed against it rather than against the current monolithic structure.



We’re at the planned Step 7 design checkpoint. The codebase is stable and ready for the second implementation tranche, but the new agent model is not implemented yet.

What exists now:

- The target hierarchy is defined: `AgentSession → AgentConversation → AgentController`.
- `ags-...` and `agc-...` ID primitives exist, but are not yet wired into existing persistence.
- The current `AgentSession` still represents one conversation and remains backward-compatible.
- Conversation concerns have started moving into explicit modules:
  - contracts and errors;
  - serialized operation queue;
  - presentation/activity runtime;
  - continuation/opening policy.
- All changes are split across seven commits.
- Typecheck passes and all 698 tests pass.

What does not exist yet:

- The actual top-level, multi-conversation `AgentSession`.
- The renamed `AgentConversation` public class.
- `AgentConversationManager` and the manager split.
- Legacy-record migration into `ags + agc`.
- Backend-neutral conversation/message storage.
- SQLite persistence.
- Agent-level identity behavior.
- Discovery, messaging, participants, MCP/native tools, or authorization hooks.

So structurally:

```text
Today:
AgentSession (actually one conversation)
  ├── extracted conversation components
  └── AgentController

Target:
AgentSession (agent identity, storage, tools)
  └── AgentConversation[]
        ├── extracted conversation components
        └── AgentController
```

The next step should be the focused design pass we planned before steps 8–12. I’d resolve these in order:

1. Identity provider contract and concurrency semantics.
2. Participant and speaker representation.
3. Incoming-conversation selection.
4. Agent/conversation storage contract.
5. Exact SQLite schema and migration strategy.
6. Only then, discovery and cross-agent messaging/tool adapters.

The detailed checkpoint is in [SPEC-agent-session-conversation-boundary.md](/home/ffacu/q/apps/libs/acp-lib/.res/SPEC-agent-session-conversation-boundary.md), and every completed step is recorded in [9-16-LOG-refactor.md](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-16-LOG-refactor.md).




We have defined ownership and terminology. What remains is defining the contracts that connect those objects.

The essential decisions before implementation are:

1. Agent identity

We need to define what the library asks from an identity system, without defining what identity contains.

Recommended minimal contract:

```ts
interface IdentityProvider {
  resolve(context: IdentityResolutionContext): Promise<IdentitySnapshot>;
  observe?(observation: IdentityObservation): Promise<void>;
}
```

We need to decide:

- Is identity resolved before every prompt or once when opening a conversation?
- Does `observe` happen after every completed interaction?
- Does it receive the full exchange, references to stored messages, or both?
- How are concurrent updates from different conversations handled?
- Does the library provide a trivial default provider?
- What happens if identity resolution or observation fails?

My recommendation: resolve before every operation, observe after settlement, snapshot identity for the operation, and let the provider define concurrency/versioning.

2. Participants and authorship

We need a canonical participant model:

```ts
interface ParticipantRef {
  id: string;
  kind: "agent" | "user" | "service" | "external";
  name?: string;
}
```

Questions:

- Is an agent’s participant ID always its `ags-...`?
- Can names change without affecting continuity? Probably yes.
- Can one conversation contain more than two participants?
- Is the local agent stored as a participant, or implied by conversation ownership?
- How does a consumer supply identities for users?
- Do we support participant aliases?

The participant ID provides attribution and continuity, not authentication.

3. Conversation selection and routing

When Atlas receives something from Bob, we need to decide which Atlas conversation receives it.

Possible default:

```ts
resolveIncomingConversation({
  receiver: atlas,
  sender: bob,
  channel?: "some-channel",
  metadata?: ...
})
```

The resolver could:

- reuse an existing Atlas–Bob conversation;
- create a new conversation;
- route by channel/task;
- route into a group conversation;
- let the consumer decide completely.

The important decision is the default uniqueness key. I recommend:

```text
owner agent + participant set + optional consumer routing key
```

But this must be configurable. The library must not assume there can only ever be one Atlas–Bob conversation.

4. Message model

This is the most important persistence decision. We should define messages directly rather than making consumers reconstruct chats from vague events.

At minimum, a stored message needs:

```ts
interface ConversationMessage {
  id: string;
  conversationId: AgentConversationId;
  sequence: number;
  author: ParticipantRef;
  content: MessageContent;
  createdAt: string;
  status: "in_progress" | "completed" | "cancelled" | "error";
  replyTo?: string;
  correlationId?: string;
}
```

We need to determine:

- Content representation: text plus structured blocks?
- How attachments and large tool outputs are referenced.
- Whether streamed revisions are retained or folded.
- Whether tool calls/reasoning are messages, activities, or operational records.
- What “full conversation retrieval” guarantees.
- Which content may be truncated versus moved into blobs.
- Whether timestamps come from receipt, sender, or both.
- How imported/external messages are represented.

My recommendation: messages are first-class canonical records; activities and operational events remain separate but share conversation sequence ordering.

5. AgentConversation API

We need to settle how a caller supplies the speaker:

```ts
conversation.prompt("Hello", {
  author: bobParticipant,
});
```

or:

```ts
conversation.send({
  author: bobParticipant,
  content: [{ type: "text", text: "Hello" }],
});
```

We also need:

- creation/open configuration;
- participant management;
- history retrieval and pagination;
- controller lifecycle;
- identity injection behavior;
- whether detached conversations remain supported;
- how handoff and provider-thread replacement are exposed.

I lean toward retaining `prompt()` as a convenience and introducing a richer `send()` operation beneath it.

6. Persistence contract

Before SQLite, define backend-neutral domain operations:

```ts
interface AgentStore {
  conversations: ConversationStore;
  messages: MessageStore;
  checkpoints: CheckpointStore;
  providerSessions: ProviderSessionStore;
  identity?: IdentityStateStore;
  auditOutbox?: AuditOutboxStore;

  transaction<T>(
    work: (tx: AgentStoreTransaction) => Promise<T>,
  ): Promise<T>;
}
```

We need to define:

- Which writes must be atomic.
- Conversation/message pagination semantics.
- Sequence allocation under concurrency.
- Optimistic revisions or compare-and-set behavior.
- Blob handling.
- Soft deletion versus permanent deletion.
- Schema migration/version ownership.
- Whether consumers may implement only part of the store.

7. SQLite configuration and schema

The current direction is one SQLite database per agent.

We need to settle:

- Exact path configuration.
- Whether the path is a file or directory-plus-name.
- Database creation/open behavior.
- WAL and busy-timeout defaults.
- Schema migrations.
- Connection ownership and shutdown.
- Cross-process access guarantees.
- Tables and indexes.
- Whether audit data can share the database when no separate sink is configured.
- JSONL import/export behavior.

I recommend accepting an exact database path:

```ts
storage: {
  kind: "sqlite",
  path: "/mounted/agents/atlas.sqlite",
}
```

Directory-plus-name can be a consumer convenience, but the resolved path should always be visible.

8. Compatibility and migration

We need an explicit release strategy because `AgentSession` currently means “conversation.”

The working proposal is:

- Internally rename the existing implementation to `AgentConversation`.
- Keep the old `AgentSession` API as a deprecated compatibility facade.
- Introduce the new owner under a preview/unambiguous name or subpath.
- Make the semantic name change in a major release.
- Migrate one legacy session into one agent containing one generated `agc`.
- Preserve existing valid `ags` IDs.
- Preserve old transcript/audit files and reference them rather than rewriting them.

We need to decide the preview name and whether this is handled in one major release or through a transitional version.

9. Audit contract

We should define:

- Which actions count as audit records.
- Whether audit contains content or references message IDs and hashes.
- Separate destination configuration.
- Rotation by bytes/time.
- Failure behavior: block the operation or record an audit delivery gap.
- Durable outbox behavior with SQLite.
- Retention and deletion independence.

JSONL remains reasonable here, especially as rotated sealed segments. Plain timestamped text can be an optional human-readable log, but not the authoritative audit representation.

What can remain deferred:

- Agent discovery implementation.
- `send_message` semantics.
- Native harness tool definitions.
- MCP adapter.
- Authentication/authorization.
- PostgreSQL.
- Group-agent orchestration policies.

Those depend on the participant, conversation-routing, and message contracts, so we should not define them first.

The best next discussion is the combination of identity, participants, and conversation routing. They affect each other, while the SQLite schema should follow from the resulting domain model.






For participant I think "agent", "user", "external" is ok for now
Can names change without affecting continuity? -> yes
Can one conversation contain more than two participants? -> so... yes, but it's not that simple. So for the target agent, we can think it as two parts: itself and "others". So a group chat is feasible, but I think not for now.
Is the local agent stored as a participant, or implied by conversation ownership? -> It is all stored in the same db, so I'm not sure if this is needed. We could have the ags, but i dont know
How does a consumer supply identities for users? <-- I think is just open ? Like at any time I can send a message and if this is a new id then implicitly I created a new identity ? 
Do we support participant aliases? -> im not sure what this means, but if you mean a 2nd name then no need for that




4. Originally we were doing a thing were we would take all the messages and make them a single text. We dont do that. We have to preserve the actual quantity of messages to accurately show it, be it one, or two or whatever. We dont join or do anything like that
I don't think we should make everything a message, and we also need an interface, that messages, activities, etc can implement.
- agentSessionId (maybe not necesasry ? )
- agentConversationId
- role (assistant | user)
- content
- metadata -> this is useful for the consumer, it could be a string in which the consumer puts json data
- timestamp

I think thats it ? I dont know if status is specific to activities or everythin

user could be from a users table, which has
- id

Also I dont like author

5. why would I need to specify the type of content Im going to send? Okay maybe to send images that makes sense. Well in any case .prompt must be part of the api

6. Why would we need a checkpoint store? Isnt this a concern of the converasion ? Donno explain what you mean with this 


7. 
"storage" I think undersells it. Maybe persistence, or even other thing we could think. Then if we are going to accept an extension we have to check it, altough this seems a little strange
Also, what do we do with jsonl ? I think multiple chats into a single jsonl will be pretty bad for locks and all that. If each conversation has its own path, then I think this should be possible ? 

8. 
No but if this is done correctly, then we shouldnt have problems with existing AgentSessions. Suppose I have an ags-xxx.jsonl, then I should be able to load it.... which we should define how to do that

9. 
we already delegated to the consumer what they want to define as audit record. What we can do is keep that modularity options, but instead of 4 options reduce to a single default. or keep it like that i donno
Then on the rotation and the other things I think yes, altough explain what those imply (block the operation on failure, or "durable outbox", etc)

We dont need to add plain timestamp, jsonl is ok




It should probably help if we define the external interface, i.e. the way a consumer would use the library






---



Yes—the external interface is the right thing to define next. Your answers simplify several parts of the model.

## Revised participant model

For now:

```ts
type ParticipantKind = "agent" | "user" | "external";

interface Participant {
  readonly id: string;
  readonly kind: ParticipantKind;
  readonly name?: string;
}
```

Rules:

- `id` defines continuity.
- `name` is mutable display information.
- No aliases.
- A previously unseen participant ID is created implicitly when first used.
- Reusing an ID with a new name updates the displayed name.
- Reusing an ID with a different `kind` should fail because that is likely a collision.
- Participant IDs identify; they do not authenticate.
- Participants are scoped to the agent’s database.

For a user from the consumer’s user table:

```ts
const participant = {
  id: user.id,
  kind: "user",
  name: user.displayName,
};
```

The target agent does not need to be repeated on every message. It is implied by conversation ownership:

- `role: "assistant"` means the owning `AgentSession`.
- `role: "user"` means the other participant identified by `participantId`.

We can keep the data model capable of multiple participants, but expose only one-to-one conversations initially. Group-chat routing can come later without changing message records.

## Conversation records

I agree that messages, activities, and other records need a shared interface, but `role`, `content`, and `status` do not belong on every record.

A cleaner base is:

```ts
interface ConversationRecordBase {
  readonly id: string;
  readonly agentConversationId: AgentConversationId;
  readonly type: string;
  readonly timestamp: string;
  readonly metadata?: string;
}
```

Then messages specialize it:

```ts
interface ConversationMessage extends ConversationRecordBase {
  readonly type: "message";
  readonly role: "assistant" | "user";

  /**
   * Required for user messages.
   * Omitted for assistant messages because the owning agent is implied.
   */
  readonly participantId?: string;

  readonly content: MessageContent;
  readonly status: "completed" | "cancelled" | "error";
}
```

Activities specialize it differently:

```ts
interface ConversationActivity extends ConversationRecordBase {
  readonly type: "activity";
  readonly activity: ActivityEvent;
}
```

An activity can carry its own tool/execution status inside `activity`. Status should not be imposed on every record type.

`agentSessionId` does not need to be repeated on every record:

```text
record → conversation → owning agent session
```

For portable JSONL, the file header can contain both `agentSessionId` and `agentConversationId`. Individual lines only need the conversation ID if we want each line to remain independently identifiable.

### Message preservation

This should be a strict invariant:

> Every logical message remains an individual message record.

If an assistant produces two messages, persistence stores two messages. The retrieval API returns two messages. We never combine them to produce the canonical history.

A convenience `result.text` can remain for compatibility, but it is merely a projection. The canonical result is:

```ts
result.messages
```

The library must not persist `result.text` in place of those messages.

For content, `.prompt()` remains string-first:

```ts
await conversation.prompt("Hello");
```

Multimodal input can be supported without making ordinary callers construct blocks:

```ts
await conversation.prompt("What is in this image?", {
  attachments: [image],
});
```

Internally, persistence can normalize text and attachments into content blocks. That does not need to leak into the common API unless the consumer wants the advanced form.

`metadata?: string` can remain completely opaque to the library. The consumer may put serialized JSON there; the library stores it exactly and does not interpret it.

## Proposed consumer interface

The normal flow could be:

```ts
const atlas = await AgentSession.open({
  id: "ags-...",
  persistence: {
    kind: "sqlite",
    path: "/mounted/agents/atlas.sqlite",
  },
  defaults: {
    adapter: ADAPTERS.codex,
    adapterId: "codex",
  },
  identity,
});
```

A conversation with a user:

```ts
const conversation = await atlas.conversations.getOrCreate({
  participant: {
    id: user.id,
    kind: "user",
    name: user.displayName,
  },
});

const result = await conversation.prompt("Hello", {
  metadata: JSON.stringify({
    source: "telegram",
    telegramMessageId: "123",
  }),
});
```

A conversation with Bob:

```ts
const conversation = await atlas.conversations.getOrCreate({
  participant: {
    id: "ags-bob",
    kind: "agent",
    name: "Bob",
  },
});

await conversation.prompt("Hello, I am Bob");
```

The participant is bound to the conversation, so it does not need to be supplied on every prompt.

To create a second conversation with the same user:

```ts
const another = await atlas.conversations.create({
  participant: {
    id: user.id,
    kind: "user",
    name: user.displayName,
  },
});
```

Therefore:

- `getOrCreate({ participant })` returns the default one-to-one conversation.
- `create({ participant })` always creates a new `agc`.
- `open(agentConversationId)` selects an exact conversation.

Retrieval:

```ts
const page = await conversation.messages.list({
  limit: 100,
  cursor,
});
```

This returns the exact messages, in their original quantity and order.

For a richer timeline:

```ts
const page = await conversation.records.list({
  types: ["message", "activity"],
  limit: 100,
  cursor,
});
```

That preserves the distinction between chat messages and operational activity.

## What “checkpoint store” meant

You are right: checkpoints are a conversation concern. They should not look like an independent consumer-facing subsystem.

A checkpoint is the durable runtime state needed to reopen a conversation safely:

- active provider `internalSessionId`;
- provider-thread history;
- mode and adapter;
- configuration restoration targets;
- recovery state;
- last settled/in-flight operation;
- metering state.

It is not chat content, and consumers normally should not manage it.

So instead of:

```ts
agentStore.checkpoints
```

the persistence boundary should look more like:

```ts
interface AgentPersistence {
  createConversation(...): Promise<ConversationPersistence>;
  openConversation(...): Promise<ConversationPersistence>;
  listConversations(...): Promise<...>;
}

interface ConversationPersistence {
  appendRecords(...): Promise<void>;
  readMessages(...): Promise<...>;
  readRecords(...): Promise<...>;

  // Internal conversation recovery state.
  loadRuntimeState(): Promise<ConversationRuntimeState>;
  saveRuntimeState(...): Promise<void>;
}
```

The checkpoint still exists internally, but it belongs to `ConversationPersistence`.

## Persistence naming and paths

I agree that the public configuration should be called `persistence`, not `storage`.

```ts
persistence: {
  kind: "sqlite",
  path: "/some/exact/location/atlas.sqlite",
}
```

We should not infer or enforce the backend from the file extension. This should also be valid:

```ts
persistence: {
  kind: "sqlite",
  path: "/mounted/state/atlas",
}
```

`kind: "sqlite"` already tells us the format. Requiring `.sqlite` would be arbitrary.

A custom implementation could be:

```ts
persistence: {
  kind: "custom",
  backend: myAgentPersistence,
}
```

## JSONL layout

One JSONL file containing every conversation would create unnecessary locking and retrieval problems. The sensible new JSONL layout is a directory:

```text
atlas/
  agent.json
  participants.json
  conversations/
    agc-111.jsonl
    agc-222.jsonl
    agc-333.jsonl
  audit/
    ...
```

Each conversation then has:

- independent append locking;
- independent size and rotation;
- independent retrieval;
- no need to scan unrelated conversations.

Configuration:

```ts
persistence: {
  kind: "jsonl",
  root: "/mounted/agents/atlas",
}
```

### Existing `ags-xxx.jsonl`

Existing files must remain loadable.

For an existing file:

```ts
const atlas = await AgentSession.open({
  persistence: {
    kind: "jsonl",
    path: "/old/location/ags-xxx.jsonl",
  },
  // Runtime adapter configuration...
});
```

The library can inspect the existing regular file and recognize the legacy single-conversation layout:

- retain its `ags-xxx` as the owning agent ID;
- create or deterministically derive an `agc-xxx` for its single conversation;
- retain the existing transcript path;
- expose that conversation through `atlas.conversations`;
- avoid rewriting the transcript merely to rename concepts.

For new JSONL agents, `root` selects the directory layout. For legacy loading, `path` selects an existing file. That removes ambiguity:

```ts
{ kind: "jsonl", root: "..." } // new multi-conversation layout
{ kind: "jsonl", path: "..." } // existing single-conversation file
```

The existing compatibility `AgentSession.open()` behavior can remain while this new owner API is introduced.

## Audit configuration

The current content-policy flexibility can remain, but we can have one default policy instead of making consumers choose among four presets.

For example:

```ts
audit: false | {
  sink: {
    kind: "jsonl";
    root: "/separate/audit/location";
  };

  projector?: AuditProjector;
  rotation?: {
    maxBytes?: number;
    maxAgeMs?: number;
  };

  delivery?: "required" | "best_effort" | "outbox";
}
```

If `projector` is omitted, the library uses one documented default. A consumer that has its own definition of an audit record supplies a projector.

### Rotation

Rotation means an audit log does not grow forever:

```text
audit/
  2026-09-17-0001.jsonl
  2026-09-17-0002.jsonl
  current.jsonl
```

When `current.jsonl` reaches the configured size or age:

1. close it;
2. mark or rename it as an immutable segment;
3. open the next segment;
4. retain a manifest so readers know segment order.

### Delivery failure choices

`required`:

- Audit persistence is part of operation success.
- Pre-dispatch audit failure prevents contacting the model.
- A post-dispatch failure cannot undo model work, so the conversation becomes blocked/uncertain until resolved.
- Stronger audit completeness, lower availability.

`best_effort`:

- The conversation continues when audit writing fails.
- The error is reported, but an audit gap may exist.
- Higher availability, weaker audit guarantees.

`outbox`:

- With SQLite, the canonical record and a pending audit-delivery row are committed in the same database transaction.
- A worker writes pending rows to the separate audit destination.
- If the process crashes or the audit destination is unavailable, pending rows survive and are retried.
- This provides durable eventual delivery without keeping a model operation open while an external sink is unavailable.

The outbox is the best default for SQLite. Pure JSONL cannot atomically commit changes to two independent files, so it can offer `required` or `best_effort`, but not the same transactional guarantee without adding another durable coordination store.

## Remaining decisions

This leaves a much smaller set to settle:

1. Whether `getOrCreate({ participant })` should be the standard one-to-one routing operation.
2. Whether message `content` is publicly a string-plus-attachments or a normalized block array.
3. How the legacy `agc` ID is generated—deterministically from the transcript identity or recorded in a migration sidecar.
4. What the single default audit projection contains.
5. Whether JSONL audit delivery defaults to `required` or `best_effort`.
6. The identity provider interface and its failure/concurrency behavior.

Once those are resolved, we can write the complete external API as a coherent consumer workflow before designing the SQLite tables.







Yes. We need two independent policy layers:

- What gets captured when writing.
- What view the consumer requests when reading.

Adding SQL should not remove the existing modular capture system.

## 1. Write-time capture policy

Both transcript and audit log should retain independent capture policies:

```ts
interface PersistenceConfig {
  backend:
    | { kind: "sqlite"; path: string }
    | { kind: "jsonl"; root: string }
    | { kind: "custom"; implementation: AgentPersistence };

  transcript: false | {
    preset?: TranscriptPreset;
    capture?: Partial<ConversationCapturePolicy>;
  };

  auditLog: false | {
    destination?: AuditDestination;
    preset?: AuditPreset;
    capture?: Partial<ConversationCapturePolicy>;
    delivery?: "required" | "best_effort" | "outbox";
    rotation?: AuditRotation;
  };
}
```

A preset should only expand into a capture policy. Consumers can then override individual categories.

```ts
interface ConversationCapturePolicy {
  messages: "none" | "full";

  toolCalls:
    | "none"
    | "metadata"
    | "input"
    | "output"
    | "full";

  permissions:
    | "none"
    | "decision"
    | "full";

  configuration:
    | "none"
    | "changes"
    | "definitions_and_changes";

  protocol:
    | "none"
    | "normalized"
    | "raw";

  nativeActions:
    | "none"
    | "summary"
    | "full";

  agentInitiatedActions:
    | "none"
    | "summary"
    | "full";

  thinking:
    | "none"
    | "full";

  activity:
    | "none"
    | "metadata"
    | "content"
    | "full";
}
```

We can refine the exact values, but the important part is preserving per-category write control.

Permissions should now be captured. Omitting them from the current format is a real gap.

The transcript and audit policies remain separate. For example:

```ts
persistence: {
  backend: {
    kind: "sqlite",
    path: "/agents/atlas.sqlite",
  },

  transcript: {
    preset: "conversation",
    capture: {
      permissions: "full",
      toolCalls: "full",
      thinking: "none",
      protocol: "none",
    },
  },

  auditLog: {
    destination: {
      kind: "jsonl",
      root: "/audit/atlas",
    },
    capture: {
      messages: "none",
      permissions: "full",
      configuration: "changes",
      nativeActions: "full",
      protocol: "normalized",
    },
    delivery: "outbox",
    rotation: {
      maxBytes: 128 * 1024 * 1024,
    },
  },
}
```

The database backend, transcript policy, and audit policy are three different concepts. My previous version compressed them too much.

## 2. Typed conversation records

We should have a common envelope without pretending everything is a message:

```ts
interface ConversationRecordBase {
  readonly id: string;
  readonly agentConversationId: AgentConversationId;
  readonly sequence: number;
  readonly type: ConversationRecordType;
  readonly timestamp: string;
  readonly metadata?: string;
}

type ConversationRecordType =
  | "message"
  | "tool_call"
  | "permission"
  | "configuration"
  | "protocol"
  | "native_action"
  | "agent_initiated_action"
  | "thinking"
  | "activity"
  | "marker";
```

Each record type then has its own appropriate fields. There should be no universal `status` or `role`.

### Messages

```ts
interface ConversationMessage extends ConversationRecordBase {
  readonly type: "message";
  readonly role: "assistant" | "user";
  readonly participantId?: string;
  readonly content: MessageContent;
  readonly status?: "completed" | "cancelled" | "error";
}
```

`status` is useful for a partial assistant message when a prompt is interrupted or fails, but it does not belong on every record.

Message boundaries are never collapsed. Two assistant messages remain two database records and are returned as two messages.

### Tool calls

SQL lets us avoid treating every update as another visible tool call.

I recommend two representations:

```text
tool call projection       one current row per invocation
tool call lifecycle        immutable transition records when policy requires them
```

The current projection could contain:

```ts
interface ToolCallRecord extends ConversationRecordBase {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly name: string;
  readonly status:
    | "announced"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

  readonly announcedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;

  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: string;
}
```

An update changes the projection row rather than creating another visible tool call.

However, when transcript or audit policy requests lifecycle fidelity, we also append transitions:

```text
tool_call_announced
tool_call_input_known
tool_call_started
tool_call_completed
```

This gives us:

- one clean tool-call record for the UI;
- transition history for auditing and crash recovery;
- no duplicated tool calls;
- the ability to retain intermediate changes when requested.

Every separate invocation still receives a different `toolCallId`. We never overwrite one invocation with a later invocation of the same tool.

The same projection-plus-transitions pattern works for:

- permissions;
- native conversation actions;
- configuration changes;
- thinking blocks with streaming revisions.

### Permissions

A permission record should retain:

```ts
interface PermissionRecord extends ConversationRecordBase {
  readonly type: "permission";
  readonly permissionId: string;
  readonly toolCallId?: string;
  readonly request: unknown;
  readonly options?: readonly unknown[];
  readonly outcome?: unknown;
  readonly requestedAt: string;
  readonly resolvedAt?: string;
}
```

`capture.permissions: "decision"` could keep only what was requested and the result. `"full"` would preserve the options and full normalized request.

### Configuration

We need both:

- Announced configuration definitions: available models, effort values, descriptions, etc.
- Configuration selections: `/config model ...`, previous value, requested value, resulting value, success/failure.

This is also how an old conversation can accurately show which model and effort were active at different points.

### Raw ACP protocol

Raw protocol frames should remain optional because they can be extremely large and sensitive.

When enabled, they should go into a separate table or payload/blob area rather than making ordinary message queries scan them.

### Native actions

Handoff, mode switch, recovery, provider-thread replacement, and similar actions become typed `native_action` records with lifecycle fields:

```text
started → target_created → activated → completed/failed
```

This is essentially the current transition model, generalized under conversation persistence.

### Thinking and activity

Thinking remains distinct from messages.

Activities include file edits, terminal execution, plans, usage, and other harness activity. They can reference their associated tool call or operation when applicable.

## 3. One sequence across all record types

Every conversation should have one monotonically increasing record sequence:

```text
1  message
2  thinking
3  tool call
4  activity
5  message
6  marker
7  permission
8  tool call
9  message
```

This sequence represents observed ordering across the entire conversation.

A tool-call projection can have:

```ts
firstSequence: number;
lastSequence: number;
```

Its lifecycle transitions receive their own sequence positions, while the folded UI representation remains anchored at `firstSequence`.

That gives us exact interleaving without making every transition appear as a separate tool call.

## 4. Markers instead of “sentinels”

Yes, this is useful and easy to support. I would call them conversation markers or anchors.

```ts
const marker = await conversation.mark("point-1");
```

Later:

```ts
const records = await conversation.records.between({
  after: "point-1",
  before: "point-2",
});
```

Or only messages:

```ts
const messages = await conversation.messages.between({
  after: "point-1",
  before: "point-2",
});
```

A marker is a record in the shared sequence:

```ts
interface ConversationMarker extends ConversationRecordBase {
  readonly type: "marker";
  readonly name: string;
}
```

It does not require resequencing anything. If it is created between records 20 and 21, it simply receives the next sequence according to the operation ordering.

For a retroactive marker:

```ts
await conversation.mark("before-refactor", {
  afterMessageId: "msg-...",
});
```

We should not insert it physically into old sequence positions. Instead, the marker stores a reference to the chosen boundary:

```ts
positionAfterSequence: 153;
```

Range queries then use that recorded boundary. No existing sequence changes.

SQL makes marker range queries cheap with an index on:

```text
(agent_conversation_id, sequence)
```

JSONL can support the same API, but it may need to scan the file unless we add a sidecar index.

## 5. Checkpoints in SQLite

A checkpoint is not “the last record in the database.” Relational tables have no meaningful physical end.

It would be one current runtime-state row per conversation:

```text
conversation_runtime_state
────────────────────────────────
agent_conversation_id  PRIMARY KEY
revision
internal_session_id
adapter_id
mode
state_json
digest
updated_at
```

Conceptually:

```ts
interface ConversationRuntimeState {
  revision: number;
  internalSessionId: string | null;
  providerSessionHistory: ...;
  configuration: ...;
  recovery: ...;
  metering: ...;
  operationBoundary: ...;
}
```

When an operation becomes durable, one SQLite transaction can:

1. append the typed conversation records;
2. update tool/activity/message projections;
3. update the conversation runtime-state row;
4. add audit-outbox records.

On open:

```sql
SELECT ... FROM conversation_runtime_state
WHERE agent_conversation_id = ?
```

That is an indexed single-row lookup. No transcript scan is needed.

We can optionally retain checkpoint history for debugging or audit, but only the latest checkpoint is needed for normal reopening.

This remains an internal concern of `AgentConversation` and its persistence object—not something consumers have to manipulate.

## 6. Conversation API remains rich

Yes, existing conversation-level functionality should remain available.

```ts
conversation.prompt(...)
conversation.handoff(...)
conversation.setMode(...)
conversation.setConfig(...)
conversation.resolveConfigurationMismatch(...)
conversation.resolveRecovery(...)
conversation.executeInternalSessionCommand(...)
conversation.interrupt(...)
conversation.stop(...)
conversation.bridge(...)
conversation.authenticate(...)
```

And the current state/reflection surface remains:

```ts
conversation.state
conversation.isBusy
conversation.queuedOperationCount
conversation.promptability

conversation.capabilities
conversation.configOptions
conversation.internalSessionCommands

conversation.internalSessionId
conversation.mode
conversation.model
conversation.providerId
conversation.contextWindow
conversation.providerCost
conversation.meteringSnapshot

conversation.activitySnapshot()
conversation.subscribe(...)
```

The announced ACP surface is especially important:

- capabilities;
- available configuration definitions;
- current configuration values;
- allowed model/effort choices;
- announced internal commands;
- command names, descriptions, and argument metadata.

`AgentConversation` remains the front face for those. `AgentController` remains available as a lower-level escape hatch, as it is now.

The top-level agent adds collection operations without taking those methods away:

```ts
agent.conversations.create(...)
agent.conversations.open(...)
agent.conversations.getOrCreate(...)
agent.conversations.list(...)
```

## 7. The registry remains

Yes, but it separates naturally into two scopes.

### Agent registry

An optional higher-level registry maps:

```text
ags ID → database/backend location and summary
```

For example:

```text
ags-atlas → /agents/atlas.sqlite
ags-bob   → /agents/bob.sqlite
```

This supports listing and discovering agents without opening every database.

### Conversation registry

Inside each agent persistence backend:

```text
agc ID → participants, title, timestamps, lifecycle, active runtime state
```

With SQLite, this is principally the `conversations` table.

The registry continues to own:

- routing metadata;
- lifecycle/tombstones;
- revisions;
- maintenance state;
- persistence locations;
- summaries.

It does not become the transcript itself.

The current registry remains supported during the transition and can be exposed through a compatibility adapter.

## 8. Transcript and audit remain explicit

A complete top-level configuration is closer to:

```ts
const atlas = await AgentSession.open({
  id: "ags-atlas",

  persistence: {
    backend: {
      kind: "sqlite",
      path: "/agents/atlas.sqlite",
    },

    transcript: {
      preset: "conversation",
      capture: {
        messages: "full",
        toolCalls: "full",
        permissions: "full",
        configuration: "definitions_and_changes",
        thinking: "none",
        activity: "content",
        protocol: "none",
      },
    },

    auditLog: {
      destination: {
        kind: "jsonl",
        root: "/audit/atlas",
      },
      capture: {
        messages: "none",
        toolCalls: "metadata",
        permissions: "full",
        configuration: "changes",
        nativeActions: "full",
        protocol: "normalized",
      },
      delivery: "outbox",
      rotation: {
        maxBytes: 128 * 1024 * 1024,
      },
    },
  },
});
```

Runtime state and the registry still exist even if transcript capture is disabled. Disabling transcript content should not necessarily make provider-thread continuation impossible.

## 9. Implicit user identity

Yes, this is a good compatibility rule.

Define a reserved implicit participant:

```ts
const DEFAULT_USER_PARTICIPANT_ID = "acp-lib:default-user";
```

When no participant is supplied:

- `role: "user"` maps to this participant;
- messages belong to the same implicit user;
- the agent can have one default conversation selected for that participant.

For example:

```ts
const conversation = await agent.conversations.getOrCreate();

await conversation.prompt("Hello");
await conversation.prompt("Continue");
```

Both prompts come from the same implicit user.

With an identified user:

```ts
const conversation = await agent.conversations.getOrCreate({
  participant: {
    id: user.id,
    kind: "user",
    name: user.name,
  },
});
```

This also gives legacy JSONL a natural interpretation:

- every old `role: "user"` message belongs to the implicit user;
- every old `role: "assistant"` message belongs to the owning agent;
- the old `ags-xxx` remains the owning agent ID;
- the old file is exposed as one default conversation;
- an `agc-xxx` can be derived deterministically from the transcript identity;
- no messages need to be rewritten;
- no participants need to be injected into old JSONL lines.

That is not really a data migration. It is a compatibility projection over the old file.

The only restriction is that a single legacy JSONL file cannot suddenly hold additional conversations. It can continue operating as a one-conversation agent. Creating more conversations would require either:

- opening an agent-level JSONL directory;
- moving to SQLite;
- or explicitly upgrading the file into a multi-conversation layout.

The implicit participant can remain as a convenience indefinitely. We may later discourage it for multi-user applications, but it does not need to be removed from the model.




Yes. This gives us a good extensible foundation without implementing every feature now.

### Markers and future record types

Markers can be deferred entirely. The important part is that persisted items already have:

- A stable record ID.
- An `agc-...` conversation ID.
- A monotonically increasing sequence number within that conversation.
- A record kind.
- A timestamp.
- Optional metadata.

Then a marker later is simply another record kind that references a sequence position or range:

```ts
{
  kind: "marker",
  name: "before-refactor",
  atSequence: 142
}
```

The same applies to bookmarks, annotations, summaries, branches, evaluations, or anything else we have not imagined yet.

JSONL can represent these things, but querying them becomes increasingly awkward. “Give me messages between these markers” requires scanning the file or maintaining a separate index. SQLite gives us indexed range queries naturally. So JSONL is not incapable; it just gradually turns into a database implementation built beside the JSONL file.

### FTS5

One small correction: FTS5 is not an extra column. It is a separate virtual table containing the full-text index.

We can use an external-content FTS5 table so that SQLite does not store another full copy of the original text inside the FTS table. The actual text remains in our canonical records, while FTS5 stores its token/index structures. SQLite explicitly supports using a table, virtual table, or view as the external content source. [SQLite FTS5 external-content tables](https://sqlite.org/fts5.html#external_content_tables)

Conceptually:

```sql
CREATE VIEW searchable_records AS
SELECT
  records.row_id,
  records.kind,
  /* type-specific projection */
  ... AS searchable_text
FROM records
...;

CREATE VIRTUAL TABLE record_search USING fts5(
  kind UNINDEXED,
  searchable_text,
  content = 'searchable_records',
  content_rowid = 'row_id'
);
```

A few important details:

- The text is not duplicated as original text in FTS5, but the search index still consumes space. It stores tokens, document references, and possibly positional information.
- The canonical record and FTS index must be updated together. SQLite warns that inconsistent external content produces unreliable results. We should update both in the same transaction and provide an index-rebuild operation. [SQLite’s consistency guidance](https://sqlite.org/fts5.html#external_content_table_pitfalls)
- We need an internal numeric `row_id` for SQLite/FTS joins. That does not replace public IDs such as `agc-...`.
- We should verify FTS5 availability when opening a backend and expose it as a persistence capability. FTS5 is commonly compiled in, but SQLite builds can differ.

Every persisted type can define a searchable-text projection:

- Message: textual content.
- Tool call: tool name, arguments, result, error.
- Configuration: command and selected values.
- Native action: action name and relevant parameters.
- Activity: summary, path, command, output.
- Thinking: only when its capture policy permits storing it.
- Raw ACP: probably excluded by default, but configurable.

That gives us APIs along these lines:

```ts
conversation.search("database migration");

agent.search("database migration", {
  kinds: ["message", "tool_call", "configuration"],
  conversationIds: ["agc-..."],
  limit: 50,
});
```

An agent-facing search tool can later call the same API, meaning an agent could search what it previously said or did. Whether that tool is exposed is separate from whether the persistence backend supports search.

FTS5 also provides relevance ranking and snippets, so this is already a useful lexical retrieval layer, not merely `LIKE '%text%'`.

### Identity model

I agree that we should establish and invoke the identity lifecycle now, even while its internal representation remains undefined.

I would distinguish the behavior from the loaded value:

```ts
interface IdentityModel<TIdentity = unknown> {
  load(context: IdentityLoadContext): Promise<LoadedIdentity<TIdentity> | null>;

  update(
    context: IdentityUpdateContext<TIdentity>,
  ): Promise<IdentityUpdateResult | void>;
}
```

And expose it through the agent:

```ts
agent.identity.load(...);
agent.identity.update(...);
```

That reads more clearly than `loadIdentityModel()`, which sounds like it loads the implementation rather than the current identity. Internally, however, the lifecycle would always be invoked:

1. A prompt operation begins.
2. The identity is loaded using the agent, conversation, participant, and incoming-input context.
3. The loaded identity is passed to prompt preparation.
4. The controller runs.
5. Conversation records are committed.
6. The identity model is updated with references to the resulting records.

The update should ordinarily receive record IDs or a sequence range, rather than copies of the entire conversation:

```ts
{
  agentSessionId: "ags-...",
  agentConversationId: "agc-...",
  baseVersion: 17,
  recordRange: {
    fromSequence: 140,
    toSequence: 148
  },
  outcome: "completed"
}
```

The unresolved part is exactly how loaded identity becomes controller context. We should define a small prompt-composition seam for that, because:

- It must not modify the canonical user message.
- It must not be displayed as if the user wrote it.
- It might be static memory, a generated summary, or RAG results.
- ACP itself may constrain how additional context can be delivered.

For concurrency, loaded identities should carry a version. Updates can then use optimistic comparison rather than holding a SQLite transaction open while an agent runs:

```ts
type LoadedIdentity<T> = {
  value: T;
  version: string;
};
```

The identity implementation decides whether to merge, retry, or reject a conflicting update. We should also include a built-in no-op identity model, so the complete lifecycle is wired from the beginning even when identity is disabled.

### RAG in the same database

Yes. There are two different meanings of “extension” here:

1. A library persistence extension that creates and owns additional tables.
2. A native SQLite loadable extension that adds database functionality.

For RAG, we should start with the first:

```text
ext_rag_documents
ext_rag_chunks
ext_rag_embeddings
ext_rag_sources
```

The source table can reference record IDs and conversations, which gives every chunk provenance:

```text
chunk → record → conversation → agent
```

We should reserve an extension migration mechanism:

```ts
interface PersistenceExtension {
  id: string;
  version: number;
  migrate(database: Database): Promise<void>;
  recordsCommitted?(records: PersistedRecord[]): Promise<void>;
}
```

And track installed schema versions:

```text
persistence_extensions
- extension_id
- schema_version
```

FTS5 could support the lexical part of RAG. Embedding/vector similarity would require either application-side comparison or an optional vector-capable SQLite extension. Native SQLite extensions are shared libraries and extension loading is disabled by default for security, so they should be optional capabilities rather than a fundamental requirement. [SQLite loadable extensions](https://sqlite.org/loadext.html)

So the decisions I would carry forward are:

- Defer markers, but preserve stable IDs, kinds, and sequence positions.
- Use optional external-content FTS5 for all configured searchable record types.
- Define and always invoke an opaque, version-aware identity lifecycle.
- Add a persistence-extension and migration seam now.
- Implement RAG later as one such extension, potentially using FTS5 plus an optional vector adapter.











# Identity and multiple chats

Yes. The key is to stop treating identity as one mutable document that conversations overwrite.

Identity should be a memory pool plus derived views of that pool.

### Concurrent identity updates

When A is talking to the user, B, and C concurrently, each conversation can independently append observations:

```text
Conversation user → memory observation 101
Conversation B    → memory observation 102
Conversation C    → memory observation 103
```

There is no winner. SQLite serializes the short inserts, but all three become part of the pool.

```ts
agent.identity.update({
  sourceConversationId: "agc-...",
  sourceRecordIds: ["rec-..."],
});
```

Here, `update()` means “ingest these records”, not “replace the current identity”.

Actual storage might resemble:

```text
identity_memories
- sequence
- memory_id
- source_conversation_id
- source_record_id
- participant_id
- kind
- content
- created_at
- supersedes_memory_id
- status
```

There are still two different kinds of collision:

- Storage collision: easily avoided with generated IDs and idempotency keys.
- Semantic collision: one conversation says “the deployment is Friday”, another says “the deployment moved to Monday”.

We should not blindly merge the latter into one supposed truth. Both observations should remain, including their source and time. The identity system—or its AI consolidator—can later decide that one supersedes the other, preserve both, or express uncertainty.

### Identity snapshots are derived

The durable source of truth would be the append-only pool. A compact identity snapshot is only a derived representation:

```text
identity_snapshots
- snapshot_id
- version
- processed_through_sequence
- content
- created_at
```

An identity worker processes new memories and publishes a new snapshot. If two workers consolidate simultaneously, they can both produce candidates, but publication uses a version check. A losing worker can retry using the newer snapshot.

That small publication race is much easier to manage than merging arbitrary identity blobs.

Also, prompt loading does not need to wait for every memory to be consolidated. It can combine:

1. The latest consolidated snapshot.
2. Relevant memories already in the pool.
3. Recent unprocessed memories after the snapshot watermark.

That means newly arrived information remains visible immediately, even if the slower AI consolidation process has not run yet.

### Waiting for identity freshness

Your blocking idea is reasonable, but it needs a defined boundary. Otherwise “wait because more information may be coming” can wait forever.

Each memory receives a sequence number, and the identity worker exposes:

```text
processedThroughSequence = 142
```

When a prompt begins, it can capture the current maximum:

```text
requiredThroughSequence = 147
```

Then we can support modes such as:

```ts
identity.load({
  consistency: "eventual"
});

identity.load({
  consistency: "through-current",
  timeoutMs: 5_000
});
```

- `eventual`: use the current snapshot plus unconsolidated memories.
- `through-current`: wait until consolidation reaches the sequence that existed when loading began.
- A possible future `exclusive` mode could serialize all conversations for an agent, but that should be exceptional.

It must not wait for still-running conversations to finish. That could deadlock: conversation B waits for identity, while identity waits for conversation B to produce its result.

A consumer-level orchestration barrier can explicitly wait for selected operations when that behavior is desired.

### Identity as a separate AgentSession object

I agree with this shape:

```text
AgentSession
├── conversations
├── identity
├── persistence
└── tools
```

The identity component could be an `IdentityRuntime`:

```ts
interface IdentityRuntime {
  load(input: IdentityLoadInput): Promise<LoadedIdentityContext>;

  update(input: IdentityUpdateInput): Promise<void>;

  synchronize?(
    input: IdentitySynchronizationInput
  ): Promise<IdentityWatermark>;
}
```

Internally:

```text
IdentityRuntime
├── MemoryStore
├── MemoryRetriever
├── IdentityConsolidator
└── IdentityModelRunner
```

The loaded identity should not mean “load everything the agent has ever experienced”. It should assemble:

- Stable self-information.
- Memories relevant to the current input.
- Relationship memory for the current participant or participants.
- Current commitments, plans, or unresolved matters.
- Recent unconsolidated observations.

That is closer to how a person behaves: identity is stable, but the memories brought into working context depend on who they are talking to and what they are discussing.

### Using AI inside identity

Yes, the consolidator will probably need model access.

A good design would let `IdentityModelRunner` have multiple implementations:

- Consumer-provided model/API.
- Harness-backed runner.
- Deterministic or no-op runner.
- A future specialized local model.

For the harness-backed option, it should use a separate internal ACP session/controller. It can generally inherit the same executable, environment, configuration, and existing login, but it should not reuse the currently active conversation session.

Otherwise we risk:

- Polluting the visible conversation.
- Reentrant prompts against a busy controller.
- Identity updates recursively generating more identity updates.
- Deadlocks between the visible response and identity processing.

The internal identity session should therefore be explicitly marked as internal and excluded from identity ingestion unless a component deliberately includes it.

### FTS5 and vector search

They solve different retrieval problems:

- FTS5: exact words, names, paths, commands, identifiers, phrases.
- Vector search: semantically similar memories even when they use different words.
- SQL filters: participant, conversation, date, record kind, and provenance.

The useful retrieval system combines all three.

```text
identity_memories
        │
        ├── FTS5 index
        │     lexical matches
        │
        └── embeddings
              semantic matches
```

The FTS5 index can cover both conversation records and extracted identity memories. An identity search for “what did Bob say about the deployment?” might:

1. Filter to memories associated with Bob.
2. Search FTS5 for `deployment`.
3. Run vector search using the complete question.
4. Merge/rerank the results.
5. Return the selected memories with source record IDs.

### Does vector search need another database?

No. My recommended default is to keep it in the same per-agent SQLite database:

```text
identity_memory_embeddings
- memory_id
- embedding_model
- dimensions
- content_hash
- embedding BLOB
- created_at
```

A SQLite vector extension can index those embeddings. SQLite itself now has a Vec1 extension for approximate nearest-neighbor search, although its current documentation identifies it as version 0.7 and explicitly says testing remains insufficient. I would therefore keep vector indexing behind an interface rather than making that particular extension foundational today. [SQLite Vec1 documentation](https://sqlite.org/vec1/doc/trunk/doc/vec1.md)

Something like:

```ts
interface VectorIndex {
  upsert(records: EmbeddingRecord[]): Promise<void>;
  remove(memoryIds: string[]): Promise<void>;
  search(query: VectorQuery): Promise<VectorMatch[]>;
}
```

Implementations could be:

- SQLite vectors in the same agent database.
- An external vector database.
- A simple exact scan for small datasets.
- No vector search, using FTS5 only.

Keeping vectors in the agent database gives us portability and containment. The agent’s database contains its conversations, identity memories, indexes, and embeddings.

An external vector database starts making sense when:

- One installation has millions of memories or embeddings.
- Search must span many agents.
- Multiple machines need concurrent access.
- Vector indexing needs independent scaling.
- The library becomes a centralized harness hub.

Until then, a separate database would add synchronization, deployment, and portability problems without providing much value.

### SQLite concurrency implication

For one agent with several simultaneous conversations, use WAL mode and keep transactions short. WAL allows readers and a writer to proceed concurrently, though SQLite still permits only one writer at a time. Append-style memory writes should be sufficiently short that this is normally fine. [SQLite WAL concurrency](https://www.sqlite.org/wal.html#concurrency)

Because concurrent WAL use is central to this design, we should also require a SQLite version containing the recent WAL-reset fix: SQLite 3.51.3 or one of the documented fixed backports. The official SQLite WAL page describes the affected versions and fixes. [SQLite WAL-reset fix](https://www.sqlite.org/wal.html#walreset)

So the direction I would adopt is:

- Conversations append observations to an identity memory pool.
- Identity snapshots are derived and replaceable, not the source of truth.
- Prompt loading combines a snapshot with recent/relevant unconsolidated memory.
- Freshness can be eventual or watermark-blocking.
- AI consolidation runs through a separate internal model runner.
- FTS5 and vectors index the same memories.
- Both remain in the per-agent SQLite database by default.
- Vector storage stays behind an interface so an external backend remains possible later.



# Plan

We are at the end of Step 7. The next move is to freeze the decisions we just made, then implement them incrementally. I don’t need more design answers to begin this tranche.

I suggest this sequence:

### Step 8 — Final architecture and public contracts

Documentation and type design only:

- Use `Agent` as the new agent-level owner for now, avoiding collision with the existing public `AgentSession`.
- Target hierarchy: `Agent -> AgentConversation -> AgentController`.
- Participant kinds: `agent | user | external`.
- Define the typed record envelope and supported record kinds.
- Define capture policies independently from retrieval.
- Define `PersistenceBackend`, SQLite configuration, JSONL compatibility, audit sink, and extension contracts.
- Specify identity memory pool, snapshots, watermarks, and consistency modes.
- Specify FTS5 search and optional vector-index contracts.
- Specify legacy JSONL mapping and the implicit default user.
- Explicitly defer markers, group conversations, communication tools, actual AI consolidation, and vector implementation.

Commit: `docs: define persistence search and identity architecture`

### Step 9 — Establish the real conversation class

Rename the current implementation internally to `AgentConversation`.

- Preserve the existing `AgentSession` API as a deprecated compatibility facade.
- Rename conversation-oriented contracts where appropriate.
- Keep aliases for existing consumers.
- No persistence or behavior changes.

Commit: `refactor: establish agent conversation runtime`

### Step 10 — Introduce persistence contracts

Add backend-neutral interfaces:

```ts
interface PersistenceBackend {
  conversations: ConversationPersistence;
  records: RecordPersistence;
  checkpoints: CheckpointPersistence;
  providerSessions: ProviderSessionPersistence;
  search?: SearchPersistence;
  identity?: IdentityPersistence;

  transaction<T>(operation: PersistenceTransaction<T>): Promise<T>;
}
```

This step also defines:

- Typed records and type-specific payloads.
- Exact message boundary preservation.
- Capture policies.
- Persistence capabilities.
- Extension migrations.
- Audit outbox interface.
- Conversation reconstruction API.

JSONL remains connected through its existing implementation; nothing is removed.

Commit: `feat: add agent persistence contracts`

### Step 11 — Implement the SQLite backend

One configurable SQLite path per agent:

- Schema migration mechanism.
- Agent metadata.
- Conversations and participants.
- Ordered typed records.
- Exact messages.
- Provider-session history.
- Runtime checkpoints.
- Identity memories, snapshots, and projection watermarks.
- Audit outbox.
- WAL, bounded busy timeout, short transactions, and retry handling.
- Concurrent-connection tests.
- FTS5 external-content index, search, rebuild, and integrity checks.
- Persistence extension registry for later RAG tables.

We should require a SQLite build containing the corrected concurrent-WAL behavior and test the actual Bun SQLite version before enabling multi-connection use.

Commit: `feat: add sqlite agent persistence`

### Step 12 — Add the agent owner and wire identity

Introduce the new public preview object:

```ts
const agent = await Agent.open({
  id: "ags-...",
  persistence: {
    kind: "sqlite",
    path: "./agents/atlas.sqlite",
  },
  identity: identityRuntime,
});

const conversation = await agent.conversations.create({
  participants: [{ id: "user-default", kind: "user" }],
});

await conversation.prompt("Hello");
```

This step adds:

- `Agent`.
- `AgentConversationManager`.
- Agent-scoped search.
- Conversation-scoped search.
- Internal conversation catalog.
- Optional external agent registry.
- Default participant mapping when no user ID is supplied.
- Always-invoked identity lifecycle:

```ts
agent.identity.load(...)
agent.identity.update(...)
agent.identity.synchronize(...)
```

- Append-only memory ingestion.
- Snapshot plus recent-memory loading.
- `eventual` and `through-current` consistency modes.
- A no-op identity implementation.
- Model-runner and vector-index interfaces, without choosing an AI provider or vector engine yet.

Commit: `feat: add agent owner and identity runtime`

### Review after Step 12

At that checkpoint we will have working structural foundations, not every future feature:

- One agent with many conversations.
- SQLite persistence at an explicit path.
- Concurrent conversations.
- Full chat reconstruction.
- Search across records and memory.
- Identity hooks actually executing.
- JSONL still working through the compatibility surface.
- Extension points for RAG and vector search.

Then we review the real API before implementing:

- AI-backed identity consolidation.
- SQLite vector implementation.
- Legacy JSONL import into SQLite.
- JSONL-per-conversation backend for new agents.
- Audit rotation and durable delivery.
- Agent discovery and messaging tools.
- MCP/native tool adapters.
- Markers.

Each step gets its own tests, typecheck, full-suite verification where appropriate, and commit. The existing unrelated dirty files will remain untouched and uncommitted. The immediate next action is Step 8.




---



Exactly. Steps 8–12 establish the new structure while preserving current behavior. Then we run a dedicated integration and hardening phase before considering the architecture complete.

Testing will still happen during every step:

- Typecheck on every commit.
- Focused unit tests for the changed boundary.
- Full suite after significant structural changes.
- One scoped commit per completed step.

After Step 12, we test the entire assembled system:

- Multiple concurrent conversations in one agent database.
- Full transcript reconstruction with exact message boundaries.
- Restarting and reopening an agent database.
- `prompt()`, `handoff()`, `setMode()`, `setConfig()`, internal commands, reflection, interruption, and stopping.
- Identity load/update ordering and watermark synchronization.
- FTS indexing, searching, rebuilding, and recovery.
- Audit outbox delivery and failure behavior.
- Legacy JSONL opening and continued operation.
- SQLite contention, busy retries, abrupt process termination, torn operations, and graceful recovery.

`switch()` is not currently a public conversation method. We can define it as:

```ts
conversation.switch({
  adapter,
  adapterId,
  continuation,
});
```

It would preserve the `agc-...` conversation while replacing its active adapter/controller/provider thread. Its transition would be persisted as `started`, `completed`, or `failed`, and reopening after a partial switch would enter explicit recovery instead of guessing. `handoff()` remains the narrower operation: same conversation and generally the same adapter, but a new provider thread.

The current baseline is healthy:

- Typecheck passes.
- Full suite: **698 passed, 0 failed**.
- Transcript smoke test passes.
- Operations smoke test: **20/20**.
- Metering smoke test: **12/12**.

The earlier failures were caused by the restricted sandbox blocking loopback/subprocess communication; the same tests pass outside that restriction. No repository files were changed by this verification.

After Step 12 we will also run the live harness smokes—tool execution, thinking streaming, permissions, and, where useful, compaction. Those require authenticated CLIs and spend real tokens, so they belong at the final acceptance boundary rather than after every commit.





# handoff, switch and reset

Yes—`switch()` should be a convenience form of `handoff()`, backed by the same internal transition engine.

The distinction is:

- `handoff()` replaces the provider thread, defaulting to the current adapter.
- `switch()` performs the same operation but requires a different target adapter.
- `reset()` performs the same operation without carrying continuation context.

I would avoid positional `lastPrompt` and `initialPrompt`; their direction becomes difficult to remember. Use explicit options:

```ts
await conversation.handoff({
  continuation: {
    kind: "generated",
    sourcePrompt: "Summarize only the technical state and unresolved work.",
  },
  targetPrompt: "Continue by investigating the failing tests.",
});
```

The full contract could be:

```ts
interface HandoffOptions {
  target?: {
    adapterId: string;
    mode?: AgentMode;
    config?: Record<string, unknown>;
  };

  continuation?:
    | {
        kind: "generated";
        sourcePrompt?: PromptInput;
      }
    | {
        kind: "provided";
        content: PromptInput;
      }
    | {
        kind: "none";
      };

  targetPrompt?: PromptInput;
}
```

Its defaults would be:

```ts
{
  target: {
    adapterId: conversation.adapterId
  },
  continuation: {
    kind: "generated",
    sourcePrompt: DEFAULT_HANDOFF_PROMPT
  }
}
```

Then `switch()` is genuinely just an alias:

```ts
conversation.switch = (
  targetAdapterId,
  options = {},
) => conversation.handoff({
  ...options,
  target: {
    ...options.target,
    adapterId: targetAdapterId,
  },
});
```

For example:

```ts
await conversation.switch("claude", {
  continuation: {
    kind: "generated",
    sourcePrompt: "Prepare a concise continuation for another coding agent.",
  },
});
```

One important requirement is that `targetAdapterId` must be resolvable. The new `Agent` should own or receive an adapter registry:

```ts
const agent = await Agent.open({
  persistence: {
    kind: "sqlite",
    path: "./atlas.sqlite",
  },
  adapters: {
    codex: ADAPTERS.codex,
    claude: ADAPTERS.claude,
  },
});
```

Without that registry, `"claude"` is only a name and the library does not know which executable or configuration to start.

### Why `targetPrompt` is still useful

You are right that the consumer could call `prompt()` immediately after the handoff:

```ts
await conversation.handoff();
await conversation.prompt("Continue with the migration");
```

But including it in the handoff provides an atomic “switch and continue” operation:

```ts
const result = await conversation.switch("claude", {
  targetPrompt: "Continue with the migration",
});
```

That guarantees nothing else enters the conversation queue between the transition and the first target prompt. It also lets recovery determine whether:

- The target was created.
- Continuation context was installed.
- The target prompt started.
- The target prompt completed.

If `targetPrompt` is absent, handoff simply transfers context and leaves the target ready for the next ordinary prompt.

The result should then optionally contain the first target response:

```ts
interface HandoffResult {
  transitionId: string;
  kind: "handoff" | "switch" | "reset";
  from: ProviderThreadDescriptor;
  to: ProviderThreadDescriptor;
  continuation?: PromptInput;
  targetResult?: AgentConversationPromptResult;
  meteringRecords: readonly OperationMeteringRecord[];
}
```

### Providing the actual summary

That is not too much—it is already supported today as `handoff({ summary })`. We should retain it but express it more clearly:

```ts
await conversation.handoff({
  continuation: {
    kind: "provided",
    content: "The migration is halfway complete...",
  },
});
```

For compatibility, the existing form can remain temporarily:

```ts
conversation.handoff({
  summary: "..."
});
```

It would normalize internally to `continuation.kind === "provided"` and eventually be deprecated.

### Resetting the agent

There are two different resets:

```ts
await conversation.reset();
```

This preserves the same `agc-...` and visible transcript but starts a fresh provider thread with no continuation context. Internally:

```ts
conversation.handoff({
  continuation: { kind: "none" },
});
```

By contrast:

```ts
await agent.conversations.create(...);
```

creates an entirely new conversation with a new `agc-...`. That is the appropriate choice when the old conversation should not be part of the new chat at all.

Internally, all three operations should normalize into one structure:

```ts
performConversationTransition({
  kind: "handoff" | "switch" | "reset",
  source,
  target,
  continuation,
  targetPrompt,
});
```

This gives us one implementation for persistence, recovery, metering, configuration restoration, lifecycle events, and controller replacement. We should record this API in Step 8, preserve the existing handoff during Steps 9–12, and implement the generalized transition engine once the Step-12 `Agent` adapter registry exists.


Yes—that is the prompt sent to the old AI immediately before replacing it. I called it `sourcePrompt`, but `summaryInstructions` is clearer for the common case.

```ts
await conversation.handoff({
  continuation: {
    kind: "generated",
    summaryInstructions: "Focus on the database decisions, unresolved concurrency risks, and modified files.",
  },
});
```

The library combines those instructions with its standard summary prompt:

```text
Create portable continuation context for a new agent thread.
Include objectives, decisions, completed work, current state, important files,
unresolved risks, and next steps.

Additional instructions:
Focus on the database decisions, unresolved concurrency risks, and modified files.
```

For advanced use, the consumer could replace the prompt completely:

```ts
await conversation.handoff({
  continuation: {
    kind: "generated",
    summaryPrompt: `
      Produce a continuation document containing only:
      1. Database schema decisions
      2. Remaining disagreements
      3. Exact files that should be changed next
    `,
  },
});
```

`summaryInstructions` and `summaryPrompt` would be mutually exclusive:

- `summaryInstructions`: customize the library’s safe default.
- `summaryPrompt`: replace the entire prompt.
- Neither: use the library default.

The complete shape becomes:

```ts
type HandoffContinuation =
  | {
      kind: "generated";
      summaryInstructions?: PromptInput;
      summaryPrompt?: PromptInput;
    }
  | {
      kind: "provided";
      content: PromptInput;
    }
  | {
      kind: "none";
    };
```

So the three important cases are:

```ts
// Let the old AI generate the normal summary.
conversation.handoff();

// Let the old AI generate it, with emphasis chosen by the user.
conversation.handoff({
  continuation: {
    kind: "generated",
    summaryInstructions: "Focus on X and Y.",
  },
});

// Do not ask the old AI; use this exact continuation.
conversation.handoff({
  continuation: {
    kind: "provided",
    content: "The current state is...",
  },
});
```

I would not call it `lastPrompt` in the API because it could be confused with the last user message in the conversation. Internally, however, that is exactly what it is: the final internal prompt executed on the source thread.

It should be persisted as an internal handoff operation—not as a participant-authored chat message—with:

- The effective summary-generation prompt.
- The generated continuation.
- Its source provider thread.
- Metering information.
- Whether generation completed or failed.

Then `targetPrompt`, if supplied, is distinct: it is the first actual instruction sent to the new thread after the generated continuation has been installed.




# Recap

Implemented and committed Steps 8–12.

Key results:

- `Agent (ags) → AgentConversation (agc) → AgentController`
- Caller-selected SQLite path, one database per agent
- Multiple independently recoverable conversations per agent
- WAL concurrency and atomic per-conversation sequencing
- Exact message boundaries and participant attribution
- FTS5 search without a duplicate content table
- Checkpoints, provider history, identity state, extensions, and audit outbox
- Agent-scoped adapter registry
- Always-invoked identity lifecycle
- `promptFrom(participantId, ...)`
- Existing `AgentSession` remains compatible
- JSONL remains available and unchanged

Basic API:

```ts
const agent = await Agent.open({
  persistence: {
    kind: "sqlite",
    path: "./data/atlas.sqlite",
  },
  adapters: {
    codex: { command: ["codex-acp"] },
    claude: { command: ["claude-agent-acp"] },
  },
  defaultAdapterId: "codex",
});

const conversation = await agent.conversations.create({
  participants: [{ id: "user-1", kind: "user" }],
});

await conversation.prompt("Hello");
await conversation.promptFrom("user-2", "Hello from another user");

const messages = await agent.persistence.messages.list(conversation.id);
```

Commits:

- `5c1004e` — persistence/identity architecture
- `d3f0baa` — `AgentConversation` runtime
- `a0dfe90` — persistence contracts
- `e38c48e` — SQLite backend
- `fd0f320` — Agent ownership and identity lifecycle

Verification:

- Typecheck passed
- Package dry-run passed
- Full suite: **721 passed, 0 failed**
- 2,796 expectations

The implementation details are recorded in [SPEC-agent-persistence-identity.md](/home/ffacu/q/apps/libs/acp-lib/.res/SPEC-agent-persistence-identity.md) and [9-16-LOG-refactor.md](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-16-LOG-refactor.md).

The next tranche is the unified transition API: generalized `handoff`, cross-adapter `switch`, `reset`, transition recovery, and automatic persistence of the remaining runtime record families such as tools, permissions, configuration, and activities.

# 







# Gracefull recoery

Yes—this confirms that graceful recovery is not implemented for the new `Agent` + SQLite conversation path.

What happened:

1. SQLite correctly retained the conversation and its active provider-session ID.
2. The third opening found that ID and asked Codex ACP to load it.
3. Codex reported that its underlying rollout file no longer exists.
4. The library propagated that provider error and aborted opening the conversation.

The decisive behavior is in [agent.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent.ts:321):

```ts
providerSession: {
  kind: "load",
  internalSessionId: config.internalSessionId!,
  onFailure: "error",
}
```

So `Agent.conversations.open()` currently means:

> Load exactly the recorded provider session; if it no longer exists, fail.

There is recovery machinery elsewhere in the older transcript-managed path. It supports an ordered strategy such as:

1. Try the existing provider session.
2. If unavailable, build continuation context from the transcript.
3. Create a replacement provider session.
4. Seed it with that continuation context.
5. Persist the replacement as the active provider session.

That machinery is in [agent-session.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent-session.ts:1120), but it depends on the older transcript persistence runtime and is not connected to the SQLite-owned `AgentConversation` path.

There is also an `onFailure: "new"` mode at the lower level, but that alone would merely create an empty thread. It would not reconstruct the conversation, so the model would probably answer `DN`, not `3`.

Therefore the missing feature is specifically:

- SQLite conversation reconstruction/continuation during `Agent.conversations.open()`.
- A public recovery policy on `OpenAgentConversationConfig`.
- Creation and seeding of a replacement provider thread.
- Updating `provider_sessions` so the deleted ID is deactivated and the replacement becomes active.
- A structured recovery result instead of leaking the raw ACP `RequestError`.

The persisted chat itself appears fine. The failure is in reconstructing provider state from that persisted chat when the provider’s private session disappears. No files were edited.



The new recovery should not primarily be the responsibility of the live `AgentConversation`, because when recovery is needed, that conversation cannot yet be opened.

The responsibility should be split like this:

- `AgentConversationManager`: coordinates opening and recovery.
- Recovery policy/runtime: decides what to do and constructs recovery context.
- Persistence backend: supplies conversation records and atomically records the replacement provider session.
- `AgentConversation`: represents the successfully opened live conversation and performs the recovery transition once a new provider session is available.
- Identity runtime: supplies the agent-wide identity context used during reconstruction.

Conceptually:

```text
agent.conversations.open(agcId)
  → try loading recorded provider session
  → provider session missing
  → consult recovery policy
  → load conversation history
  → load agent identity
  → build recovery context
  → create replacement provider session
  → seed replacement without adding a fake user message
  → atomically activate replacement in SQLite
  → return live AgentConversation plus recovery result
```

## Recovery policy

Yes, we should have an explicit recovery policy. Recovery can invoke a model and consume tokens, so it should not happen invisibly.

I would place a default on `Agent` and allow an override when opening an individual conversation:

```ts
const agent = await Agent.open({
  // ...
  recovery: {
    missingProviderSession: "reconstruct",
  },
});

await agent.conversations.open(conversationId, {
  recovery: {
    missingProviderSession: "reconstruct",
  },
});
```

The initial policy could have only two modes:

```ts
type MissingProviderSessionPolicy =
  | "error"
  | "reconstruct";
```

Later, this can grow without changing the fundamental model:

```ts
recovery: {
  missingProviderSession: "reconstruct",
  contextBuilder: customRecoveryBuilder,
  maxAttempts: 1,
}
```

I would avoid calling the whole thing merely `recoveryPolicy` everywhere. A `recovery` configuration containing specific policies is more extensible:

```ts
recovery: {
  missingProviderSession: "reconstruct",
  interruptedTransition: "error",
}
```

These are different failure cases and may eventually need different behavior.

## Who builds the recovery context?

This should not be hard-coded inside `AgentConversationManager`. The manager should orchestrate, while a recovery component builds a portable context from:

- The stored conversation records.
- The current agent identity.
- Conversation participants and metadata.
- The prior adapter/model/configuration.
- Potentially a consumer-provided recovery instruction.

Something approximately like:

```ts
interface AgentConversationRecoveryRuntime {
  reconstruct(input: {
    agentSessionId: AgentSessionId;
    agentConversationId: AgentConversationId;
    records: readonly ConversationRecord[];
    identity: LoadedIdentityContext;
    previousProviderSession: ProviderSessionRecord;
  }): Promise<RecoveryContext>;
}
```

The returned context is then used to initialize a fresh provider thread.

This is important because reconstruction is not necessarily “concatenate all messages.” For very large conversations, the implementation might:

- Use an existing checkpoint or summary.
- Summarize only the unsummarized tail.
- Retrieve relevant records.
- Use the identity memory.
- Ask another model to create portable continuation context.

The persistence layer provides the facts; the recovery runtime decides how those facts become model context.

## Identity status

The identity skeleton was implemented and is wired into the new `Agent` model.

The public contract is in [identity.ts](/home/ffacu/q/apps/libs/acp-lib/src/identity.ts:10):

```ts
interface AgentIdentityRuntime {
  load(...): Promise<LoadedIdentityContext>;
  update(...): Promise<void>;
  synchronize?(...): Promise<IdentityWatermark>;
}
```

The new conversation lifecycle currently:

- Calls `identity.load()` before each normal prompt.
- Prepends `promptPreamble` privately to the provider prompt.
- Calls `identity.update()` when conversation records are persisted.
- Supports eventual or through-current consistency.
- Defaults to `NoopAgentIdentityRuntime`.

That wiring is in [agent.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent.ts:370).

So the integration point exists, but there is no concrete memory implementation yet. The default identity does not remember anything.

There is also a design gap for recovery: the current `identity.load()` contract assumes a normal incoming prompt and participant. Recovery is not a normal participant message. We should avoid passing it a synthetic prompt merely to reuse the method.

The identity API likely needs an explicit conversation/recovery load operation, such as:

```ts
identity.load({
  purpose: "prompt",
  prompt,
  participant,
  // ...
});

identity.load({
  purpose: "recovery",
  // ...
});
```

or separate methods:

```ts
identity.loadForPrompt(...)
identity.loadForRecovery(...)
```

I slightly prefer the explicit `purpose` union because both operations return the same identity context and can share consistency semantics.

Identity and conversation recovery should remain distinct:

- Identity answers: “Who is this agent and what does it remember across conversations?”
- Conversation persistence answers: “What happened in this specific chat?”
- Recovery combines both to reconstruct a provider thread.

Identity should not replace the persisted conversation or become the authority for reconstructing its exact visible history.

## Where should recovery execute?

The manager should own the transaction-like orchestration because it has access to:

- The adapter registry.
- SQLite persistence.
- Provider-session history.
- Agent identity.
- Recovery defaults.
- The map of live conversations.

The live `AgentConversation` can expose or reuse the lower-level operation that:

1. Creates a fresh provider session.
2. Seeds it.
3. Restores compatible configuration.
4. Activates it.

But `AgentConversation` should not independently decide whether recovery is allowed. That decision belongs to the policy supplied to the manager.

This also lets the same mechanism handle a provider session disappearing while a conversation is already live. The conversation detects the provider failure, but delegates recovery to the agent-level coordinator.

## The old recovery mechanism

Yes, it is still present.

The old `AgentSession.open()`/managed-session path has:

- `ContinuationStrategy`
- `OpenContinuationOptions`
- `new_from_transcript`
- `new_from_consumer_continuation`
- continuation reports and attempts
- reconstruction transitions

The core logic is in [agent-session.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent-session.ts:1120), with supporting types in [agent-conversation-contracts.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent-conversation-contracts.ts:63).

It is not entirely dead code: tests, documentation, and the old session-management APIs still refer to it. But it is tied to the old checkpoint/transcript architecture and should not become the foundation of the SQLite mechanism.

A sensible migration would be:

1. Design the new agent-owned recovery interfaces.
2. Implement them for SQLite conversations.
3. Move any generally useful pieces—such as continuation prompts—into neutral recovery utilities.
4. Update old APIs to delegate to the new mechanism where feasible.
5. Remove the old continuation/checkpoint recovery system only after its remaining callers have migrated.

So yes: build a new mechanism first, then remove the older one deliberately rather than trying to bend it around the new architecture.











The new recovery should not primarily be the responsibility of the live `AgentConversation`, because when recovery is needed, that conversation cannot yet be opened.

The responsibility should be split like this:

- `AgentConversationManager`: coordinates opening and recovery.
- Recovery policy/runtime: decides what to do and constructs recovery context.
- Persistence backend: supplies conversation records and atomically records the replacement provider session.
- `AgentConversation`: represents the successfully opened live conversation and performs the recovery transition once a new provider session is available.
- Identity runtime: supplies the agent-wide identity context used during reconstruction.

Conceptually:

```text
agent.conversations.open(agcId)
  → try loading recorded provider session
  → provider session missing
  → consult recovery policy
  → load conversation history
  → load agent identity
  → build recovery context
  → create replacement provider session
  → seed replacement without adding a fake user message
  → atomically activate replacement in SQLite
  → return live AgentConversation plus recovery result
```

## Recovery policy

Yes, we should have an explicit recovery policy. Recovery can invoke a model and consume tokens, so it should not happen invisibly.

I would place a default on `Agent` and allow an override when opening an individual conversation:

```ts
const agent = await Agent.open({
  // ...
  recovery: {
    missingProviderSession: "reconstruct",
  },
});

await agent.conversations.open(conversationId, {
  recovery: {
    missingProviderSession: "reconstruct",
  },
});
```

The initial policy could have only two modes:

```ts
type MissingProviderSessionPolicy =
  | "error"
  | "reconstruct";
```

Later, this can grow without changing the fundamental model:

```ts
recovery: {
  missingProviderSession: "reconstruct",
  contextBuilder: customRecoveryBuilder,
  maxAttempts: 1,
}
```

I would avoid calling the whole thing merely `recoveryPolicy` everywhere. A `recovery` configuration containing specific policies is more extensible:

```ts
recovery: {
  missingProviderSession: "reconstruct",
  interruptedTransition: "error",
}
```

These are different failure cases and may eventually need different behavior.

## Who builds the recovery context?

This should not be hard-coded inside `AgentConversationManager`. The manager should orchestrate, while a recovery component builds a portable context from:

- The stored conversation records.
- The current agent identity.
- Conversation participants and metadata.
- The prior adapter/model/configuration.
- Potentially a consumer-provided recovery instruction.

Something approximately like:

```ts
interface AgentConversationRecoveryRuntime {
  reconstruct(input: {
    agentSessionId: AgentSessionId;
    agentConversationId: AgentConversationId;
    records: readonly ConversationRecord[];
    identity: LoadedIdentityContext;
    previousProviderSession: ProviderSessionRecord;
  }): Promise<RecoveryContext>;
}
```

The returned context is then used to initialize a fresh provider thread.

This is important because reconstruction is not necessarily “concatenate all messages.” For very large conversations, the implementation might:

- Use an existing checkpoint or summary.
- Summarize only the unsummarized tail.
- Retrieve relevant records.
- Use the identity memory.
- Ask another model to create portable continuation context.

The persistence layer provides the facts; the recovery runtime decides how those facts become model context.

## Identity status

The identity skeleton was implemented and is wired into the new `Agent` model.

The public contract is in [identity.ts](/home/ffacu/q/apps/libs/acp-lib/src/identity.ts:10):

```ts
interface AgentIdentityRuntime {
  load(...): Promise<LoadedIdentityContext>;
  update(...): Promise<void>;
  synchronize?(...): Promise<IdentityWatermark>;
}
```

The new conversation lifecycle currently:

- Calls `identity.load()` before each normal prompt.
- Prepends `promptPreamble` privately to the provider prompt.
- Calls `identity.update()` when conversation records are persisted.
- Supports eventual or through-current consistency.
- Defaults to `NoopAgentIdentityRuntime`.

That wiring is in [agent.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent.ts:370).

So the integration point exists, but there is no concrete memory implementation yet. The default identity does not remember anything.

There is also a design gap for recovery: the current `identity.load()` contract assumes a normal incoming prompt and participant. Recovery is not a normal participant message. We should avoid passing it a synthetic prompt merely to reuse the method.

The identity API likely needs an explicit conversation/recovery load operation, such as:

```ts
identity.load({
  purpose: "prompt",
  prompt,
  participant,
  // ...
});

identity.load({
  purpose: "recovery",
  // ...
});
```

or separate methods:

```ts
identity.loadForPrompt(...)
identity.loadForRecovery(...)
```

I slightly prefer the explicit `purpose` union because both operations return the same identity context and can share consistency semantics.

Identity and conversation recovery should remain distinct:

- Identity answers: “Who is this agent and what does it remember across conversations?”
- Conversation persistence answers: “What happened in this specific chat?”
- Recovery combines both to reconstruct a provider thread.

Identity should not replace the persisted conversation or become the authority for reconstructing its exact visible history.

## Where should recovery execute?

The manager should own the transaction-like orchestration because it has access to:

- The adapter registry.
- SQLite persistence.
- Provider-session history.
- Agent identity.
- Recovery defaults.
- The map of live conversations.

The live `AgentConversation` can expose or reuse the lower-level operation that:

1. Creates a fresh provider session.
2. Seeds it.
3. Restores compatible configuration.
4. Activates it.

But `AgentConversation` should not independently decide whether recovery is allowed. That decision belongs to the policy supplied to the manager.

This also lets the same mechanism handle a provider session disappearing while a conversation is already live. The conversation detects the provider failure, but delegates recovery to the agent-level coordinator.

## The old recovery mechanism

Yes, it is still present.

The old `AgentSession.open()`/managed-session path has:

- `ContinuationStrategy`
- `OpenContinuationOptions`
- `new_from_transcript`
- `new_from_consumer_continuation`
- continuation reports and attempts
- reconstruction transitions

The core logic is in [agent-session.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent-session.ts:1120), with supporting types in [agent-conversation-contracts.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent-conversation-contracts.ts:63).

It is not entirely dead code: tests, documentation, and the old session-management APIs still refer to it. But it is tied to the old checkpoint/transcript architecture and should not become the foundation of the SQLite mechanism.

A sensible migration would be:

1. Design the new agent-owned recovery interfaces.
2. Implement them for SQLite conversations.
3. Move any generally useful pieces—such as continuation prompts—into neutral recovery utilities.
4. Update old APIs to delegate to the new mechanism where feasible.
5. Remove the old continuation/checkpoint recovery system only after its remaining callers have migrated.

So yes: build a new mechanism first, then remove the older one deliberately rather than trying to bend it around the new architecture.


It is related to the identity problem, but it is not the same problem.

- Identity represents what the agent carries across every conversation.
- Conversation recovery represents enough state to continue one particular conversation.
- The canonical transcript remains the complete, user-visible record.

Using identity alone for recovery would leak information between conversations and would not preserve the specific thread’s objective, decisions, pending work, or local context.

## Are SQLite checkpoints currently being used?

No—not by the new `Agent`/SQLite runtime.

The SQLite schema contains a `conversation_checkpoints` table, and the persistence backend exposes:

```ts
persistence.checkpoints.get(conversationId)
persistence.checkpoints.put(checkpoint)
```

But the only current caller of `checkpoints.put()` is a persistence backend test. The production `Agent` path neither writes nor reads conversation checkpoints.

So currently:

- `conversation_records`: actively used.
- `provider_sessions`: actively used.
- `conversation_checkpoints`: implemented storage, but unused.
- `identity_memories` and `identity_snapshots`: storage exists, but the default identity runtime does not populate them.
- Old `AgentSessionCheckpoint`: actively used by the old JSONL/managed-session architecture.

Also, the `"checkpoint"` native-action records written during handoff/switch are transition progress events. They are not entries in `conversation_checkpoints`.

## Possible recovery approaches

### 1. Replay the complete transcript

Create a provider session and replay every message.

This gives the closest approximation to the former provider thread, but it has major problems:

- Extremely large conversations may exceed the context window.
- Replaying through ordinary prompts could cause the model to answer every historical message again.
- ACP may not support importing arbitrary assistant/user history.
- It is expensive.
- Tool calls, activities, permissions, and configuration records do not map cleanly to chat messages.

It could be useful for small conversations, but it cannot be the general mechanism.

### 2. Send the transcript as one recovery document

Create a new session and send something like:

```text
You are recovering an existing conversation.

Identity:
...

Prior conversation:
[user] ...
[assistant] ...
...
```

This avoids generating responses for every historical message, but it still fails for sufficiently large conversations. It also turns the entire transcript into one large prompt.

This is a reasonable fallback below a configurable size limit.

### 3. Maintain a conversation recovery checkpoint

Periodically maintain a compact representation of the conversation:

```ts
interface ConversationRecoveryCheckpoint {
  conversationId: AgentConversationId;
  revision: number;
  coveredSequence: number;

  continuation: {
    objective: string;
    currentState: string;
    decisions: string[];
    importantFacts: string[];
    unresolvedQuestions: string[];
    pendingActions: string[];
    relevantResources: string[];
  };

  identitySnapshotVersion?: number;
  createdAt: string;
}
```

Recovery would use:

```text
identity context
+ latest conversation checkpoint
+ records after checkpoint.coveredSequence
```

This scales much better because the recovery input does not grow linearly forever.

The transcript remains canonical. The checkpoint is only a derived continuation projection and can be regenerated.

### 4. Retrieval-based recovery

Instead of attempting to put everything into the new provider’s context:

1. Seed it with the conversation’s current state.
2. Give it tools to search the persisted conversation.
3. Let it retrieve older details as needed through FTS5 or vector search.

This is valuable for very large conversations. But retrieval by itself is not enough: the model still needs an initial understanding of what it is doing now.

Therefore RAG is best combined with a recovery checkpoint.

### 5. Provider-native export/import

Some providers might eventually support exporting and importing a session or supplying prior messages directly.

If supported, this would be an adapter capability:

```ts
adapter.capabilities.sessionImport
```

It could be the highest-fidelity recovery method, but cannot be the portable baseline because ACP providers do not uniformly expose it.

### 6. Identity-only recovery

Load the identity and open a blank conversation.

This recovers the agent’s personality and cross-conversation knowledge, but not the conversation. The agent might remember that PWEAS is `3` if the identity system extracted it, but it might not remember the current task, pending decisions, or what it promised in that particular conversation.

Identity can contribute to recovery, but should not replace conversation recovery.

## Recommended hybrid

I think the proper scalable model is:

```text
Agent identity snapshot
        +
Conversation recovery checkpoint
        +
Uncheckpointed conversation tail
        +
Search/retrieval over complete records
```

Each part has a specific role:

- Identity snapshot: who the agent is and what it knows globally.
- Conversation checkpoint: current state of this particular conversation.
- Tail: recent events that occurred after the checkpoint.
- Retrieval: access to older details omitted from the compact context.
- Transcript: canonical complete history shown to the user.

## Actual recovery sequence

When `conversations.open()` cannot load the provider session:

1. Record that the provider session is unavailable.
2. Consult the explicit recovery policy.
3. Acquire a conversation recovery lock.
4. Read the latest conversation checkpoint.
5. Read all relevant records after `coveredSequence`.
6. Synchronize and load the agent identity.
7. Ask the recovery runtime to combine:

   - Identity context.
   - Checkpoint continuation.
   - Uncheckpointed tail.
   - Conversation and participant metadata.
   - Any consumer recovery instruction.

8. Create a new provider session.
9. Seed it through a private continuation operation.
10. Restore compatible model/configuration settings.
11. Atomically deactivate the missing provider session and activate the replacement.
12. Record the recovery as a native action.
13. Return the opened conversation with a recovery report.

The recovery seed must not become a user message in the visible conversation. It is provider initialization state.

The return value could say what happened:

```ts
{
  conversation,
  providerSession: "reconstructed",
  recovery: {
    reason: "provider_session_missing",
    previousInternalSessionId,
    replacementInternalSessionId,
    checkpointRevision,
    coveredThroughSequence,
    recoveredThroughSequence,
  }
}
```

## How checkpoints should be produced

A checkpoint should not merely be “the last record in the database.” It should be a compact derived state.

Useful checkpoint triggers include:

- Every configurable number of records or tokens.
- After a handoff or switch.
- During graceful shutdown.
- Before deliberately resetting a provider session.
- When the uncheckpointed tail exceeds a threshold.
- Explicitly through `conversation.checkpoint()`.

Checkpoint generation may require AI. That means it should be pluggable:

```ts
interface ConversationCheckpointRuntime {
  create(input: {
    previousCheckpoint?: ConversationRecoveryCheckpoint;
    records: readonly ConversationRecord[];
    identity?: LoadedIdentityContext;
  }): Promise<ConversationRecoveryCheckpoint>;
}
```

The consumer could provide:

- A separate summarization model.
- The current harness.
- A deterministic implementation.
- Its own external service.

The library should coordinate this without assuming which AI service is available.

## Relationship with identity

The two systems can share a general projection architecture:

```text
durable records
   ├── agent identity projection
   └── conversation recovery projection
```

But their outputs and scopes differ:

| Projection | Scope | Purpose |
|---|---|---|
| Identity | Entire agent | Cross-conversation memory and behavior |
| Recovery checkpoint | One conversation | Reconstruct a missing provider thread |

For example, “PWEAS is 3” might enter identity if it is considered enduring agent knowledge. It may also appear in the conversation checkpoint because it is relevant to that chat. That overlap is acceptable: they serve different recovery boundaries.

## Sensible first implementation

We do not need to build the final RAG system immediately. A good first version would be:

- Add an explicit `"error" | "reconstruct"` missing-session policy.
- Define the conversation checkpoint model properly.
- Add a pluggable checkpoint/recovery runtime.
- Use the latest checkpoint plus its unprocessed tail.
- If there is no checkpoint, allow the recovery runtime to process the full transcript.
- Load identity explicitly for recovery.
- Seed a new thread privately.
- Persist the replacement provider-session transition atomically.
- Keep FTS retrieval available for a later provider tool.

That establishes the correct architecture without pretending that simply loading every message scales indefinitely.




# Recovery

I think the key change is: the library should not try to determine `objective`, `decisions`, `importantFacts`, and so on programmatically.

Those fields were too prescriptive. The library does not understand the conversation well enough to populate them reliably.

Instead, the recovery checkpoint should primarily contain opaque continuation context produced by a configurable model-driven process:

```ts
interface ConversationRecoveryCheckpoint {
  conversationId: AgentConversationId;
  revision: number;
  coveredSequence: number;

  continuation: string;

  generator: {
    adapterId: string;
    model?: string;
    strategyId: string;
  };

  createdAt: string;
  metadata?: string;
}
```

The library understands:

- Which records were processed.
- Where the checkpoint ends.
- Which records form the remaining tail.
- How the checkpoint was produced.
- Whether it is current.

The recovery model understands what information matters.

## Option 1: programmatic curation

I agree this is not generally feasible.

We can deterministically preserve some structured facts:

- Active adapter and model.
- Configuration.
- Participants.
- Current working directory.
- Native actions.
- Explicit plans.
- Files touched.
- Pending tool calls.

But these do not tell us the semantic state of the conversation. The important information might be buried in an ordinary message.

Structured facts are useful supplemental recovery data, but cannot be the complete recovery mechanism.

## Option 2: disposable summarization session

This is the most portable foundation.

When a recovery checkpoint needs updating:

1. Create a disposable provider session.
2. Give it the previous checkpoint, if one exists.
3. Give it the conversation records since `coveredSequence`.
4. Ask it to produce updated portable continuation context.
5. Save the returned text and new `coveredSequence`.
6. Destroy the disposable session.

The summarization prompt would be owned by the recovery runtime, not hard-coded into the persistence layer:

```ts
interface ConversationCheckpointRuntime {
  build(input: {
    conversationId: AgentConversationId;
    previous?: ConversationRecoveryCheckpoint;
    records: readonly ConversationRecord[];
    identity?: LoadedIdentityContext;
    targetContextBudget?: number;
    onProgress?: RecoveryProgressListener;
  }): Promise<{
    continuation: string;
    metadata?: string;
  }>;
}
```

The default implementation could use an adapter from the agent registry:

```ts
recovery: {
  checkpoint: {
    strategy: "model",
    adapterId: "codex",
    updateAfterRecords: 50,
  },
}
```

The summarizer can decide objectives, current state, decisions, and relevant facts. The library only provides the evidence and stores the result.

## The problem with summarizing only after failure

If the provider thread disappears after a conversation has grown beyond any model’s context window, we cannot send its complete history to one disposable session.

Therefore checkpoints should be incremental:

```text
checkpoint 1 = summarize records 1–100
checkpoint 2 = summarize checkpoint 1 + records 101–200
checkpoint 3 = summarize checkpoint 2 + records 201–300
```

Input size remains bounded:

```text
previous compact checkpoint
+ recent unprocessed tail
```

This is effectively rolling compaction, but controlled by the library and stored independently from the provider’s private thread.

For an old conversation without a checkpoint, we could bootstrap through chunking:

```text
summarize chunk 1
→ summarize previous result + chunk 2
→ summarize previous result + chunk 3
→ ...
```

That is expensive, but it provides a migration/recovery path.

## Reconstructing the provider JSONL

For Codex specifically, we possess the visible conversation, but not necessarily everything required to reconstruct a valid Codex rollout.

The provider JSONL may contain:

- Internal system prompts.
- Hidden state.
- Tool schemas.
- Reasoning metadata.
- Provider-specific identifiers.
- Environment snapshots.
- Compaction markers.
- Version-dependent internal records.
- Fields that ACP never exposes.

We could manufacture something that resembles a Codex rollout file, but that would mean depending on an undocumented private storage format. It could break whenever Codex changes its implementation.

It would also only work for Codex, while this library is intended to support multiple harnesses.

Therefore I would not make provider JSONL reconstruction part of the portable recovery mechanism.

It could eventually exist as an optional adapter-specific capability:

```ts
interface ProviderSessionRecoveryAdapter {
  reconstructSession?(input: ProviderRecoveryInput): Promise<string>;
}
```

But it should be considered an optimization and not the source of truth.

## “Populate a new session with all the information”

There are two different interpretations.

### Replaying each historical message

```ts
for (const message of history) {
  await session.prompt(message);
}
```

This does not reconstruct history. It asks the model to respond again to every historical user message, producing a different conversation and spending tokens repeatedly.

Without an ACP history-import API, we cannot insert historical assistant messages as genuine prior turns.

### Send the transcript as recovery context

```ts
await newSession.prompt(`
Recover this existing conversation.

${serializedHistory}
`);
```

This can work when the serialized history fits. It is essentially the disposable-summary or continuation-seeding approach.

For small conversations, the recovery policy could use the complete transcript directly:

```text
if transcript fits target recovery budget:
    seed new provider session with full transcript
else:
    seed with checkpoint + recent tail
```

We should not pretend this reproduces the provider’s original internal state, but it can provide good semantic continuity.

## Harness compaction

Compaction is useful but should be treated as an adapter capability, not assumed.

Possible capability:

```ts
interface AdapterRecoveryCapabilities {
  compact?: {
    execute(conversation: AgentConversation): Promise<void>;
  };
}
```

Some harnesses expose `/compact`; some may provide a native command; others provide nothing. Sending the text `"/compact"` is not universally safe because it might be interpreted as an ordinary prompt.

A recovery strategy might be:

```text
create replacement provider session
→ seed recovery context
→ optionally invoke adapter-supported compaction
→ restore configuration
→ activate replacement
```

But if the recovery context already fits comfortably, immediate compaction may only add cost and information loss.

## Recommended recovery context

A replacement session should receive:

```text
agent identity
+ opaque conversation checkpoint
+ recent records after coveredSequence
+ deterministic runtime facts
+ access to conversation search
```

Similar to Hermes:

- Stable system/identity instructions.
- Latest compact semantic state.
- Explicit current plan and relevant workspace state.
- Recent verbatim messages.
- Search access to older history.

The difference is that our transcript remains complete in SQLite. Recovery only determines what enters the model’s limited context.

A practical default might use:

- Latest recovery checkpoint.
- Last 5–10 messages verbatim.
- Current plan/native state.
- Relevant configuration.
- Identity context.
- An internal search tool for older records.

The exact message count should be token-budget based rather than literally fixed.

## Recovery policy

I would define something like:

```ts
recovery: {
  missingProviderSession: "reconstruct",

  checkpoint: {
    runtime: checkpointRuntime,
    updateAfterRecords: 50,
    maxTailTokens: 20_000,
  },

  context: {
    targetTokens: 60_000,
    recentMessages: 10,
    includeIdentity: true,
    enableSearch: true,
  },
}
```

The initial version does not need every option, but the separation is useful:

- Policy decides whether recovery is permitted.
- Checkpoint runtime produces semantic continuation.
- Context assembler combines checkpoint, tail, identity, and deterministic state.
- Adapter creates and seeds the replacement thread.

## Progress API

Yes, recovery and checkpoint generation need progress reporting. They may involve several provider operations and take substantial time.

A discriminated event union would be clearer than percentages alone:

```ts
type RecoveryProgress =
  | { stage: "loading_identity" }
  | { stage: "loading_checkpoint" }
  | {
      stage: "reading_records";
      processed: number;
      total?: number;
    }
  | {
      stage: "building_checkpoint";
      processedChunks: number;
      totalChunks?: number;
    }
  | { stage: "creating_provider_session" }
  | { stage: "seeding_provider_session" }
  | { stage: "restoring_configuration" }
  | { stage: "committing_recovery" }
  | {
      stage: "completed";
      internalSessionId: string;
      reconstructed: boolean;
    };
```

Usage:

```ts
const opened = await agent.conversations.open(conversationId, {
  onProgress(event) {
    renderRecoveryProgress(event);
  },
});
```

We should only expose a percentage when the denominator is genuinely known:

```ts
{
  stage: "building_checkpoint",
  processedChunks: 3,
  totalChunks: 8,
  percentage: 37.5,
}
```

For indefinite provider operations:

```ts
{
  stage: "seeding_provider_session"
}
```

This progress vocabulary can later be reused for:

- Agent opening.
- Checkpoint generation.
- Recovery.
- Handoff.
- Switch.
- Identity synchronization.
- Database migration.
- External audit/metering delivery.

Callback errors should not fail the underlying operation.

## Proposed implementation direction

I would proceed with this model:

1. Make conversation checkpoint content opaque rather than enforcing semantic fields.
2. Define a pluggable checkpoint runtime.
3. Implement incremental checkpointing from previous checkpoint plus new records.
4. Add a configurable disposable summarizer adapter.
5. Define recovery progress events.
6. On missing provider session, combine:

   - Identity.
   - Checkpoint.
   - Unprocessed tail.
   - Recent verbatim messages.
   - Deterministic plan/configuration state.

7. Create and privately seed a replacement provider session.
8. Atomically activate it in SQLite.
9. Later add adapter-specific compaction and provider-native recovery optimizations.

This avoids trying to understand conversations with deterministic code, avoids dependence on Codex’s private JSONL format, and remains viable when conversations grow beyond a single context window.



Agreed. Checkpoint generation should be background work. A normal prompt should wait only for:

1. Provider response.
2. Canonical conversation persistence.
3. A small durable enqueue operation.

It should not wait for the summarization inference.

```text
provider response
→ persist response
→ enqueue checkpoint job in SQLite
→ return prompt result
                \
                 background worker performs checkpoint
```

The SQLite enqueue is important. If checkpoint scheduling exists only in memory, closing the process immediately after the first response could lose the scheduled work. A durable `internal_inferences` table solves this.

## Internal inference model

`internal_inferences` should represent library-initiated AI operations:

```sql
internal_inferences
- internal_inference_id
- agent_session_id
- agent_conversation_id       nullable
- purpose
- status
- adapter_id
- model
- internal_session_id         nullable
- source_checkpoint_id        nullable
- source_from_sequence
- source_through_sequence
- requested_at
- started_at                  nullable
- completed_at                nullable
- attempt_count
- next_attempt_at             nullable
- output_json                 nullable
- error                       nullable
- metering_operation_id       nullable
- metadata                    nullable
```

Purposes could initially be:

```ts
type InternalInferencePurpose =
  | "conversation_checkpoint"
  | "conversation_recovery"
  | "identity_update";
```

Statuses:

```ts
type InternalInferenceStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
```

A checkpoint row then refers to the inference that produced it:

```text
conversation_checkpoints
- checkpoint_id
- agent_conversation_id
- revision
- covered_sequence
- continuation
- generator_inference_id → internal_inferences
- created_at
```

A corresponding `native_action` in `conversation_records` can also reference it:

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

This gives us several useful views:

- `internal_inferences`: operational AI jobs.
- `conversation_checkpoints`: successful recovery projections.
- `conversation_records`: chronological explanation that checkpointing occurred.
- `metering_records`: usage and cost of the internal inference.

I would use an ID prefix such as `aii-*` for internal inference operations.

## Do not duplicate the summary unnecessarily

The checkpoint’s `continuation` should be authoritative. `internal_inferences.output_json` does not need to duplicate the complete summary.

It can contain operational output:

```json
{
  "checkpointId": "chk-...",
  "outputMessages": 1,
  "stopReason": "end_turn"
}
```

Then:

```text
internal_inference
    └── produced checkpoint chk-...

checkpoint chk-...
    └── contains continuation text
```

The input also does not need to duplicate all conversation records. Store the input boundary:

```text
source_checkpoint_id
source_from_sequence
source_through_sequence
```

The prompt can be reconstructed from the referenced checkpoint and canonical conversation records.

## Background execution

After a response is committed:

1. Count completed assistant turns.
2. Calculate the uncheckpointed record/token tail.
3. Determine whether policy requires a checkpoint.
4. Insert a queued `internal_inference`.
5. Return the prompt result.
6. A background worker claims the job.
7. It creates a disposable `AgentController`.
8. It runs `session/new`.
9. It sends the checkpoint prompt.
10. It captures the aggregated response.
11. It persists the new checkpoint.
12. It marks the inference completed.

The enqueue operation is cheap and can be part of prompt persistence without creating noticeable user-facing latency.

## Coalescing

There should be at most one queued/running checkpoint inference per conversation.

Suppose turn 5 schedules a checkpoint and it is still running when turn 10 completes. We should not queue a second job using the same old checkpoint.

Instead:

```text
checkpoint job currently running through sequence 40
new records now reach sequence 75
→ mark checkpoint work requested through sequence 75
→ when current job completes, schedule/continue through 75
```

Possible columns:

```text
source_through_sequence
requested_through_sequence
```

Or simpler: after every completion, the coordinator reevaluates the latest checkpoint and current conversation high-water mark.

A partial unique index can enforce one active job:

```sql
CREATE UNIQUE INDEX one_active_checkpoint_inference
ON internal_inferences(agent_conversation_id, purpose)
WHERE status IN ('queued', 'running')
  AND purpose = 'conversation_checkpoint';
```

## Process shutdown

`agent.close()` should not unexpectedly wait for a model call.

Default behavior:

```text
stop accepting new jobs
→ interrupt running disposable controllers
→ leave queued/incomplete jobs durable
→ close
```

The next `Agent.open()` examines:

- Queued internal inferences.
- Stale `running` jobs whose process no longer exists.
- Latest checkpoint.
- Current conversation high-water sequence.

It can return stale jobs to `queued` and continue them.

We can later offer an explicit drain option:

```ts
await agent.close({ internalWork: "drain" });
```

But ordinary close should be fast.

## Retry behavior

A background failure must not fail the completed user prompt.

Instead:

```text
internal inference → failed
conversation remains usable
previous checkpoint remains authoritative
failure appears through subscriptions
job may retry according to policy
```

For example:

```ts
internalInference: {
  retry: {
    attempts: 3,
    backoffMs: [1_000, 10_000, 60_000],
  },
}
```

After retries are exhausted, the job remains failed and observable. A later threshold or explicit request can schedule another attempt.

## Generic `Subscribable`

Yes. We already use this pattern in several objects, and each implementation should not reinvent listener storage, exception isolation, and unsubscribe behavior.

The minimal public interface could be:

```ts
export type Unsubscribe = () => void;

export type Listener<TEvent> = (event: TEvent) => void;

export interface Subscribable<TEvent> {
  subscribe(listener: Listener<TEvent>): Unsubscribe;
}
```

Then use a shared implementation internally:

```ts
class SubscriptionHub<TEvent> implements Subscribable<TEvent> {
  private readonly listeners = new Set<Listener<TEvent>>();

  subscribe(listener: Listener<TEvent>): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: TEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures do not affect the operation.
      }
    }
  }
}
```

Objects compose a hub rather than extending a base class:

```ts
class InternalInference implements Subscribable<InternalInferenceEvent> {
  private readonly subscriptions =
    new SubscriptionHub<InternalInferenceEvent>();

  subscribe(listener: Listener<InternalInferenceEvent>) {
    return this.subscriptions.subscribe(listener);
  }
}
```

Composition avoids forcing unrelated runtime objects into one inheritance hierarchy.

## Snapshot plus events

For long-running objects, subscription events alone are insufficient because the consumer may subscribe after work started.

A more useful shared contract is:

```ts
interface StatefulSubscribable<TSnapshot, TEvent>
  extends Subscribable<TEvent> {
  readonly snapshot: TSnapshot;
}
```

For an internal inference:

```ts
interface InternalInferenceSnapshot {
  id: InternalInferenceId;
  purpose: InternalInferencePurpose;
  status: InternalInferenceStatus;
  stage: InternalInferenceStage;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  progress?: {
    completed: number;
    total?: number;
    percentage?: number;
  };
  error?: string;
}
```

Consumer usage:

```ts
render(inference.snapshot);

const unsubscribe = inference.subscribe((event) => {
  render(event.snapshot);
});
```

This matches the existing `conversation.state` plus `conversation.subscribe(...)` pattern.

## Turns as subscribable operations

The prompt itself could benefit from an operation handle:

```ts
const turn = conversation.startPrompt("Review the repository");

turn.subscribe((event) => {
  switch (event.kind) {
    case "state_changed":
      renderBusyState(event.state);
      break;
    case "message":
      renderMessage(event.message);
      break;
    case "activity":
      renderActivity(event.activity);
      break;
    case "permission":
      renderPermission(event.request);
      break;
    case "metering":
      renderUsage(event.record);
      break;
    case "completed":
      renderResult(event.result);
      break;
  }
});

const result = await turn.result;
```

Where:

```ts
interface AgentTurn
  extends StatefulSubscribable<AgentTurnSnapshot, AgentTurnEvent> {
  readonly id: string;
  readonly result: Promise<AgentSessionPromptResult>;
  interrupt(): void;
}
```

The existing convenience API remains:

```ts
const result = await conversation.prompt("...");
```

Internally it could be:

```ts
async prompt(...) {
  return await this.startPrompt(...).result;
}
```

So consumers needing only a result see no added complexity, while UIs and orchestration systems receive a first-class operation object.

## Where checkpoint progress should appear

Checkpoint generation is not part of the user turn after it has been durably enqueued. Therefore it should not keep the turn in `isBusy`.

The sequence should be:

```text
turn completed
conversation.isBusy = false
checkpoint job queued/running independently
```

Progress can be observed through:

- The `InternalInference` object.
- Agent-level subscription events.
- Conversation-level events referencing the inference ID.

For example:

```ts
agent.subscribe((event) => {
  if (event.kind === "internal_inference_changed") {
    renderBackgroundWork(event.inference);
  }
});
```

And optionally:

```ts
conversation.subscribe((event) => {
  if (event.kind === "checkpoint_changed") {
    renderCheckpointState(event.checkpoint);
  }
});
```

This lets the UI show “Updating recovery checkpoint…” without presenting the conversation itself as busy.

## Proposed shared hierarchy

```text
Subscribable<TEvent>
├── Agent
├── AgentConversation
├── AgentTurn
├── InternalInference
└── future long-running operations

StatefulSubscribable<TSnapshot, TEvent>
├── AgentConversation
├── AgentTurn
└── InternalInference
```

The reusable pieces should be:

- Public `Subscribable` and `StatefulSubscribable` interfaces.
- Public listener/unsubscribe types.
- Internal `SubscriptionHub`.
- Consistent event envelopes and snapshots.
- Listener failures isolated from operation execution.

This gives us a general observation model rather than adding another one-off callback specifically for recovery.




# Next step: 

Yes. `InternalInferenceRuntime` should come first because both recovery checkpoints and the future concrete identity implementation depend on it.

Recommended implementation order:

1. Generic subscriptions

   Define:

   ```ts
   Subscribable<TEvent>
   StatefulSubscribable<TSnapshot, TEvent>
   Listener<TEvent>
   Unsubscribe
   SubscriptionHub<TEvent>
   ```

   Then use these in the internal inference implementation. Refactoring every existing subscription immediately is unnecessary; migrate them incrementally.

2. Internal-inference contracts

   Define:

   ```ts
   InternalInferenceId
   InternalInferencePurpose
   InternalInferenceStatus
   InternalInferenceRequest
   InternalInferenceResult
   InternalInferenceSnapshot
   InternalInferenceEvent
   InternalInferenceRuntime
   ```

3. SQLite persistence

   Add `internal_inferences` with:

   - Durable queued/running/completed/failed state.
   - Purpose and conversation association.
   - Source sequence boundaries.
   - Adapter/model/provider-session information.
   - Attempts and errors.
   - Metering linkage.
   - Optional result metadata.

4. Harness-backed runtime

   Implement the default runtime using an isolated `AgentController`:

   ```text
   initialize
   → session/new
   → session/prompt
   → collect response
   → stop
   ```

   It should reuse an adapter registration but never the live conversation controller.

5. Background coordinator

   Agent-owned service that:

   - Enqueues work durably.
   - Claims queued jobs.
   - Limits concurrency.
   - Recovers stale `running` jobs.
   - Supports cancellation and retry.
   - Does not keep `conversation.isBusy` true.
   - Stops promptly when `agent.close()` is called.

6. Internal inference metering

   Persist its usage without replacing the active conversation provider baseline.

7. Tests

   Verify:

   - A prompt can return while internal work continues.
   - Durable jobs survive agent reopening.
   - Separate provider sessions are used.
   - Authentication/config comes from the selected adapter.
   - Listener failures do not fail inference.
   - Duplicate claims do not execute twice.
   - Failed jobs retain errors and can retry.
   - Usage is persisted and attributed correctly.
   - Agent close does not wait indefinitely.

Only after that should we build checkpoint generation:

```text
checkpoint policy
→ enqueue InternalInference
→ produce summary
→ publish conversation checkpoint
```

That order prevents checkpointing from embedding its own bespoke subprocess, queue, subscription, persistence, and metering implementation.






It is close, but I would revise several points before implementation. There are a few real inconsistencies that would otherwise become schema constraints we regret.

## 1. Attempts need their own table

The largest issue is retry history.

The spec says:

- An inference keeps the same `internalInferenceId` across retries.
- Every attempt may have a different `internalSessionId`.
- Every token-consuming attempt must be metered.

But `internal_inferences` currently has only:

```text
internal_session_id
attempt_count
metering_operation_id
error
```

A retry would overwrite the previous attempt’s provider session, error, and metering relationship.

It should be split:

```text
internal_inferences
- internal_inference_id
- purpose
- status
- adapter_id
- agent_session_id
- agent_conversation_id
- input_json / source references
- requested_at
- completed_at
- next_attempt_at
- result_json
- error
- revision
```

```text
internal_inference_attempts
- internal_inference_attempt_id
- internal_inference_id
- attempt_number
- worker_id
- internal_session_id
- model
- status
- started_at
- completed_at
- lease_expires_at
- metering_operation_id
- error
- metadata
```

This preserves every paid failed attempt instead of overwriting it.

## 2. Multi-process claiming cannot remain deferred

The library’s use case includes multiple concurrent ACP processes and potentially multiple processes opening the same agent database.

The spec currently says only one coordinator may execute internal work until leases are added. That is too weak for the intended architecture.

Leases should be part of the initial implementation:

```text
worker_id
lease_expires_at
heartbeat_at
```

Claiming should atomically:

1. Find an eligible queued job.
2. Create an attempt.
3. Set the inference to `running`.
4. Assign a worker and lease expiration.

A worker may mutate the job only while holding its lease. Another worker can reclaim it after expiration.

That gives us safe behavior when two orchestrator processes open the same agent SQLite database.

## 3. Recovery needs awaitable internal inference

Checkpoint generation is always background, but `conversation_recovery` is not. Opening a conversation may need to wait for reconstruction before returning a usable conversation.

Therefore internal inference itself should not be defined as inherently background.

Better model:

```ts
const inference = await agent.internalInferences.enqueue(request);
```

`enqueue()` returns quickly with a handle:

```ts
interface InternalInference
  extends StatefulSubscribable<InternalInferenceSnapshot, InternalInferenceEvent> {
  readonly id: InternalInferenceId;
  readonly result: Promise<InternalInferenceResult>;
  cancel(): Promise<void>;
}
```

Then:

```ts
// Checkpoint coordinator:
enqueue(request); // does not await result

// Recovery:
const inference = await enqueue(request);
const result = await inference.result;
```

The infrastructure is durable and asynchronous; each caller decides whether its workflow must await completion.

## 4. Durable input is underspecified

The runtime request contains:

```ts
prompt: string
```

But persistence deliberately does not store the prompt. After process termination, how does another worker reconstruct the same request?

For checkpoint work, source boundaries may be enough, but only if the purpose-specific prompt builder is stable and identifiable.

The durable row needs an input descriptor:

```ts
interface InternalInferenceInput {
  readonly version: 1;
  readonly strategyId: string;
  readonly source?: {
    checkpointId?: string;
    fromSequence?: number;
    throughSequence?: number;
  };
  readonly instructions?: string;
  readonly metadata?: PersistenceJsonValue;
}
```

The worker converts that descriptor into the ephemeral provider prompt.

We should not persist a giant rendered prompt by default, but must persist enough information to reproduce it deterministically.

The inference should also record the prompt-builder version. Otherwise a queued job created under one library version may silently execute with different instructions after an upgrade.

## 5. Metering needs a concrete detached-operation rule

The spec correctly says disposable inference must not replace the visible conversation baseline, but leaves the actual solution unresolved.

That must be decided before implementation.

I recommend extending the metering engine with a detached operation:

```ts
metering.accrueDetachedOperation({
  operationId,
  operationKind: "conversation_checkpoint",
  internalSessionId: disposableSessionId,
  usage,
  provider,
});
```

Its result should:

- Add usage and cost to lifetime totals.
- Increment operation counts.
- Preserve the visible conversation’s `activeBaseline`.
- Mark the disposable thread as a newly created zero-baseline thread.
- Produce a normal immutable `OperationMeteringRecord`.

Conceptually:

```ts
nextState = {
  ...accumulatedTotals,
  activeBaseline: previousVisibleConversationBaseline,
};
```

Without this operation, implementing metering risks corrupting subsequent cumulative-delta attribution.

## 6. Completion must be one transaction

For checkpoint generation, completion involves several writes:

```text
metering record/state
+ conversation checkpoint
+ native_action record
+ internal inference completed
+ attempt completed
```

The spec says persistence must precede completed status, but these should be one SQLite transaction.

Otherwise a crash can leave states such as:

```text
checkpoint exists
internal inference still running
```

or:

```text
inference completed
checkpoint missing
```

The purpose-specific completion handler should execute through a transaction:

```ts
persistence.transaction(async (tx) => {
  await tx.metering.commit(...);
  await tx.checkpoints.publish(...);
  await tx.records.append(...);
  await tx.internalInferences.complete(...);
});
```

The runtime produces a result; the purpose-specific coordinator validates and commits it atomically.

## 7. Job coalescing needs clearer semantics

Updating `requestedThroughSequence` on a running inference is useful, but the running model call cannot incorporate records that arrived after its input was built.

The rule should be:

- `sourceThroughSequence`: immutable boundary for the current attempt.
- `requestedThroughSequence`: latest requested high-water mark.
- On successful completion, publish only through `sourceThroughSequence`.
- If `requestedThroughSequence > sourceThroughSequence`, enqueue or retain another job using the newly published checkpoint.

Never claim that one summary covers records added while generation was running.

## 8. Shutdown requires a bounded cleanup wait

“Do not wait for model completion” is correct, but the agent cannot close SQLite immediately while workers are still attempting to persist cancellation.

Shutdown should be:

```text
stop claims
→ abort controllers
→ wait briefly for workers to acknowledge abort and release/requeue leases
→ force-stop remaining controllers
→ expire/release owned leases transactionally
→ close SQLite
```

So `close()` does await cleanup, but not inference completion.

A configurable shutdown grace period is appropriate:

```ts
internalInference: {
  shutdownGraceMs: 2_000,
}
```

## 9. Public coordinator API is missing

Consumers and recovery logic need a way to access durable work:

```ts
agent.internalInferences.enqueue(...)
agent.internalInferences.get(id)
agent.internalInferences.list(...)
agent.internalInferences.cancel(id)
agent.internalInferences.subscribe(...)
```

`get()` must return a live/durable handle even after reopening. Its `result` resolves immediately when already completed and rejects appropriately when failed or cancelled.

Without this manager API, the handle model exists only conceptually.

## 10. Authentication/runtime configuration needs resolution

“Reuse the adapter definition” is correct, but conversations can also have runtime configuration not stored in the adapter:

- Launcher.
- Spawn environment.
- Working directory.
- Client information.
- Logger/wire settings.
- Possibly adapter-specific defaults.

We need to define which values internal inference inherits:

```text
Agent internal-inference defaults
→ conversation-relevant adapter selection
→ purpose-specific safe restrictions
```

It should not blindly inherit the conversation’s MCP servers, tools, permissions, or client capabilities.

## 11. Progress snapshots need a sequence

Asynchronous events can arrive near durable state transitions. Add a monotonically increasing revision:

```ts
interface InternalInferenceSnapshot {
  readonly revision: number;
  // ...
}
```

Consumers can then ignore stale events:

```ts
if (event.snapshot.revision <= current.revision) return;
```

Attempt-local progress may also need:

```ts
attemptNumber
```

## 12. Record retention needs one early decision

The spec defers retention of completed internal inference rows. That is acceptable, but deleting them could break foreign references from:

- Checkpoints.
- Native actions.
- Metering records.

Initial policy should simply be:

> Internal inference and attempt rows are retained indefinitely in schema version 1.

Retention can later archive payloads while preserving identity rows.

## What is already solid

The following parts are ready:

- `Subscribable` and `StatefulSubscribable`.
- Composition through `SubscriptionHub`.
- Listener-error isolation.
- Separate isolated `AgentController`.
- No reuse of the live conversation thread.
- Restricted tools and capabilities.
- Durable queuing.
- Background checkpoint behavior.
- Agent-level concurrency limits.
- Purpose-based inference.
- Progress stages without fake percentages.
- Conversation `isBusy` remaining independent.
- Purpose-specific artifacts referencing internal inference IDs.
- No automatic identity update from internal inference output.

## Recommendation

I would revise the spec before coding with these mandatory changes:

1. Split inference and attempt persistence.
2. Include leases in the initial implementation.
3. Make handles awaitable while keeping checkpoint callers background.
4. Persist a reproducible input descriptor.
5. Define detached-operation metering.
6. Require atomic purpose-specific completion.
7. Tighten coalescing boundaries.
8. Add the public manager API.
9. Add snapshot revisions.
10. Retain rows indefinitely initially.

After those changes, I would consider it ready to implement. The overall architecture is good; these are mostly places where durability, retries, and concurrent processes expose constraints that an in-memory design would not reveal.

---

1. I don't get your rationale for a different table. Two attempts at inference would just generate two records with a different id.. Having an attempts talbe means having one extra record per operation just because ? 
2. ok i guess
3. ok
4. I didnt get this
5. im not sure about this, like how does it currently work ? 
6. ok
7. ok
8. ok
9. ok
10. we can't disable fs and terminal. The harness only annouces that. And we should probably inherit and settings of the environment of the agc we are making the call for, because if it is in a docker container for example then we would not have the auth (and it's also kind bad in terms of ssecurity just start ing the process elsewhere). 
But on the fs and terminal usage... can't we start the process in a way that it can't edit anything ? im not sure if thats possible
11. ok
12. But wouldnt remove retention of normal prompts also break metering records ? the data would not break, it would just start later wouldnt it ? 




## 1. Separate attempts table

Your model is simpler and valid:

> One `internal_inferences` row represents one actual inference attempt.

A retry creates another inference:

```text
aii-001  failed
aii-002  completed, retry of aii-001
```

That avoids an additional attempt row for every operation.

We only need enough lineage to connect retries:

```text
internal_inference_id
retry_of_internal_inference_id   nullable
root_internal_inference_id
attempt_number
```

For example:

```text
aii-001
  root = aii-001
  retryOf = null
  attempt = 1
  status = failed

aii-002
  root = aii-001
  retryOf = aii-001
  attempt = 2
  status = completed
```

Each row has its own:

- Provider session.
- Metering record.
- Error.
- Timing.
- Lease.
- Progress.
- Output.

That maps better to the metering principle of one immutable record per real operation.

So I agree: we should not add `internal_inference_attempts`. Instead, redefine retries as new internal inference records linked through lineage.

The checkpoint job can track the retry chain’s root ID, while the produced checkpoint references the successful inference ID.

## 4. Durable input descriptor

The problem is this sequence:

```text
1. Turn completes.
2. We insert queued internal inference aii-123.
3. Process exits.
4. Another process opens the database.
5. It finds aii-123 queued.
6. What prompt should it send?
```

If the prompt exists only in memory, step 6 is impossible.

I am not proposing that we store the entire rendered prompt. Instead, persist enough instructions to rebuild it:

```json
{
  "version": 1,
  "strategyId": "conversation-checkpoint-v1",
  "previousCheckpointId": "chk-4",
  "fromSequence": 81,
  "throughSequence": 135
}
```

On reopening:

```text
load checkpoint chk-4
load conversation records 81–135
load strategy conversation-checkpoint-v1
render the summarization prompt
run inference
```

This is the durable input descriptor.

For identity work it might instead be:

```json
{
  "version": 1,
  "strategyId": "identity-update-v1",
  "fromIdentitySequence": 51,
  "throughIdentitySequence": 90
}
```

The important part is that a queued inference must be reproducible after process restart.

We should not store:

- Authentication secrets.
- Environment variables.
- Huge copies of conversation records.
- The fully rendered prompt unless diagnostic policy explicitly enables it.

## 5. How metering currently works

Each live `AgentConversation` has one `MeteringEngine`.

That engine maintains:

```ts
{
  lifetimeTotals,
  operationCounts,
  activeBaseline
}
```

The active baseline corresponds to the visible provider thread:

```text
conversation agc-1
  active provider session: codex-session-A
  active baseline: counters last observed for codex-session-A
```

For an ordinary prompt:

```text
provider reports cumulative total 300
active baseline was 200
operation usage = 100
new baseline = 300
```

During handoff/switch, the conversation deliberately replaces its active provider thread. The metering engine carries the lifetime totals forward and establishes the new thread’s baseline.

An internal inference is different:

```text
visible conversation session: codex-session-A
disposable summary session:   codex-session-B
```

If we treat `codex-session-B` as a normal thread replacement, the conversation state becomes:

```text
active baseline = codex-session-B
```

That is wrong. The next visible prompt occurs on `codex-session-A`.

Therefore internal inference must be metered without changing the visible active baseline.

One possible operation is:

```ts
conversationMetering.accrueDetached({
  operationId,
  internalSessionId: disposableSessionId,
  usage,
  provider,
});
```

It would:

- Produce a normal metering record.
- Add the inference’s tokens/costs to lifetime totals.
- Increment operation counts.
- Leave `activeBaseline` unchanged.

Because a disposable session is created with `session/new`, it begins from a trusted zero baseline. Its first cumulative usage report can be attributed completely:

```text
disposable session begins at 0
summary prompt reports 8,000
detached operation usage = 8,000
```

Alternatively, internal inference could maintain entirely separate totals. But then asking “what did this conversation cost?” would omit the checkpoint and recovery work it caused.

My recommendation is:

```text
conversation lifetime total
  = visible conversation operations
  + internal operations caused by that conversation

visible active baseline
  = only the visible provider thread
```

Agent-level identity inference without a conversation can be attributed to an agent-level internal metering scope instead.

## 10. Environment, authentication, filesystem, and terminal

You are right. ACP client capabilities do not sandbox the harness.

Not advertising filesystem or terminal capabilities only means:

> The ACP client does not provide those capabilities to the harness.

It does not prevent a Codex or Claude Code subprocess from using its own built-in filesystem and terminal tools.

The internal inference should inherit the execution environment of its source conversation:

- Adapter.
- Launcher.
- Spawn environment.
- Container boundary.
- User/home configuration.
- Working directory.
- Authentication environment.
- Relevant network boundary.

Otherwise we could accidentally:

- Start outside the intended container.
- Lose authentication.
- Read a different workspace.
- Bypass consumer isolation.
- Use different provider configuration.

So the rule should be:

> Use a separate provider session and controller, but the same execution profile and security boundary as the source conversation.

We should introduce an execution profile abstraction or snapshot:

```ts
interface InternalInferenceExecutionProfile {
  adapterId: string;
  launcher: Launcher;
  cwd?: string;
  environmentProfileId?: string;
}
```

We should not persist raw environment variables because they may contain secrets. After reopening, the stored adapter/profile ID resolves against the configuration supplied to `Agent.open()`.

### Can we prevent filesystem changes?

Not reliably from inside ACP.

Possible real isolation mechanisms include:

- Running the harness in a container with a read-only workspace mount.
- Linux namespaces.
- `bubblewrap`.
- A consumer-provided sandbox launcher.
- A temporary copied workspace.
- Filesystem permissions enforced by the OS.
- Running as a restricted user.
- Seccomp/AppArmor where applicable.

Simply setting the working directory read-only is insufficient if the process can access parent directories or other writable paths.

The library should not silently invent a new sandbox, especially because doing so could change authentication and container placement.

The useful default is:

- Reuse the conversation execution boundary.
- Cancel client-mediated permission requests.
- Do not supply MCP servers or additional client tools unless configured.
- Prompt the model not to use tools.
- Clearly state that this is behavioral restriction, not an OS security boundary.
- Allow a consumer-provided `internalInferenceLauncher` if stronger isolation is desired.

## 12. Retention and references

Yes—removing detailed history does not inherently break metering state.

Metering has two layers:

```text
immutable metering records
bounded cumulative state
```

If old metering records are deleted but cumulative state remains:

```text
totals still include old usage
active baseline still permits correct next delta
detailed history begins at the retained boundary
```

So it does not “start accounting later.” It loses detailed historical explanation, but the cumulative totals remain continuous.

Similarly, deleting normal prompt records does not mechanically invalidate metering records if the association is a logical `operationId` rather than a strict foreign key.

For internal inference retention, we should apply the same principle:

- Purpose-specific artifacts such as checkpoints retain the successful inference ID as provenance.
- We should avoid restrictive foreign keys that make retention impossible.
- Old inference details may be compacted.
- A minimal tombstone can remain if provenance is important.

For example:

```text
internal inference row after compaction
- id
- purpose
- status
- adapter
- completed_at
- metering_operation_id
- result artifact id
```

While removing:

- Intermediate progress.
- Error details from superseded retries.
- Diagnostic metadata.
- Provider session details if no longer needed.

A checkpoint remains valid because its continuation text is independently stored. The inference row explains how it was produced but is not required to read it.

## Revised decisions

I would adjust the spec as follows:

1. One `internal_inferences` row per actual attempt.
2. Retries create new IDs linked with `retryOf` and `rootInferenceId`.
3. Add leases in the first implementation.
4. Persist a structured, reproducible input descriptor.
5. Support both background and awaited consumers through an inference handle.
6. Add detached metering that preserves the visible baseline.
7. Complete artifacts, metering, and inference status atomically.
8. Inherit the source conversation’s execution/security profile.
9. Do not claim ACP capability flags sandbox the harness.
10. Permit future retention/compaction without making artifacts depend on inference rows.

With those revisions, the design is internally consistent and ready to turn into implementation slices.



Metering records are not a linked list that must remain intact to calculate the next state.

Each operation produces:

```text
OperationMeteringRecord
  └── nextState
```

But SQLite separately stores the latest bounded state:

```text
conversation_metering_state
  └── current aggregate totals + active baseline
```

After operation 3:

```text
record 1 → state after 1
record 2 → state after 2
record 3 → state after 3

conversation_metering_state → state after 3
```

If records 1 and 2 are removed:

```text
record 3 → state after 3

conversation_metering_state → state after 3
```

Future accounting still works because it restores from `conversation_metering_state`, not by replaying every old metering record.

What is lost is the detailed explanation of operations 1 and 2.

## Cascading from internal inference

I would not cascade-delete metering when an internal inference is removed.

The dependencies have different retention requirements:

```text
internal inference ──correlates with── metering record
```

The inference is operational history. The metering record may be financial/audit history. Deleting operational details should not silently delete accounting information.

Instead, use a stable correlation value:

```text
metering_records.internal_inference_id = "aii-..."
```

It does not necessarily need a restrictive foreign key. Or the foreign key can use `ON DELETE SET NULL`, although that loses the ID unless it is duplicated elsewhere.

A plain immutable correlation ID is probably best:

```text
metering record:
  operationId
  internalInferenceId
```

The ID remains meaningful even if the detailed inference row is later removed.

## Checkpoints and inference records

Likewise, deleting an inference should not delete the checkpoint it produced:

```text
checkpoint
- continuation
- covered_sequence
- generator_internal_inference_id
```

The checkpoint is the useful artifact. The inference is provenance.

Possible retention behavior:

```text
delete/compact inference diagnostics
keep checkpoint
keep generatorInternalInferenceId as an opaque historical ID
```

No cascade is needed.

## Where cascade does make sense

If a conversation is physically purged, the consumer may choose to cascade its local operational data:

```text
conversation
├── conversation records
├── checkpoints
├── internal inferences
├── local metering records
└── metering state
```

But even then, authoritative billing data may live elsewhere and must not be deleted merely because a chat was erased.

The current conversation API primarily soft-deletes conversations, so physical cascade is a separate purge policy.

## One retention complication: idempotency markers

Even when `meteringRecords: "none"`, we currently retain a minimal row containing the operation ID. That prevents the same operation from advancing metering state twice.

If we remove old metering rows completely, we also remove those idempotency markers:

```text
operation op-123 committed
→ marker later deleted
→ duplicate op-123 arrives
→ system can no longer recognize it
```

Therefore retention should distinguish:

```text
full metering record       removable/archivable
minimal operation marker   retained longer
bounded current state      always retained
```

The `record_json` can be cleared while keeping:

```text
agent_conversation_id
operation_id
completed_at
```

This is already how `meteringRecords: "none"` behaves.

So the recommended model is:

- Metering records are not chained.
- Current metering state is independently sufficient for continuation.
- Full historical payloads can be removed.
- Minimal operation IDs should remain for idempotency.
- Deleting an internal inference should not cascade into metering or checkpoints.
- Physically deleting an entire conversation can use an explicit purge policy, not incidental cascades.





## InternalRuntime

It is close, but I would not implement the coordinator yet. The persistence primitives and subscription hub are ready; several runtime semantics still need tightening.

The important issues are:

1. Enqueue should be atomic with the conversation commit

The current ordering commits conversation records and then enqueues internal work separately ([spec:305](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:305)).

That creates a crash window where the response exists but its checkpoint job does not. For automatically triggered work in the same SQLite database, the turn records and inference enqueue should be one transaction. Explicit/manual enqueue can remain independent.

2. “Requeues stale work” contradicts the retry model

The coordinator list says it requeues stale running work ([spec:330](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:330)), but the detailed design correctly says the old attempt becomes terminal and a new linked row is created.

The list should say “recovers stale work through linked retries.”

3. Shutdown has an impossible edge

The spec says persistence may close when the grace period expires, but also says it must never close while a worker might publish cancellation ([spec:414](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:414)).

We need one exact rule:

- After the grace period, detach/fence the worker locally.
- Invalidate or expire its lease transactionally.
- Prevent all further writes from that runtime.
- Then close persistence.

Stopping the subprocess is not enough; late promise continuations also need to be fenced.

4. User cancellation and recoverable interruption need separate meanings

Currently everything ends as `cancelled`, `failed`, or a retry. We should distinguish:

- User cancellation: terminal, never retry.
- Agent shutdown: interrupted/abandoned and eligible for retry.
- Lease expiration: abandoned and eligible for retry.
- Runtime abort caused by timeout: retry according to policy.

This could use failure codes rather than another public status, but it must be explicit.

5. Durable input currently has two sources of truth

Checkpoint boundaries appear both in `input_json` and in dedicated columns such as `source_through_sequence` ([spec:251](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:251)).

I would use:

- `input_json` for the immutable input descriptor.
- Dedicated columns only for values needed by indexing/coalescing.
- Explicitly declare those columns indexed projections of `input_json`, updated atomically.

Alternatively, remove the duplicates.

6. The descriptor is checkpoint-shaped but the runtime is generic

`InternalInferenceInputDescriptor` directly contains checkpoint fields ([spec:131](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:131)). Identity updates and other future strategies will need different inputs.

It should be a durable envelope:

```ts
interface InternalInferenceInputDescriptor {
  version: number;
  strategyId: string;
  payload: JsonValue;
}
```

Each registered strategy validates its own versioned payload.

7. Strategy and completion-handler registration are undefined

The spec says the coordinator resolves a strategy and the purpose handler validates/publishes the result, but there is no contract for either.

Before implementation, define one internal registration shape containing:

```ts
interface InternalInferenceStrategy {
  purpose: InternalInferencePurpose;
  strategyId: string;
  renderInput(...): Promise<InternalInferenceRequest>;
  complete(...): Promise<InternalInferenceCompletion>;
  classifyError(...): RetryDisposition;
}
```

The exact names can change, but ownership must be explicit.

8. Retry-chain observation remains ambiguous

An attempt handle rejects when that attempt fails, while a possible retry-chain handle follows later attempts ([spec:391](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:391)). The latter is still deferred.

That affects recovery immediately: if recovery awaits `.result`, does a transient first-attempt failure reject the recovery even though a retry was scheduled?

I recommend defining two things now:

- `InternalInference`: one attempt.
- `InternalInferenceRun`: virtual retry chain whose `result` follows retries.

No additional table is necessary.

9. Adapter `"same"` needs snapshot timing

“The active adapter” could mean at enqueue time or execution time ([spec:229](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:229)). If a conversation switches adapters while work is queued, results become nondeterministic.

Resolve `"same"` at enqueue and persist the concrete `adapterId` and execution profile ID.

10. Metering failure paths need the same atomicity rule

Successful completion is atomic, but failed attempts can also report usage. Persisting:

- failure status,
- usage record,
- cumulative totals,
- retry-row creation

should be one transaction. Otherwise a crash can double-count or lose failed-attempt usage.

11. Lease timing needs concrete defaults and fencing rules

Before coding claims, define:

- Lease duration.
- Heartbeat interval.
- Clock source/format.
- Required conditional predicates for heartbeat and completion.
- Whether a lease can be reclaimed after clock movement.
- A unique `worker_id` scope.

SQLite wall-clock timestamps are sufficient, but all lease mutations should compare `worker_id`, revision, and the expected lease generation. A generation/token is safer than `worker_id` alone.

12. Coalescing requires a database invariant

“At most one active checkpoint chain” ([spec:351](/home/ffacu/q/apps/libs/acp-lib/.res/somelogs.md/9-16+/9-17-SPEC-internalInference.md:351)) cannot be enforced only in coordinator memory when multiple processes exist.

It needs either:

- A partial unique SQLite index for active checkpoint roots per conversation, or
- A separate coordination row updated transactionally.

My preference is a small coordination row because retries and “requested through sequence” conceptually belong to the chain, not one attempt.

So: slices 1 and the basic repository model are implementable. Before implementing scheduling, recovery, and harness execution, I would make one more spec pass resolving these twelve points. The biggest architectural decision is whether a retry chain gets a tiny durable coordination row. That may be justified even though individual attempts still correctly remain one row each.


Yes. I would make internal inference the first properly feature-organized subsystem instead of adding more root files.

The current sizes confirm the problem:

- `agent-session.ts`: 3,902 lines
- `sqlite-backend.ts`: 1,551 lines
- `persistence/backend.ts`: 603 lines
- `agent.ts`: 586 lines
- `index.ts`: 653 lines

## Proposed organization

```text
src/
  internal-inference/
    index.ts
    contracts.ts
    config.ts
    errors.ts

    observation/
      contracts.ts
      subscription-hub.ts

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
```

Later, checkpointing would be a separate consumer:

```text
src/
  checkpointing/
    index.ts
    config.ts
    schedule.ts
    strategy.ts
    prompt.ts
    artifact.ts
    recovery.ts
```

Identity inference would similarly live under `identity/`, rather than inside the generic inference runtime.

## Responsibilities

`contracts.ts`

Only public value types:

- IDs
- statuses and stages
- snapshots and events
- input descriptor envelope
- runtime result
- durable completion
- manager/handle interfaces

No database code and no controller imports where avoidable.

`runtime/harness-runtime.ts`

Only translates one normalized request into:

```text
controller → session/new → prompt → normalized result → cleanup
```

It does not know about retries, leases, checkpoint artifacts, or persistence.

`strategy/strategy.ts`

Defines the missing boundary from the review:

```ts
interface InternalInferenceStrategy<TPayload = JsonValue> {
  readonly id: string;
  readonly purpose: InternalInferencePurpose;
  readonly version: number;

  validatePayload(payload: JsonValue): TPayload;

  prepare(
    context: InternalInferencePreparationContext,
    payload: TPayload,
  ): Promise<PreparedInternalInference>;

  complete(
    context: InternalInferenceCompletionContext,
    result: InternalInferenceResult,
  ): Promise<InternalInferenceCompletion>;
}
```

The checkpoint strategy knows how to load messages and produce a checkpoint. The runtime does not.

`coordination/coordinator.ts`

Orchestrates the pieces, but should remain fairly small:

- Receive wake-ups.
- Ask claim loop for work.
- Resolve strategy and runtime.
- Start execution.
- Delegate result completion or failure.
- Publish events.

Lease SQL, retry calculation, shutdown mechanics, and handles remain outside it.

`coordination/claim-loop.ts`

Owns:

- Poll/wakeup behavior.
- Concurrency permits.
- Lease claiming.
- Heartbeats.
- Lease fencing.
- Expired-attempt recovery.

This isolates the most concurrency-sensitive code so it can be tested without starting a harness.

`attempt-handle.ts` and `run-handle.ts`

Keep the distinction explicit:

- Attempt handle observes one `aii-*` row.
- Run handle follows the virtual retry chain.

This prevents `manager.ts` from turning into a large mixture of promises, events, queries, and retry behavior.

`persistence/repository.ts`

A narrow interface dedicated to this subsystem. For example:

```ts
interface InternalInferenceRepository {
  enqueue(...): Promise<...>;
  claimNext(...): Promise<...>;
  heartbeat(...): Promise<boolean>;
  complete(...): Promise<...>;
  failAndScheduleRetry(...): Promise<...>;
  abandonAndScheduleRetry(...): Promise<...>;
  cancel(...): Promise<...>;
  getAttempt(...): Promise<...>;
  getRun(...): Promise<...>;
  list(...): Promise<...>;
}
```

The coordinator should not issue SQL or manipulate general `PersistenceBackend` records itself.

## Relationship with the existing persistence backend

I would not add another 30 methods directly to the already-large `PersistenceBackend`.

Instead, expose feature repositories:

```ts
interface PersistenceBackend {
  // existing API
  readonly internalInferences?: InternalInferenceRepository;
}
```

Or preferably, if we are willing to improve the shape slightly:

```ts
interface PersistenceBackend {
  readonly capabilities: PersistenceCapabilities;
  readonly conversations: ConversationPersistence;
  readonly metering: MeteringPersistence;
  readonly identity: IdentityPersistence;
  readonly internalInferences: InternalInferenceRepository;
}
```

The latter is cleaner, but it is a broader refactor. For this implementation, the optional feature repository is less disruptive.

The SQLite implementation should be composed:

```text
src/persistence/sqlite/
  connection.ts
  migrations.ts
  transaction.ts
  conversation-repository.ts
  metering-repository.ts
  identity-repository.ts
  internal-inference-repository.ts
```

However, moving the existing SQLite implementation immediately would create a large unrelated diff. I would:

1. Create the new internal-inference SQLite repository in its feature folder.
2. Give it the shared SQLite connection/transaction primitive.
3. Later split the existing monolithic backend as a dedicated refactor.

Crucially, inference SQL should not be added directly to the existing 1,551-line `sqlite-backend.ts`.

## Keeping `Agent` small

`Agent` should only wire the feature:

```ts
class Agent {
  readonly internalInferences: InternalInferenceManager;
}
```

Construction can be delegated:

```ts
const internalInference = createInternalInferenceSubsystem({
  agentId,
  persistence,
  adapters,
  config,
});
```

`Agent.open()` should not contain lease recovery or worker-loop logic. `Agent.close()` should call one subsystem method:

```ts
await this.internalInferences.close();
```

## File-size guideline

I would treat these as signals rather than rigid limits:

- Around 100–250 lines for contracts and focused utilities.
- Around 200–400 lines for a substantial runtime/repository.
- Split a file before it reaches roughly 500 lines.
- Tests organized by responsibility, not one huge integration test.

For example:

```text
test/internal-inference/
  subscription-hub.test.ts
  sqlite-repository.test.ts
  leases.test.ts
  retries.test.ts
  handles.test.ts
  harness-runtime.test.ts
  coordinator.test.ts
  shutdown.test.ts
  metering.test.ts
  checkpoint-integration.test.ts
```

## One adjustment I recommend

The generic `Subscribable` abstraction should not live inside `internal-inference/`, because conversations and turns will use it too:

```text
src/observation/
  contracts.ts
  subscription-hub.ts
```

Internal inference would import it. That prevents a generic primitive from appearing owned by one feature.

So the broad structure becomes:

```text
src/
  observation/
  internal-inference/
  checkpointing/
  identity/
  metering/
  persistence/
```

This gives us vertical feature ownership without hiding reusable infrastructure inside a feature. It also gives us a good pattern for gradually breaking apart `agent-session.ts` and `sqlite-backend.ts` later, without requiring that whole refactor before internal inference can be implemented.










`agent.internalInferences.list(...)` lets the consumer inspect persisted internal-inference attempts without already knowing their IDs.

For example:

```ts
const page = await agent.internalInferences?.list({
  status: "failed",
  purpose: "conversation_checkpoint",
  limit: 50,
});

for (const attempt of page?.attempts ?? []) {
  console.log(attempt.id, attempt.status, attempt.error);
}
```

It supports filtering by:

- Conversation ID
- Purpose
- Status
- Retry-chain root ID
- Page size
- Pagination cursor

It returns snapshots, not raw database rows:

```ts
{
  attempts: InternalInferenceSnapshot[];
  nextCursor?: string;
}
```

This is mainly useful for administration, debugging, observability, and displaying background work in a UI.

It does not list conversation messages, checkpoint contents, or model output. Those belong to their respective persistence APIs.





# SQLite shape

For this workload, the best model is:

> A narrow canonical `conversation_records` timeline, plus typed subtype tables, plus JSON only for genuinely variable fields.

That preserves one global sequence while avoiding JSON decoding for common reads and avoiding a huge nullable table.

## Comparison

| Model | Writes | Last 50 messages | Mixed timeline | Search/filtering | Extensibility | Long-term fit |
|---|---|---|---|---|---|---|
| Single table + JSON | Best simplicity | Requires JSON decoding | Easy | Awkward; expression indexes | Excellent | Acceptable, but weak for hot typed data |
| Single wide nullable table | Fast, one insert | Very fast | Easy | Excellent | Poor | Becomes unwieldy |
| Envelope + subtype tables | Two inserts per record | Fast indexed join | Base page + batched hydration | Excellent | Good with fallback JSON | **Best balance** |
| Independent table per class | One insert | Fast | Requires `UNION ALL` across every type | Good within each type | Moderate | Weak for a unified timeline |

## Why not independent tables per class?

For example:

```text
messages
tool_call_events
permissions
activities
protocol_records
```

Each table would contain its own:

```text
conversation_id
sequence
timestamp
metadata
```

Messages would be easy to query, but a mixed timeline would require:

```sql
SELECT ... FROM messages
UNION ALL
SELECT ... FROM tool_call_events
UNION ALL
SELECT ... FROM permissions
UNION ALL
SELECT ... FROM activities
UNION ALL
SELECT ... FROM protocol_records
ORDER BY sequence
LIMIT 50;
```

Problems:

- Every new record type changes timeline queries.
- Common columns and indexes are duplicated.
- Enforcing sequence uniqueness across all tables is difficult.
- Generic retention, auditing, pagination, and export become polymorphic.
- Foreign keys cannot point to “any conversation record.”
- Loading an arbitrary record by `record_id` requires knowing its type first or querying several tables.

It saves one detail-table insert, but loses a clean canonical record identity.

## Why not one wide table?

A wide table could look like:

```text
record_id
conversation_id
sequence
kind
timestamp

role
participant_id
message_content
message_status

tool_call_id
tool_name
tool_state
tool_input
tool_output

permission_id
permission_state
permission_outcome

activity_id
activity_type
...
```

SQLite does not store SQL `NULL` values as though they contained full values, so storage waste from nulls is not necessarily catastrophic.

The larger problem is conceptual and operational:

- Most columns are invalid for most rows.
- Constraints become complicated.
- Adding record types continually expands the table.
- Field names begin colliding semantically.
- Indexes need many partial conditions.
- Type-specific behavior becomes difficult to understand.
- Raw protocol and structured content still require JSON.
- Schema evolution becomes increasingly risky.

It could benchmark well, but it is not a good domain model.

## Recommended schema

### 1. Canonical timeline

```sql
CREATE TABLE conversation_records (
  row_id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  agent_session_id TEXT NOT NULL,
  agent_conversation_id TEXT NOT NULL
    REFERENCES conversations(agent_conversation_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  extra_json TEXT,

  UNIQUE(agent_conversation_id, sequence)
);

CREATE INDEX conversation_records_timeline_idx
ON conversation_records(
  agent_conversation_id,
  sequence
);

CREATE INDEX conversation_records_kind_idx
ON conversation_records(
  agent_conversation_id,
  kind,
  sequence
);
```

`extra_json` would be optional. It is for extension data, not the primary representation of known fields.

This table answers:

- What happened?
- In which conversation?
- In what order?
- At what time?
- What subtype contains its details?

It remains narrow even when messages or protocol payloads are enormous.

### 2. Messages

```sql
CREATE TABLE conversation_messages (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,

  role TEXT NOT NULL
    CHECK (role IN ('assistant', 'user')),

  participant_id TEXT
    REFERENCES participants(participant_id),

  content_text TEXT,
  content_json TEXT,

  status TEXT NOT NULL
    CHECK (status IN (
      'in_progress',
      'completed',
      'cancelled',
      'failed'
    )),

  CHECK (
    content_text IS NOT NULL OR
    content_json IS NOT NULL
  )
);
```

Ordinary messages use `content_text`. Multimodal or structured messages use `content_json`.

Reading 50 ordinary messages requires no JSON decoding.

### 3. Tool-call events

```sql
CREATE TABLE conversation_tool_call_events (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,

  tool_call_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN (
      'announced',
      'input',
      'completed',
      'failed'
    )),

  name TEXT,
  input_json TEXT,
  output_text TEXT,
  output_json TEXT,
  error TEXT
);

CREATE INDEX tool_call_events_lookup_idx
ON conversation_tool_call_events(
  tool_call_id,
  record_row_id
);
```

A tool call still has multiple immutable transitions:

```text
sequence  tool_call_id  state
100       tc-1          announced
103       tc-1          input
118       tc-1          completed
```

Some fields remain nullable, but now they are legitimate lifecycle-dependent fields within one type—not dozens of unrelated columns shared by every record.

If desired, transition-specific values could remain in a small `payload_json` while frequently queried fields remain typed:

```text
tool_call_id
state
name
payload_json
```

That is still much better than putting the entire record envelope and identity inside JSON.

### 4. Permissions

```sql
CREATE TABLE conversation_permission_events (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,

  permission_id TEXT NOT NULL,
  state TEXT NOT NULL,
  request_json TEXT,
  outcome TEXT
);
```

### 5. Configuration events

```sql
CREATE TABLE conversation_configuration_events (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,

  operation TEXT NOT NULL,
  config_id TEXT,
  value_json TEXT,
  status TEXT NOT NULL,
  error TEXT
);
```

### 6. Actions and activities

These may share some machinery, but I would keep their semantics distinct:

```text
conversation_native_actions
conversation_agent_actions
conversation_activities
conversation_thinking
```

Fields frequently used for filtering should be typed:

```text
action
activity_id
activity_type
state
```

Variable input/output can remain JSON.

### 7. Raw protocol records

```sql
CREATE TABLE conversation_protocol_records (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,

  direction TEXT NOT NULL,
  method TEXT,
  payload_json TEXT NOT NULL
);
```

Raw ACP is inherently structured and variable, so JSON is appropriate here.

It should also have an independent retention policy because it may grow much faster than the visible conversation.

### 8. Generic extension records

For future consumer-defined kinds:

```sql
CREATE TABLE conversation_generic_records (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,

  schema_id TEXT,
  payload_json TEXT NOT NULL
);
```

This prevents extensibility from forcing every known built-in record back into JSON.

## Write behavior

Each logical event performs two inserts, but only one transaction:

```sql
BEGIN;

INSERT INTO conversation_records (...);

INSERT INTO conversation_messages (...);

COMMIT;
```

That is not two durability flushes. It is one transaction containing two row insertions.

For batches:

```sql
BEGIN;

-- message
INSERT INTO conversation_records ...;
INSERT INTO conversation_messages ...;

-- tool input
INSERT INTO conversation_records ...;
INSERT INTO conversation_tool_call_events ...;

-- activity
INSERT INTO conversation_records ...;
INSERT INTO conversation_activities ...;

COMMIT;
```

With 20 concurrent conversations, batching and transaction frequency matter much more than the extra subtype insertion.

## Reading the last 50 messages

```sql
SELECT
  r.record_id,
  r.sequence,
  r.timestamp,
  r.metadata,
  m.role,
  m.participant_id,
  m.content_text,
  m.content_json,
  m.status
FROM conversation_records r
JOIN conversation_messages m
  ON m.record_row_id = r.row_id
WHERE r.agent_conversation_id = ?
  AND r.sequence < ?
ORDER BY r.sequence DESC
LIMIT 50;
```

The primary-key join is cheap and the message fields are directly available.

## Reading the last 50 mixed records

First retrieve the envelope page:

```sql
SELECT
  row_id,
  record_id,
  sequence,
  kind,
  timestamp,
  metadata,
  extra_json
FROM conversation_records
WHERE agent_conversation_id = ?
  AND sequence < ?
ORDER BY sequence DESC
LIMIT 50;
```

Then group the IDs by kind:

```text
message:     [101, 104, 108]
tool_call:   [102, 103]
activity:    [105, 106]
protocol:    [107]
```

Issue one batched query for each kind present:

```sql
SELECT *
FROM conversation_messages
WHERE record_row_id IN (?, ?, ?);
```

This is not an N+1 query problem. It is:

```text
1 envelope query
+
1 query per subtype present in that page
```

For a page containing four kinds, that is five bounded indexed queries, regardless of whether the page contains 50 or 500 rows.

We could later optimize it with prepared statements or a materialized presentation projection if profiling shows a need.

## Search model

FTS should index deliberately extracted text, not serialized JSON:

```sql
CREATE TABLE conversation_search_documents (
  search_row_id INTEGER PRIMARY KEY,
  record_row_id INTEGER NOT NULL UNIQUE
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  agent_conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  participant_id TEXT,
  searchable_text TEXT NOT NULL
);
```

Then an external-content FTS5 table indexes `searchable_text`.

Examples of searchable projections:

| Kind | Searchable text |
|---|---|
| Message | Message text |
| Tool call | Name, input, output, error |
| Activity | Type and meaningful output |
| Thinking | Content, only when captured |
| Configuration | Configuration ID and selected value |
| Protocol | Excluded by default |
| Permission | Request description and outcome |

The agent can search selected record groups:

```sql
WHERE kind IN ('message', 'tool_call')
```

without scanning or decoding unrelated records.

## High-frequency data

The subtype model does not solve excessive write frequency by itself. We still need policies such as:

- Store semantic message boundaries, not individual tokens.
- Fold thinking chunks into bounded revisions.
- Batch raw ACP frames.
- Coalesce terminal output.
- Record meaningful tool transitions.
- Keep transactions short.
- Give raw protocol records independent retention.

For a full diagnostic transcript, raw fragments can remain separate logical rows but be committed in batches.

## Final recommendation

Use:

```text
conversation_records                   canonical order and identity

conversation_messages                  typed hot path
conversation_tool_call_events          typed lifecycle
conversation_permission_events         typed lifecycle
conversation_configuration_events      typed lifecycle
conversation_native_actions            typed lifecycle
conversation_agent_actions             typed lifecycle
conversation_activities                typed lifecycle
conversation_thinking                  typed content
conversation_protocol_records          variable JSON
conversation_generic_records           extension fallback

conversation_search_documents + FTS5   derived search projection
```

And retain JSON only for:

- Structured or multimodal message content
- Tool inputs and outputs
- Permission requests
- Configuration values
- Raw ACP payloads
- Consumer extensions
- Truly variable metadata

This model gives us:

- One authoritative ordered timeline
- Efficient message retrieval
- Efficient subtype filtering
- Proper SQL constraints
- Better cache behavior at large scale
- Targeted full-text search
- No universal null-heavy table
- No requirement to JSON-decode every common record
- A clean fallback for unknown future record types

It is the strongest match for your mixture of frequent appends, recent-history retrieval, complete mixed timelines, future agent search, and potentially very large conversations.



`conversation_records_messages` is not too long technically, but it reads awkwardly. SQLite will not care about the identifier length; this is primarily about making the schema understandable.

I would use names such as:

```text
conversation_records
conversation_messages
conversation_tool_call_events
conversation_permissions
conversation_configurations
conversation_activities
conversation_protocol_messages
```

The `conversation_` prefix already establishes the scope. `conversation_records_messages` sounds like “messages belonging to records” rather than “message details for a conversation record.”

Another consistent option is:

```text
conversation_records
message_records
tool_call_records
permission_records
```

I slightly prefer `conversation_messages` because it is clear in SQL:

```sql
FROM conversation_records r
JOIN conversation_messages m
  ON m.record_row_id = r.row_id
```

## Message metadata

Yes. Consumers should be able to attach JSON metadata to messages.

We already have metadata in the common envelope, so it does not need to be duplicated in the message table:

```sql
CREATE TABLE conversation_records (
  row_id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  agent_conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata_json TEXT,
  UNIQUE(agent_conversation_id, sequence),

  CHECK (
    metadata_json IS NULL OR
    json_valid(metadata_json)
  )
);
```

Then:

```sql
SELECT
  r.sequence,
  r.timestamp,
  r.metadata_json,
  m.role,
  m.content_text
FROM conversation_records r
JOIN conversation_messages m
  ON m.record_row_id = r.row_id;
```

This makes consumer metadata available to every record kind:

- Messages
- Tool calls
- Permissions
- Activities
- Configuration changes
- Native actions

If a subtype has library-defined variable data, that is different from consumer metadata and can have its own `details_json`, `input_json`, or `output_json`.

## One row or several rows per tool call?

Both designs are possible. They optimize different things.

### Option A: One mutable tool-call row

```sql
CREATE TABLE conversation_tool_calls (
  record_row_id INTEGER PRIMARY KEY,
  tool_call_id TEXT NOT NULL UNIQUE,
  name TEXT,

  announced_at TEXT NOT NULL,
  input_received_at TEXT,
  completed_at TEXT,
  failed_at TEXT,

  state TEXT NOT NULL,
  input_json TEXT,
  output_text TEXT,
  output_json TEXT,
  error TEXT
);
```

Lifecycle:

```text
INSERT announced tool call
UPDATE with input
UPDATE with completion
```

Benefits:

- One logical tool call equals one database row.
- Easy to retrieve the final/current state.
- Less storage.
- Fewer envelope records.
- UI usually wants to display one folded tool call anyway.

Drawbacks:

- It is no longer append-only.
- Earlier values are lost if input or output is revised.
- An update can tell us when completion happened, but not its exact position in the global sequence.
- Audit reconstruction depends on milestone columns being maintained correctly.
- Concurrent or repeated updates require conflict handling.
- A crash between related updates may leave a partially updated entity.
- “Last 50 timeline events” becomes ambiguous for a tool call announced earlier but completed recently.

The global ordering issue is the most important one.

Suppose:

```text
100 tool announced
101 assistant message
102 permission requested
103 tool input learned
104 permission approved
105 tool completed
106 assistant message
```

A single tool-call row has only one `conversation_records.sequence`, probably `100`. Timestamps can say when later transitions happened, but the canonical sequence no longer expresses their exact interleaving.

We could add:

```text
announced_sequence
input_sequence
completed_sequence
```

But then one logical record occupies several timeline positions without corresponding envelope rows. Pagination and mixed reconstruction become complicated.

### Option B: One immutable row per transition

```text
sequence  tool_call_id  state
100       tc-1          announced
103       tc-1          input
105       tc-1          completed
```

Benefits:

- Exact ordering with messages, permissions, and activities.
- Every transition has one timestamp and sequence.
- Append-only writes.
- No previous information is overwritten.
- Straightforward auditability.
- Straightforward crash recovery.
- Straightforward replication/export later.

Drawbacks:

- Usually two or three rows per tool call.
- Reading “current tool calls” requires selecting/folding the latest transition.
- The presentation layer must combine transitions into one visible tool-call item.

For your requirements—full reconstruction and auditability—I prefer immutable transition records.

But we do not need exactly three rows for every tool call. We only append transitions that actually happen and add information:

```text
announced with name and input
completed with output
```

That can be two rows.

If the announcement does not contain input:

```text
announced
input
completed
```

That becomes three.

If it fails immediately:

```text
announced
failed
```

That becomes two.

If the protocol delivers the complete tool call atomically, it could potentially be represented by one completed event containing all known information.

The rule should be:

> Append a new transition when externally observable tool-call state changes—not mechanically force three rows.

## Optional current-state projection

If querying the current tool-call state becomes frequent, we can maintain a projection alongside the immutable history:

```sql
CREATE TABLE conversation_tool_calls (
  agent_conversation_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  current_state TEXT NOT NULL,
  name TEXT,
  input_json TEXT,
  output_text TEXT,
  output_json TEXT,
  error TEXT,
  announced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,

  PRIMARY KEY(agent_conversation_id, tool_call_id)
);
```

Then:

```text
conversation_tool_call_events = authoritative history
conversation_tool_calls       = replaceable current-state projection
```

Writing `completed` would atomically:

1. Append the immutable `completed` event.
2. Update the current-state projection.

This gives fast current-state retrieval without sacrificing history. I would only add the projection if profiling or API needs justify it.

## Could timestamps alone replace transition records?

They preserve milestone times:

```text
announced_at
input_received_at
completed_at
```

But timestamps do not fully replace sequence:

- Two events can share a timestamp.
- Clock precision and ordering can vary.
- Timestamps may come from different producers.
- They do not enforce total order within one conversation.
- Pagination by timestamp can skip or duplicate records.
- They do not preserve multiple revisions of the same state.

For a simple job table, timestamps are enough. For an auditable conversation timeline, sequence-backed transition records are safer.

## FTS5 is not a field

FTS5 is a virtual table, not a column added to an ordinary table.

We have two reasonable designs.

### Separate FTS table per searchable subtype

```sql
CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
  content_text,
  content = 'conversation_messages',
  content_rowid = 'record_row_id'
);
```

And potentially:

```sql
CREATE VIRTUAL TABLE conversation_tool_calls_fts USING fts5(
  name,
  input_text,
  output_text,
  error_text,
  content = 'conversation_tool_call_search',
  content_rowid = 'record_row_id'
);
```

Benefits:

- Message searches touch only messages.
- Tool searches touch only tool calls.
- Different tokenization can be used.
- No irrelevant JSON syntax.
- Each index has a clear retention policy.
- Search APIs naturally correspond to record groups.

Drawbacks:

- Searching messages and tools together requires querying multiple FTS tables.
- FTS ranking scores from separate indexes are not always directly comparable.
- More schema objects and triggers.

### One unified search projection

```sql
CREATE TABLE conversation_search_documents (
  search_document_id INTEGER PRIMARY KEY,
  record_row_id INTEGER NOT NULL UNIQUE,
  agent_conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  participant_id TEXT,
  searchable_text TEXT NOT NULL
);

CREATE VIRTUAL TABLE conversation_search_fts USING fts5(
  searchable_text,
  content = 'conversation_search_documents',
  content_rowid = 'search_document_id'
);
```

Benefits:

- One search across messages, tools, activities, and thinking.
- Easy filtering by conversation and kind through the projection.
- One ranking space.
- One search API.

Drawbacks:

- Searchable text must be projected from every subtype.
- It duplicates a normalized textual representation.
- Different record kinds may benefit from different weighting/tokenization.

## What I recommend for FTS

Start with subtype-specific FTS for the clearly searchable hot paths:

```text
conversation_messages_fts
conversation_tool_calls_fts
```

Do not create an FTS table for every subtype automatically. Permissions, configuration, protocol traffic, and activities should only get one when there is a defined search use case.

Later, if the agent needs a command such as:

> Search everything I have ever discussed or done for “migration plan.”

then add a unified derived search index. It would not replace subtype storage; it would be a replaceable projection optimized for cross-type retrieval.

For messages:

```text
conversation_messages
└── conversation_messages_fts
```

For tool calls, because searchable content may be spread across several transitions, I would probably index a folded tool-call search document rather than every lifecycle transition independently:

```text
conversation_tool_call_events     authoritative transitions
conversation_tool_calls           optional folded current state
conversation_tool_calls_fts       searchable folded text
```

## Recommended decisions

- Use `conversation_messages`, not `conversation_records_messages`.
- Keep consumer `metadata_json` on the common envelope.
- Preserve tool-call state changes as immutable timeline transitions.
- Do not force exactly three transitions; record only meaningful observed changes.
- Add a current-state tool projection only if needed.
- Give every transition its canonical sequence and timestamp.
- Use separate FTS5 virtual tables for important searchable subtypes initially.
- Do not index raw JSON or create FTS indexes without a defined query.
- Consider a unified search projection later for cross-type agent memory search.

That distinction makes sense. The message’s semantic participant and the consumer-specific delivery provenance are different concepts.

For example:

- The conversation is still between the local agent and `user-1`.
- The message semantically belongs to `user-1`.
- But Agent Bob delivered or generated the message while acting on the user’s behalf.
- The UI wants to display “sent through Bob.”
- The library should not reinterpret Bob as a participant in that conversation.

Therefore, `sender` should not become a first-class message column or replace `participant_id`.

A message could look conceptually like:

```ts
{
  role: "user",
  participantId: "user-1",
  content: "Please review this",
  metadata: {
    submittedBy: {
      kind: "agent",
      id: "bob",
      name: "Bob"
    }
  }
}
```

The canonical semantics remain:

```text
role=user
participant=user-1
```

The consumer may present:

```text
User message · submitted by Bob
```

## Put metadata on the message subtype

In this case, I agree that message metadata belongs in `conversation_messages`:

```sql
CREATE TABLE conversation_messages (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,

  role TEXT NOT NULL,
  participant_id TEXT,
  content_text TEXT,
  content_json TEXT,
  status TEXT NOT NULL,

  consumer_metadata_json TEXT,

  CHECK (
    consumer_metadata_json IS NULL OR
    json_valid(consumer_metadata_json)
  )
);
```

This communicates that the metadata describes the message rather than the generic timeline event.

Other subtype tables can independently expose metadata if needed:

```text
conversation_messages.consumer_metadata_json
conversation_tool_call_events.consumer_metadata_json
conversation_activities.consumer_metadata_json
```

We do not need to add it everywhere preemptively.

## Separate library metadata from consumer metadata

This is important because the current implementation also stores internal data such as `operationId` in message metadata. We should not combine opaque consumer data with library-owned bookkeeping.

The schema should distinguish them:

```sql
conversation_records.system_metadata_json
conversation_messages.consumer_metadata_json
```

Or perhaps:

```sql
conversation_records.internal_json
conversation_messages.metadata_json
```

I prefer explicit names:

```text
system_metadata_json
consumer_metadata_json
```

That prevents collisions such as:

```json
{
  "operationId": "consumer-value"
}
```

overwriting or being confused with the library’s operation ID.

Library-owned fields that are fundamental should ideally be typed columns rather than hidden metadata. For example, if `operation_id` is used for correlation and checkpoint counting, it likely belongs in the canonical envelope:

```sql
conversation_records.operation_id
```

Remaining implementation-only details could use `system_metadata_json`.

## Participant versus delivery provenance

The definitions should be:

- `participant_id`: who the message semantically represents within this conversation.
- `consumer_metadata_json`: optional consumer-specific facts about how the message arrived or should be presented.
- The library does not treat metadata as authentication or identity continuity.
- Changing metadata does not create or select another conversation.
- Metadata is not automatically included in model context.
- Metadata is not searched unless a consumer explicitly projects it into a search index.

Example:

```ts
await conversation.prompt("Please review this", {
  participantId: "user-1",
  metadata: {
    submittedBy: {
      kind: "agent",
      id: "bob",
      displayName: "Bob",
    },
  },
});
```

If Bob is actually talking as Bob in the Atlas–Bob conversation:

```ts
await conversation.prompt("Please review this", {
  participantId: "agent-bob",
});
```

Those are semantically different:

```text
User conversation:
  participant=user-1
  submittedBy=bob     // consumer presentation detail

Atlas–Bob conversation:
  participant=agent-bob
  submittedBy absent  // Bob is the actual participant
```

## Keep the metadata opaque

The library should validate only that it is JSON:

```ts
type MessageMetadata = PersistenceJsonValue;
```

It should not prescribe:

```ts
submittedBy
sender
forwardedBy
impersonatedBy
delegatedBy
```

Those names and semantics belong to the consumer.

If one field later becomes broadly useful across consumers—for example, signed delivery provenance—we can promote it to a formal typed concept. Until then, message-level consumer metadata is the correct place.

So the revised message model should have:

```text
role
participant_id
content_text/content_json
status
consumer_metadata_json
```

while preserving participant identity as the conversation-semantic concept and leaving delivery/presentation provenance entirely consumer-defined.

We have the architectural direction, but a few implementation details should be fixed before changing the schema. Otherwise we risk designing them accidentally while coding.

My recommended final model is below.

## 1. Canonical envelope

Keep:

```sql
conversation_records (
  row_id,
  record_id,
  agent_session_id,
  agent_conversation_id,
  sequence,
  kind,
  timestamp,
  operation_id,
  system_metadata_json
)
```

Remove `payload_json` once migration is complete.

`operation_id` should become a real column because the library uses it for correlation, response counting, checkpointing, and metering.

`system_metadata_json` is only for uncommon library-owned details that do not deserve columns.

## 2. Typed detail tables

Use:

```text
conversation_messages
conversation_tool_call_events
conversation_permission_events
conversation_configuration_events
conversation_protocol_records
conversation_native_action_events
conversation_agent_action_events
conversation_thinking_events
conversation_activity_events
```

Every detail row has:

```sql
record_row_id INTEGER PRIMARY KEY
  REFERENCES conversation_records(row_id)
  ON DELETE CASCADE
```

This retains one globally ordered timeline.

## 3. Message structure

```sql
conversation_messages (
  record_row_id,
  role,
  participant_id,
  content_text,
  content_json,
  status,
  provider_message_id,
  consumer_metadata_json
)
```

Rules:

- Simple text uses `content_text`.
- Structured/multimodal content uses `content_json`.
- Consumer metadata remains opaque JSON.
- Delivery provenance such as `submittedBy: "bob"` remains metadata.
- It does not alter `participant_id`.
- Consumer metadata is not automatically passed to the model or indexed by FTS.

## 4. Tool calls

Keep immutable transitions, but only when meaningful state changes occur:

```text
announced
input
completed
failed
```

A tool call may therefore produce one, two, or three records. We do not mechanically require three.

Each event contains a delta:

```sql
conversation_tool_call_events (
  record_row_id,
  tool_call_id,
  state,
  name,
  input_json,
  output_text,
  output_json,
  error,
  consumer_metadata_json
)
```

No current-state projection initially. We can add one later if tool-state queries demonstrate a need.

## 5. Other lifecycle records

Permissions, configuration changes, native actions, agent actions, thinking, and activities remain immutable state transitions.

Their frequently queried identity/state fields become typed columns. Variable request/input/output content can remain JSON.

Raw ACP protocol data remains JSON because its shape is external and variable.

## 6. FTS5

This is the main remaining choice.

I recommend starting with:

```text
conversation_messages_fts
conversation_tool_calls_fts
```

Not one FTS table for every subtype.

- Message FTS indexes only `content_text`.
- Tool FTS indexes a deliberately flattened searchable representation of the name, input, output, and error.
- Consumer metadata is excluded.
- Raw ACP is excluded by default.
- Thinking is excluded unless capture and search are explicitly enabled.

The existing general search API can query whichever indexes correspond to the requested kinds and merge results. If cross-type ranking later becomes important, we can add a unified search projection.

## 7. Existing API compatibility

The public persistence API should continue returning the same discriminated TypeScript records:

```ts
ConversationRecord =
  | MessageRecord
  | ToolCallRecord
  | PermissionRecord
  | ...
```

Consumers should not know whether those records came from JSON payloads or subtype joins.

Likewise, existing methods should retain their behavior:

```ts
records.append(...)
records.appendMany(...)
records.list(...)
messages.list(...)
search.search(...)
```

This is an internal storage migration, not an API redesign, except for adding explicit message metadata input where it is currently missing.

## 8. Existing database migration

We need an automatic schema migration, likely version 5 → 6:

1. Create all subtype tables.
2. Add typed envelope fields such as `operation_id`.
3. Read each existing `conversation_records.payload_json`.
4. Insert its decoded fields into the corresponding subtype table.
5. Verify every base record has exactly one valid detail row.
6. Build the new FTS indexes.
7. Only then remove or retire `payload_json`.

SQLite cannot conveniently remove one column on every supported version without rebuilding the table. The safest migration is probably:

```text
conversation_records_v6
populate
validate counts and identities
replace old table
rebuild indexes and triggers
```

The whole migration should run transactionally.

We should test migration from a real version-5 database containing every record kind, not just create fresh version-6 databases.

## 9. Retention semantics

Deleting an envelope row should cascade to:

- Its subtype row
- Search projection/index
- Any derived current-state projection added later

Raw protocol retention may delete only protocol records without touching messages or visible activity.

Conversation deletion semantics remain unchanged.

## 10. Query behavior

We need both:

```ts
messages.list(conversationId, ...)
```

which uses an efficient direct join, and:

```ts
records.list(conversationId, {
  kinds: [...]
})
```

which:

1. Selects an envelope page.
2. Groups row IDs by kind.
3. Batch-loads each present subtype.
4. Reassembles records by sequence.

This is bounded subtype hydration, not one query per row.

## What remains to decide

Only three policy details remain:

1. Whether `consumer_metadata_json` should exist only on messages or on every subtype.
   My recommendation: begin with messages, because that is the concrete requirement.

2. Whether old `payload_json` should be removed immediately after migration or retained temporarily for rollback/debugging.
   My recommendation: remove it in the rebuilt v6 table after transactional validation; keeping two authoritative representations invites drift.

3. Whether FTS should initially cover only messages and tool calls.
   My recommendation: yes, while keeping the search implementation extensible to more record kinds.

With those defaults accepted, we have enough defined to implement the schema change safely. I would do it in separate commits:

1. Version-6 schema and transactional migration.
2. Typed write path.
3. Typed read/hydration path.
4. Message and tool-call FTS.
5. Migration, concurrency, large-history, and API compatibility tests.
6. Consumer guide update and end-to-end smoke verification.


Agreed. If SQLite has only been used by smoke tests, we should not spend effort building and maintaining a version-5 data migration.

Instead:

- Introduce the new schema version.
- Create new databases directly in the new shape.
- Detect an existing incompatible database and return a clear error telling the consumer to recreate it.
- Delete and recreate the smoke-test `agent.sqlite` when testing.

We should not silently delete an existing database from library code, even during this stage.

For FTS5, yes: initially cover these three groups:

```text
conversation_messages_fts
conversation_tool_calls_fts
conversation_activities_fts
```

Activity search should index only intentionally captured textual content:

- Activity type/name
- Command or operation summary
- File paths where appropriate
- Captured terminal output
- Captured file-edit descriptions
- Error text

It should not blindly index serialized JSON, consumer metadata, or raw protocol payloads.

Therefore the settled decisions are:

- Narrow `conversation_records` envelope.
- Typed subtype tables.
- Message-only `consumer_metadata_json` initially.
- Immutable meaningful lifecycle transitions for tools and activities.
- JSON retained for genuinely structured fields.
- Separate FTS5 indexes for messages, tool calls, and activities.
- No legacy SQLite migration.
- Clear rejection of the old schema.
- Public persistence APIs continue returning the same record types.
- Existing smoke database must be recreated.

That is enough to begin implementation.

