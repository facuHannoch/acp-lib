Your workload is a good fit for SQLite—especially with one database per agent. Twenty agents using twenty separate database files do not contend on one global SQLite writer lock. Each database serializes only the writes belonging to that agent.

The important question is not “20 agents,” but “how many concurrent writes target the same agent database?”

## Expected concurrency

Suppose Atlas is talking with:

- One user
- Five other agents
- Several background checkpoint/identity tasks
- A harness producing tool and activity events

All writes for Atlas serialize through `atlas.sqlite`. SQLite in WAL mode allows:

- Multiple concurrent readers
- One writer at a time per database
- Very short transactions to queue efficiently

That should be entirely reasonable if each operation is a small transaction. Model responses, tool calls, terminal commands, and file edits are slow compared with a local SQLite insert.

Even a busy agent is unlikely to generate database writes at anything approaching SQLite’s actual local-disk capacity unless we persist extremely granular streaming events.

The dangerous version would be:

```text
one database transaction per output token
one transaction per terminal-output chunk
one transaction per thinking delta
one transaction per raw streaming fragment
```

We should instead fold or batch high-frequency updates:

```text
assistant message chunks → one completed message, or periodic checkpoints
terminal chunks          → bounded activity updates
thinking chunks          → one block or periodic revisions
raw ACP traffic          → batched append transaction
tool lifecycle           → a few meaningful transitions
```

For example:

```text
tool announced
tool input received
tool completed
```

Three durable events are reasonable. Three thousand terminal-output fragments for one shell command probably are not.

## One database per agent changes the scaling model

With twenty agents:

```text
atlas.sqlite  → Atlas writes
bob.sqlite    → Bob writes
orion.sqlite  → Orion writes
...
```

Each file has an independent WAL and writer lock. Those agents can write concurrently.

The harness processes and model calls will probably consume substantially more resources than SQLite.

Contention becomes material when:

- Several processes write to the same agent database.
- Transactions remain open while waiting for a model or subprocess.
- A network-mounted filesystem implements file locking poorly.
- Raw streaming events are committed individually.
- Too many indexes must be updated for every event.

Transactions must contain only database work. We should never do this:

```text
BEGIN
write prompt
wait 30 seconds for model
write response
COMMIT
```

Instead:

```text
BEGIN
write prompt
COMMIT

wait for model

BEGIN
write response and terminal state
COMMIT
```

The existing architecture generally follows this short-transaction model.

## Container and mount caveat

A SQLite file is portable and works well when one machine or container owns it, including bind-mounted local storage.

It becomes less attractive when:

- Multiple hosts concurrently mount and write the same database.
- The file lives on NFS or another filesystem with questionable locking semantics.
- A centralized service needs to query every agent simultaneously.
- Several application servers need shared write access.

That is the point where PostgreSQL adds value. It is not necessary merely because twenty agents exist.

## Recommended record schema

Given your access patterns, I would move toward the envelope-plus-subtype design:

```text
conversation_records
├── message_records
├── tool_call_events
├── permission_events
├── configuration_events
├── action_events
├── activity_events
└── protocol_records
```

### Canonical envelope

```sql
CREATE TABLE conversation_records (
  row_id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  agent_session_id TEXT NOT NULL,
  agent_conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  UNIQUE(agent_conversation_id, sequence)
);

CREATE INDEX conversation_records_timeline
ON conversation_records(agent_conversation_id, sequence);
```

This table remains the source of global ordering.

### Messages

```sql
CREATE TABLE message_records (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('assistant', 'user')),
  participant_id TEXT,
  content_text TEXT,
  content_json TEXT,
  status TEXT
);
```

Plain messages require no JSON decoding. Multimodal content can remain in `content_json`.

### Tool-call lifecycle

```sql
CREATE TABLE tool_call_events (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  state TEXT NOT NULL,
  name TEXT,
  input_json TEXT,
  output_text TEXT,
  output_json TEXT,
  error TEXT
);

CREATE INDEX tool_call_events_identity
ON tool_call_events(tool_call_id, record_row_id);
```

Each transition remains immutable and timestamped through its envelope row.

### Protocol records

Raw ACP traffic is structurally different and potentially much larger:

```sql
CREATE TABLE protocol_records (
  record_row_id INTEGER PRIMARY KEY
    REFERENCES conversation_records(row_id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  method TEXT,
  payload_json TEXT NOT NULL
);
```

It should probably have a separate retention policy because raw protocol traffic may grow much faster than user-visible chat history.

## Loading the last 50 records

If the UI shows a complete mixed timeline:

```sql
SELECT row_id, sequence, kind, timestamp, metadata
FROM conversation_records
WHERE agent_conversation_id = ?
ORDER BY sequence DESC
LIMIT 50;
```

Then:

1. Group those 50 row IDs by kind.
2. Fetch each present subtype with one batched query.
3. Reassemble by sequence.

If the page contains messages, tool calls, and activities, that might mean four queries:

```text
1 envelope query
1 message query
1 tool-call query
1 activity query
```

That is not concerning. Four indexed local SQLite queries are normally cheaper than repeatedly decoding large generic JSON objects, and the base timeline query touches only the narrow envelope table.

If a screen only needs messages:

```sql
SELECT r.sequence, r.timestamp, m.*
FROM conversation_records r
JOIN message_records m ON m.record_row_id = r.row_id
WHERE r.agent_conversation_id = ?
ORDER BY r.sequence DESC
LIMIT 50;
```

## Searching the agent’s own records

I would not make FTS index the raw `payload_json`. That indexes JSON field names and structural noise.

Instead, create a deliberate search projection:

```sql
CREATE VIRTUAL TABLE conversation_search USING fts5(
  searchable_text,
  content = ''
);
```

And maintain a corresponding map:

```sql
CREATE TABLE conversation_search_documents (
  search_row_id INTEGER PRIMARY KEY,
  record_row_id INTEGER NOT NULL UNIQUE,
  agent_conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  participant_id TEXT,
  timestamp TEXT NOT NULL
);
```

Searchable text would be derived by record type:

- Message: message content
- Tool call: tool name, input, output, error
- Thinking: captured thinking content, if enabled
- Activity: relevant summary/output
- Configuration: command and selected value
- Protocol: probably excluded by default
- Permission: request description and result

Then the agent could search only selected groups:

```sql
WHERE kind IN ('message', 'tool_call')
```

or only its conversation with Bob:

```sql
WHERE participant_id = 'agent-bob'
```

FTS results return `record_row_id`, which maps back to the canonical timeline.

## Other important access patterns

We should design and benchmark at least these:

1. Last 50 mixed timeline records.
2. Last 50 messages only.
3. All messages after a sequence.
4. Full conversation export.
5. Find a tool call and its complete lifecycle.
6. Find unresolved permissions or active activities.
7. Text search across selected record kinds.
8. Checkpoint generation over records since the last checkpoint.
9. Recovery loading one summary plus a bounded tail.
10. Retention or deletion of raw protocol records.
11. Audit delivery by record ID.
12. Participant-specific history.
13. Concurrent appends to several conversations in one agent database.
14. Reads while checkpointing or identity updates are writing.

## Index discipline

Indexes improve reads but increase write cost. We should keep the common indexes small and purposeful:

```text
conversation_records(conversation_id, sequence)
conversation_records(conversation_id, kind, sequence)
tool_call_events(tool_call_id, record_row_id)
message participant lookup, if demonstrated necessary
FTS search projection
```

We should not preemptively index every subtype field.

## Practical conclusion

For your expected usage:

- Twenty agents with separate SQLite databases: fine.
- Six active conversations writing into one agent database: likely fine.
- Reading the latest 50 records frequently: very suitable for SQLite.
- Searching historical records: FTS5 is suitable.
- Complete long-term history: suitable, with retention controls for raw/high-volume data.
- Multiple machines concurrently writing the same agent identity: use a server database eventually.

The main scalability risks are not SQLite itself. They are:

- Persisting streaming fragments too granularly.
- Holding transactions open across model work.
- Indexing everything.
- Treating raw ACP traffic as permanent unbounded history.
- Parsing every record from generic JSON on hot read paths.

So I would keep SQLite and one database per agent, but revise conversation persistence to use a narrow ordered envelope plus typed subtype tables, batching/coalescing high-frequency activity where appropriate. Before migrating, we should create a representative benchmark at 100,000, 1 million, and 10 million records with mixed concurrent writes and the actual read/search queries above.





With 20 agents talking to the same agent, the situation is materially different: all 20 receiver-side conversations write into the same agent database.

Conceptually:

```text
B ──▶ A/conversation-B ──┐
C ──▶ A/conversation-C ──┤
D ──▶ A/conversation-D ──┤──▶ A.sqlite
...                      │
T ──▶ A/conversation-T ──┘
```

SQLite still allows only one writer transaction at a time in `A.sqlite`. WAL permits readers during writes, but it does not create multiple simultaneous writers.

That said, 20 active conversations are not automatically too many. Model and tool operations are slow, while correctly designed database transactions are extremely short.

## What is likely to struggle first?

Probably not SQLite. The likely order is:

1. Harness process memory
2. Provider concurrency/rate limits
3. CPU and subprocess I/O
4. Internal inference and identity-update demand
5. Application event-loop pressure
6. SQLite write queue
7. Database size and FTS maintenance over time

Forty ACP processes could be expensive. If each process consumes even 100–300 MB, that is approximately 4–12 GB before accounting for the orchestration process, filesystem cache, containers, and model-related tooling. Some harnesses may consume considerably more.

The exact process footprint must be measured; it will likely determine capacity before SQLite does.

Your simpler controller idea would change this substantially. If receiver-side conversations can use direct model calls or restricted internal inference instead of full harness processes, the system could support many more concurrent conversations. The persistence model would remain the same.

## SQLite’s practical limit here

The useful metric is not the number of conversations. It is the number and duration of committed write transactions per second.

Suppose 20 conversations are active, but every model turn takes several seconds:

```text
20 conversations
÷ 5-second average turn
≈ 4 completed turns per second
```

Even if each completed turn creates:

- One prompt record
- Two message records
- Three tool-call transitions
- Several activity records
- One metering record
- One checkpoint-related update occasionally

that is manageable, particularly if related records are inserted in one transaction.

A rough example:

```text
4 turns/second × 10 durable records
= 40 records/second
```

That is not a demanding SQLite workload on local storage.

Even 100–300 short transactions per second can be perfectly reasonable on local SSD storage, though the actual result depends on durability configuration, schema indexes, storage, payload size, and transaction design. We should benchmark rather than encode that as a guarantee.

The danger is transforming one semantic operation into hundreds or thousands of transactions.

For example:

```text
20 conversations
× 10 streamed updates/second
× message + thinking + terminal + raw ACP
= potentially hundreds of commits/second
```

If every protocol fragment commits separately, the write queue can become the first bottleneck.

## Record rate matters more than agent count

These two situations are very different:

### Twenty mostly waiting conversations

```text
20 controllers
2–5 currently generating
occasional tool and message records
```

SQLite should be comfortable.

### Twenty continuously streaming conversations

```text
20 controllers
all generating
thinking chunks
terminal output chunks
raw ACP frames
tool updates
identity updates
checkpoint jobs
```

This can produce a large write volume even before a turn completes.

The correct approach is to distinguish:

- Semantic records that should be written immediately
- Streaming revisions that can be coalesced
- Diagnostic raw traffic that can be batched
- Derived projections that can update asynchronously

## Recommended persistence granularity

Persist immediately:

- User/agent message boundary
- Assistant message boundary
- Tool announced
- Tool input established
- Tool completed or failed
- Permission requested/resolved
- Configuration started/completed/failed
- Handoff/switch/recovery transitions
- Metering operation completion

Coalesce or batch:

- Assistant token chunks
- Thinking deltas
- Terminal output chunks
- File-edit progress fragments
- Raw ACP messages
- Repeated activity updates

For example, terminal output could be checkpointed every 250–1000 milliseconds, on a size threshold, and at completion—not once per received chunk.

Raw ACP frames can still remain individually reconstructable while being inserted in batches:

```sql
BEGIN;
INSERT ...;
INSERT ...;
INSERT ...;
COMMIT;
```

One transaction does not imply one record.

## A useful capacity model

Let:

- `C` = active conversations
- `E` = durable events per conversation per second
- `B` = events written per transaction through batching
- `T` = average write transaction duration in seconds

Then approximate writer utilization is:

```text
transactions/second = C × E ÷ B

writer utilization = transactions/second × T
```

Example:

```text
C = 20
E = 5 durable events/second
B = 10 records/transaction
T = 0.001 seconds

transactions/second = 10
writer utilization = 1%
```

Without batching:

```text
B = 1
transactions/second = 100
writer utilization = 10%
```

If transactions take 5 ms because the storage is slow:

```text
100 × 0.005 = 50%
```

At that point, burst latency becomes visible.

We should aim for sustained writer utilization comfortably below saturation—ideally under roughly 30–50% during expected peaks—so bursts, checkpoints, and searches do not create large queues.

## Reasonable initial concurrency targets

These are engineering targets to benchmark, not hard SQLite limits:

| Concurrent conversations for one agent | Initial expectation |
|---:|---|
| 1–20 | Should be comfortable |
| 20–50 | Likely viable; process memory and provider limits need measurement |
| 50–100 | Requires deliberate batching, process/resource controls, and load testing |
| 100+ | Full ACP process-per-conversation likely becomes the dominant architectural problem |
| Hundreds using direct model calls | Potentially feasible, but requires a scheduler and bounded concurrency |

I would initially design for:

- 50 open conversations per agent
- 20 simultaneously active/generating
- A configurable global harness concurrency limit
- Remaining conversations queued but still addressable
- Batched persistence for high-frequency records
- One process owning each agent database
- Keyset pagination and narrow subtype tables
- Checkpoint and identity work coalesced per agent

Then benchmark at 20, 50, and 100 active conversations.

## Process ownership matters

The best SQLite topology is:

```text
one Agent runtime/process
    owns A.sqlite
    owns 20 AgentConversation objects
    owns or supervises their controllers
```

That lets the library serialize writes internally and avoids `SQLITE_BUSY` contention between unrelated operating-system processes.

Less desirable:

```text
20 independent orchestration processes
    all directly open and write A.sqlite
```

SQLite can coordinate them through file locks, but application-level queuing, observability, cancellation, and fair scheduling become harder. A single owner process or actor for each agent identity is cleaner.

The remote agents do not need direct database access. They send messages to the runtime that owns A.

## Reads

Loading the latest 50 mixed records should remain cheap:

1. Fetch 50 envelope rows using `(conversation_id, sequence)`.
2. Batch-load their subtype records.
3. Reassemble in sequence order.

Twenty conversations being loaded simultaneously means roughly tens of small indexed queries, not full-table scans.

WAL lets those reads proceed while writes occur. The current synchronous SQLite API can still briefly occupy the JavaScript thread, but a 50-row indexed query should be short. Heavy FTS searches across millions of records are a different workload and may eventually deserve:

- A dedicated read-only connection
- A worker thread
- Search result limits
- Timeouts
- Rate limiting

## Identity and checkpointing may become the larger issue

If every conversation modifies the shared identity, twenty conversations may trigger many identity operations.

We should not run twenty simultaneous identity-summary model calls. A better model is:

```text
conversation records
        ↓
durable identity input queue
        ↓
one or a few bounded identity workers
        ↓
merged identity state
```

Similarly, checkpointing should coalesce work. If five new responses arrive while a checkpoint is running, generate one subsequent checkpoint covering the combined range rather than five separate summaries.

The database can accept all facts independently; AI-derived consolidation should be bounded and asynchronous.

## When PostgreSQL becomes justified

PostgreSQL becomes attractive when:

- Multiple hosts must write the same agent identity.
- An agent database needs several independent owners.
- Centralized querying across thousands of agents is fundamental.
- Database-side background workers or change streams are needed.
- Write contention remains high after batching.
- Network-accessible shared persistence is required.
- SQLite file placement and locking become operationally difficult.

Twenty conversations within one locally owned agent do not by themselves require PostgreSQL.

## Recommendation

Design for one SQLite database and one owning runtime per agent, with:

- Up to roughly 50 open conversations initially
- A lower configurable limit for simultaneous harness execution
- Short write transactions
- Batch insertion of streaming/raw events
- Typed subtype tables
- WAL mode
- Bounded checkpoint and identity workers
- Backpressure when record queues grow
- Metrics for write latency, queue depth, WAL size, process memory, and event rate

The first capacity test should measure:

```text
20, 50, and 100 conversations
1, 5, 10, and 20 simultaneously generating
raw ACP capture off / metadata / full
activity coalescing on / off
checkpointing on
identity updates on
```

The key failure signals are:

- Harness RSS and process count
- Provider throttling
- Event-loop lag
- Persistence queue depth
- p95/p99 commit latency
- WAL growth/checkpoint duration
- FTS query latency
- Delayed checkpoint/identity work

My expectation is that full ACP process-per-conversation becomes impractical before a well-batched SQLite database does. The simpler receiver-side inference runtime you described is likely the path from tens of simultaneous conversations to hundreds.




Yes. SQLite should be sufficient even for an experimental workflow where approximately 20 agents concurrently talk to the same agent.

The key qualification is that “concurrently talking” does not normally mean 20 database writes happening at the exact same instant continuously. Most of the time is spent waiting for model inference, tools, subprocesses, and network operations. SQLite only needs brief windows to append the resulting records.

With one database per agent:

- Twenty conversations share one serialized SQLite writer.
- Reads can continue concurrently in WAL mode.
- Writes should remain short and transactional.
- Streaming data should be batched or coalesced.
- Full ACP processes, memory consumption, provider limits, and identity consolidation are likely to become bottlenecks before SQLite.

SQLite may struggle earlier if you:

- Commit every streamed token or terminal chunk independently.
- Store every raw ACP fragment in a separate transaction.
- Hold transactions open while awaiting an agent.
- Let several operating-system processes independently own the same agent database.
- Place the database on an unsuitable network filesystem.
- Run many expensive FTS queries synchronously alongside writes.

Those are avoidable architectural problems rather than inherent consequences of twenty conversations.

Your proposed identity approach is also plausible:

```text
latest completed identity summary
+
records/messages after that summary
+
a bounded recent tail
```

The summary does not need to be perfectly current. It needs an explicit coverage boundary:

```text
identity summary covers through sequence 12,400
current conversation tail contains sequences 12,401–12,750
```

The agent receives both, so delayed summarization does not create a knowledge gap. New identity summarization can asynchronously fold the uncovered range into a later snapshot. That resembles the checkpoint mechanism we just implemented and avoids requiring every conversation to block on identity consolidation.

The more fundamental uncertainty is exactly what you identified: usefulness and behavioral coherence, not persistence capacity. Twenty independent ACP processes can share an identity without sharing one cognitive stream. That gives enormous concurrency, but it raises questions such as:

- Whether simultaneous decisions contradict each other.
- Which conversation can commit durable decisions.
- How rapidly identity changes should propagate.
- Whether agents need awareness of currently active conversations.
- How conflicting memories should be represented.
- Whether a “manager” with 20 independent conversational instances still behaves like one coherent entity.

Those are identity and coordination semantics. SQLite can persist the inputs, ordering, summaries, and revisions needed to experiment with them.

So I would treat approximately 20 concurrent conversations as a supported experimental target for SQLite, not as a reason to introduce PostgreSQL now. We should eventually load-test it, but I would expect ACP-process overhead and coherent identity behavior to fail—or at least become interesting—before SQLite write throughput does.
