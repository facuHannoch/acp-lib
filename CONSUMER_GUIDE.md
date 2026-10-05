# Consumer guide

This guide is for applications embedding `@qlairoslabs/acp-client`, especially
orchestrators that own several agents and conversations. The recommended durable API is
`Agent`, backed by a caller-located SQLite database. The library owns ACP communication,
conversation queues, typed records, search, identity lifecycle hooks, and persistence.
The consumer owns database placement, adapter definitions, user interface, and application
policy.

`AgentSession` remains the compatibility name for one live `AgentConversation`. The
older `SessionManager`/JSONL workflow is still supported and documented later in this
guide, but new durable applications should normally begin with `Agent`.

The package requires Bun 1.3.5 or newer.

## Mental model

There are three primary runtime layers:

| Layer | Main API | Examples |
|---|---|---|
| Agent identity and persistence | `Agent` | Own SQLite persistence, adapter registry, identity runtime, and conversations |
| One stable conversation | `AgentConversation` (`AgentSession` compatibility alias) | Prompt, interrupt, handoff, switch adapters, reset, observe state, and configure the harness |
| Active harness thread | ACP and `internalSessionCommands` | Harness-specific commands such as `/usage` and `/model` |

An `agentSessionId` (`ags-*`) identifies the agent. An `agentConversationId` (`agc-*`)
identifies one of its conversations. An `internalSessionId` identifies the replaceable
provider or harness thread behind that conversation.

```text
consumer
  └── Agent ags-…                           stable agent identity + SQLite database
        └── AgentConversation agc-…         stable conversation identity
              └── AgentController
                    └── internal thread abc replaceable harness identity
```

## Install and import

```bash
bun add @qlairoslabs/acp-client
```

```ts
import {
  ADAPTERS,
  Agent,
  AgentAuditLogReader,
  AgentSession,
  AuditLogReader,
  SessionManager,
  TranscriptReader,
  formatResponseMessages,
  type Adapter,
  type AgentSessionOpenStage,
  type AgentSessionNotification,
  type PromptHandlers,
} from "@qlairoslabs/acp-client";
```

## Start with one SQLite-backed agent

The database path is explicit and belongs to the consumer. One database contains one
agent identity and any number of independently addressable conversations.

```ts
import { Agent, ADAPTERS } from "@qlairoslabs/acp-client";

const agent = await Agent.open({
  persistence: {
    kind: "sqlite",
    path: "/absolute/path/to/state/atlas.sqlite",
  },
  adapters: {
    codex: ADAPTERS.codex,
  },
  defaultAdapterId: "codex",
});

try {
  const conversation = await agent.conversations.create();
  const result = await conversation.prompt("hi");

  for (const message of result.messages) {
    console.log(message.text);
  }
} finally {
  await agent.close();
}
```

The user message and each assistant-message boundary are stored as separate typed rows.
Reopen the same database with `Agent.open()` and call
`agent.conversations.open(agentConversationId)` to continue its active provider thread.
`Agent.close()` interrupts live prompts and waits for their finalization and queued
conversation writes before closing the SQLite backend; an interrupted prompt may reject.

A newly created conversation may expose `conversation.internalSessionId` immediately, but
the provider attachment is retained only in memory until its first completed provider turn.
If the conversation stops before then, reopening the durable `agc-*` conversation creates a
fresh provider thread. After a completed turn, the provider mapping becomes the continuation
candidate used by `open()`; successfully loading it does not create another history row.
This is a local evidence threshold, not a guarantee that the harness will keep the provider
session loadable forever.

### Attach consumer data to a prompt message

The object-form prompt APIs attach opaque JSON to the submitted **user message**:

```ts
await conversation.prompt({
  text: "hello",
  consumerMetadata: { deliveryId: "delivery-42", submittedBy: "relay" },
});
await conversation.promptFrom({
  participantId: "agent-bob",
  text: "Can you review this?",
  consumerMetadata: { deliveryId: "delivery-43" },
});

const messages = await agent.persistence.messages.list(conversation.id);
console.log(messages.messages[0]?.consumerMetadata);
```

The older positional `prompt(text, handlers?, attachments?)` and
`promptFrom(participantId, text, handlers?, attachments?)` calls remain valid.
`consumerMetadata` is stored in `conversation_messages.consumer_metadata_json` and
returned as `MessageRecord.consumerMetadata`; it is not copied onto assistant messages,
sent to the provider, added to identity context, or indexed for search. The library does
not interpret its fields. The separate envelope `metadata` field still carries older
library-owned operation correlation. A raw audit capture includes consumer metadata;
content/metadata audit capture omits it.

SQLite keeps ordering and type-specific content separate. `conversation_records` is a
narrow canonical envelope containing the conversation-local sequence, kind, timestamp,
operation correlation, and optional metadata. Every envelope has exactly one typed detail
row in tables such as `conversation_messages`, `conversation_tool_call_events`, or
`conversation_activity_events`. A mixed timeline is read as one envelope page followed by
bounded, batched subtype hydration; it never performs one query per record.

Messages store ordinary text directly in `content_text`; structured or multimodal content
uses `content_json`. Tool calls, permissions, configuration, actions, thinking, and
activities retain meaningful lifecycle transitions as independently sequenced records.
Raw ACP protocol bodies remain JSON because their external shape is intentionally open.
Each completed metered operation adds an ordered `metering` reference whose complete
financial record remains in `metering_records`; the timeline does not duplicate billing
payloads.

`activity` is reserved for model activity such as plans. Complete session observations
such as usage, available commands, mode/config announcements, session metadata, echoed
user messages, and unknown protocol updates are not reclassified as model activity.
Their semantic state is retained by the relevant configuration, metering, or checkpoint
storage, while consumers that need exact diagnostic traffic can enable protocol capture.

SQLite protocol capture supports `"none"`, `"metadata"`, and `"raw"`; protocol
`"content"` is rejected because coalesced content already belongs to the typed semantic
records. Exact method filters provide a compact protocol skeleton without persisting the
high-volume update stream:

```ts
capture: {
  protocol: {
    level: "metadata",
    excludeMethods: ["session/update"],
  },
}
```

`includeMethods` is also available and cannot be combined with `excludeMethods`. Both use
exact ACP method names. Methodless JSON-RPC responses remain captured because their method
cannot be determined without correlating request IDs. Filtering happens before canonical
sequence allocation, so omitted frames create neither rows nor sequence gaps.

FTS5 indexes deliberately extracted searchable text rather than serialized record JSON.
The initial indexes cover messages, tool calls, and activities. Consumer metadata and raw
protocol bodies are not searched implicitly.

Schema version 11 adds stable assistant-message identities and migrates version-8,
version-9, and version-10 agent databases in place. Version 10 added message consumer
metadata. Pre-release version-7 SQLite files are not migrated because
they were used only by development smoke tests; opening one gives a recreate instruction.

### Read SQLite conversation history and previews

`records.listRecent()` returns the newest matching records at a fixed conversation
sequence snapshot. Each page is oldest-first for rendering; its `olderCursor` stays
bound to that snapshot and kind filter even if new records arrive:

```ts
import { reconcileConversationTimeline } from "@qlairoslabs/acp-client";

const first = await agent.persistence.records.listRecent!(conversation.id, { limit: 50 });
let items = reconcileConversationTimeline([], first.records);
const older = first.olderCursor
  ? await agent.persistence.records.listRecent!(conversation.id, {
      limit: 50,
      olderCursor: first.olderCursor,
    })
  : null;
if (older) items = reconcileConversationTimeline(items, older.records);
```

Every physical record has a stable `recordId` and a conversation-local `sequence`.
The reconciliation helper keeps distinct messages separate and groups revisions of an
assistant message, tool call, permission, thinking block, activity, or transition by its
logical ID. Assistant snapshots take their position from the first streamed text; the
completed revision supplies their final content and status. Providers that expose a
message only in the final prompt result cannot supply an earlier position. Records
written before schema version 11 have no such boundaries to reconstruct. The helper's
items retain every revision, carry the latest merged fields in `current`, and sort by
the earliest loaded sequence. Loading an older page may move an item to its true
earlier position when its first revision arrives. Configuration, protocol, agent
actions, and metering references remain individual records unless they have an
explicit logical identity; metering details are read from `persistence.metering`.

For live reconciliation, subscribe to `agent.events` (see below) before the initial read if
immediate UI feedback matters, but treat live notifications as hints. The authoritative
catch-up is `records.list(conversation.id, { afterSequence: lastSeenSequence, limit: 100 })`.
Advance `lastSeenSequence` to the last returned record and repeat until the page is
short. Upsert by `recordId` through `reconcileConversationTimeline`; after a process
restart, catch up from the last sequence the consumer retained. Process-local notification
counters are **not** SQLite conversation sequences.

Use one batched preview read for a conversation list:

```ts
const page = await agent.conversations.listPreviews({ limit: 50 });
for (const { conversation, latestMessage, lastHumanMessageAt } of page.previews) {
  renderConversationRow(conversation.id, latestMessage?.text, lastHumanMessageAt);
}
```

`latestMessage` has its stable record ID, role, participant ID, timestamp, sequence,
and up to 240 characters of preview text. `lastHumanMessageAt` includes only messages
whose participant kind is `user`, not agent-to-agent prompts whose message role is
also `user`. SQLite maintains that timestamp on conversation writes and backfills it
once for pre-version-10 databases; preview reads do not rescan long message histories.
Preview paging follows conversation `updatedAt` order; that list may
reorder as conversations advance, so consumers should refresh it rather than treat
offset cursors as a frozen snapshot. `messages.list()` returns the latest visible
revision per logical message; `records.list()` and `records.listRecent()` retain all
physical revisions for timeline reconstruction and audit. `listRecent` and `listPreviews` are SQLite
capabilities; custom persistence backends may not implement them.

### Live committed-record events

`agent.events` is a process-local stream of canonical conversation records, published only
after the transaction that wrote them commits. It is not durable and has no replay: it is
the live half of the same stream `records.list()` returns, so a UI can render immediately
and still reconcile against SQLite.

```ts
const unsubscribe = agent.events.subscribe((notification) => {
  const record = notification.event.record; // the exact persisted record
  applyToTimeline(record);                  // upsert by recordId, as a reload would
}, {
  conversationIds: [conversation.id],
  recordKinds: ["message", "tool_call", "permission", "activity"],
});
// later:
unsubscribe();
```

Each event carries the record's stable `recordId` and conversation `sequence`. Evolving
records (streaming messages, tool calls, activities, thinking) emit one event per physical
revision, so reconcile by the same logical identity a reload uses.
`notification.deliverySequence` orders live events for one process but is not a durable
cursor.

Bootstrap without losing events: subscribe first, buffer, read history, then deduplicate by
`recordId`:

```ts
const pending: ConversationRecord[] = [];
const unsubscribe = agent.events.subscribe(({ event }) => pending.push(event.record), {
  conversationIds: [conversation.id],
});
const page = await agent.persistence.records.listRecent!(conversation.id, { limit: 50 });
let items = reconcileConversationTimeline([], [...page.records, ...pending]);
```

After a restart or a missed window, catch up from SQLite with
`records.list(conversation.id, { afterSequence: lastSeenSequence })`. Filters are fixed for
the life of a subscription: omitting a list selects everything, an empty list selects
nothing, and an unknown `recordKinds` value throws at subscribe time. Filtering never
changes capture, audit, persistence, or another subscriber. A subscriber that throws is
logged and ignored; it cannot fail the operation that produced the record.

`agent.events` reports committed records only. Provisional live data — response chunks,
turn and state changes, handoff progress — still arrives through the prompt handlers and
`conversation.subscribe()`. A record may appear in both at different stages: a tool update
first streams provisionally, then arrives as a committed `tool_call`. Detached
`AgentConversation` instances without an owning `Agent` are outside this bus, and a
consumer-direct `persistence.records.append()` is not observed.

### Conversation error records

Important runtime failures are stored as an immutable `error` record in the same ordered
timeline as messages, activities, and metering references — and delivered live through
`agent.events`. An error is a system timeline item, not a message:

```ts
const errors = (await agent.persistence.records.list(conversation.id, {
  kinds: ["error"],
})).records;

for (const record of errors) {
  if (record.kind !== "error") continue;
  // record.source, record.code, record.recoverability, record.message
  // record.operationId / transitionId / internalSessionId correlate it with the failure
}
```

`source` is one of `provider_session`, `transport`, `operation`, `recovery`. `code` is an
open string; the library exports `CONVERSATION_ERROR_CODES` for the codes it owns and
readers must tolerate unknown future values. `recoverability` describes the failed
operation, not a promise:

- `retryable` — repeating the same action may succeed.
- `recoverable` — another action (checkpoint recovery, a fresh provider session) may
  continue the logical conversation.
- `terminal` — the library knows of no supported continuation.
- `unknown` — evidence is insufficient to choose.

`message` is a sanitized display fallback; it never carries a stack trace, credentials, a
prompt, environment values, or a raw provider payload. At raw capture, allow-listed
provider detail is available in `details`. Canonical capture defaults to
`capture.error = "content"` (metadata drops the message; `none` stores nothing); the audit
destination has its own independent `auditLog.capture.error`.

A failed `conversations.open()` throws `ProviderSessionError` instead of returning a
conversation. It carries the same `code`, `attemptId`, `recoverability`, and — when
canonical capture accepted it — `recordId` as the durable row, plus
`agentConversationId` (always, even for a generated id) so the caller can find the
conversation. If writing the record also fails, that failure is attached as
`recordingError` and the provider diagnosis stays primary. The failed provider mapping is
kept as evidence and is not deleted; recovery or a future fresh-session operation
supersedes it. A `session/load` failure that is recoverable and has a usable checkpoint
still recovers, with the error recorded before the recovery action.

### Append an assistant message without a turn

`conversations.appendAssistantMessage()` adds a completed assistant message the provider
did not produce — for example, a notification the agent sends from another channel. It
runs no turn and needs no live provider session:

```ts
const record = await agent.conversations.appendAssistantMessage(conversation.id, {
  text: "Your build finished; 3 tests failed.",
  consumerMetadata: { kind: "send_message_to_user" },
});
```

The record is an ordinary `message` with `role: "assistant"` and `status: "completed"`,
published on `agent.events` and returned by history reads like any other message. Its
envelope `metadata` carries `origin: "out_of_band"` (exported as
`OUT_OF_BAND_MESSAGE_ORIGIN`; `isOutOfBandMessage(record)` tests it), so readers and
audits can tell it apart from provider output.

The provider learns about it on the conversation's next turn. That turn's provider text
carries every out-of-band message appended since the user message of the last completed
turn, in a `<messages-you-sent>` block between any identity preamble and
`<current-message>`. Only the user's own text is persisted as the user message. Rules:

- A failed turn does not count as delivery; the next turn carries the messages again.
- A message appended while a turn is running reaches the provider on the following turn.
- A recovery seed covers messages through `recoveredThroughSequence`, so they are not
  repeated after recovery. A loaded provider session is treated like one that never
  closed.
- A turn that completes without an assistant message does not advance delivery, so its
  pending messages are repeated once more.
- The block is capped at `OUT_OF_BAND_PROMPT_MAX_CHARS`; the oldest messages are dropped
  first with an omission note. The transcript always keeps all of them.

Other conversations of the same agent see the message through identity like any other
canonical message. Appending requires `capture.message` of `"content"` or `"raw"`, since
the provider could not be told otherwise; it rejects blank text and unknown or deleted
conversations. Backends without `records.listRecent` scan the conversation's messages
forward to find the last completed turn.

### Agent audit log

An SQLite-backed `Agent` can copy selected observations into an independently located,
rotating JSONL audit stream. The stream belongs to the whole agent, so observations from
all of its conversations share one ordered audit sequence. Audit capture is independent
of canonical conversation capture: for example, an application may omit message content
from SQLite while retaining it in the audit destination, or do the reverse.

```ts
const agent = await Agent.open({
  persistence: { kind: "sqlite", path: "/state/atlas.sqlite" },
  adapters: { codex: ADAPTERS.codex },
  auditLog: {
    directory: "/audit/atlas",
    filePrefix: "audit",
    capture: {
      message: "content",
      protocol: {
        level: "metadata",
        excludeMethods: ["session/update"],
      },
    },
    rotation: {
      maxBytes: 64 * 1024 * 1024,
      maxAgeMs: 24 * 60 * 60 * 1_000,
    },
  },
});
```

The default prefix is `audit`. Segments are named `audit.000001.jsonl`,
`audit.000002.jsonl`, and so on. A durable pending outbox in the agent database makes
canonical persistence and audit intent one transaction. A background writer then appends
and syncs those entries without delaying `prompt()`. Delivery is at least once: after a
crash, a physically written entry may be encountered again during reconciliation, and
its stable audit sequence and outbox ID identify the replay.

Observe delivery or explicitly wait for it when an application boundary requires that:

```ts
const unsubscribe = agent.audit?.subscribe((event) => {
  console.log(event.kind, event.snapshot.pendingCount);
});

const snapshot = await agent.audit?.status();
const flushed = await agent.audit?.flush({ timeoutMs: 10_000 });
if (flushed?.status === "blocked") {
  // Repair or restore the destination before reopening the agent.
}

await agent.audit?.retry(); // manually end retry backoff after a transient failure
unsubscribe?.();
```

`Agent.close()` makes a bounded flush attempt using `shutdownGraceMs` (two seconds by
default), then releases the audit destination and agent database. Pending rows remain in
SQLite if the destination was unavailable and resume on the next open.

Read the stream without opening its agent database:

```ts
const reader = await AgentAuditLogReader.open({
  directory: "/audit/atlas",
  filePrefix: "audit",
});

const logical = await reader.readPage({ mode: "logical", limit: 100 });
const next = logical.nextCursor
  ? await reader.readPage({ mode: "logical", limit: 100, cursor: logical.nextCursor })
  : null;

// Diagnostic view: preserves physical replay entries instead of deduplicating them.
const physical = await reader.readPage({ mode: "physical", limit: 100 });
```

Logical mode is the normal consumer view and deduplicates the bounded crash-replay
window. Physical mode exposes what is actually present in the segment files. Reader
cursors describe a stable snapshot and fail if required segments have disappeared or
been truncated.

There is one active owner per agent database and one active writer per audit destination.
Opening either concurrently from another process fails with `AgentDatabaseInUseError` or
`AuditLogDestinationInUseError`; this does not restrict concurrent conversations within
the owning `Agent`. A stream whose identity, ordering, or synced history conflicts with
SQLite fails closed with `AuditLogIdentityConflictError` or
`AuditLogHistoryMissingError` instead of silently starting a new history.

The initial Agent audit design deliberately accepts these constraints:

- Configuration is fixed while the agent is open. Close and reopen to change it.
- Every numbered segment remains part of the logical stream; automatic audit retention
  and deletion are not provided.
- Time-based rotation is checked when an entry is delivered, so an idle segment is not
  rotated merely because time passed.
- Disabling audit and later enabling it creates a new stream from that point; canonical
  history is not backfilled.
- JSONL is plaintext and not cryptographically signed. Protect, archive, and retain the
  destination according to application policy.
- Durability currently favors an entry-level sync boundary. Raw protocol capture can
  therefore create backlog under sustained high-volume streaming; exclude
  `session/update` or use metadata/semantic capture unless exact raw traffic is required.

SQLite remains the source used for conversation recovery. Audit segments are an
independent operational history and are not imported to reconstruct provider sessions.
This API is distinct from the legacy `AuditLogReader` documented under
“Configure transcripts” below, which reads per-`AgentSession` v1 audit files.

The minimal end-to-end executable example is
[`smoke-tests/end-to-end/index.ts`](./smoke-tests/end-to-end/index.ts). It sends `"hi"`
through an ACP harness and independently queries SQLite to assert that the canonical
user-message row contains `"hi"`:

```bash
bun smoke-tests/end-to-end/index.ts
```

By default it owns and removes a temporary directory. Set `ACP_TEST8_DATA_DIR` to retain
the database at a caller-selected location for inspection:

```bash
ACP_TEST8_DATA_DIR=./smoke-tests/test8-test/data \
  bun smoke-tests/end-to-end/index.ts
```

The smoke scenario uses a 64 MiB audit segment limit by default, so a short run may
produce only one segment. To assert rotation with a deliberately small test threshold,
set `ACP_TEST8_AUDIT_MAX_BYTES=1024`. This is a test override, not a suggested
production setting.

The current smoke scenario defaults to Codex because its second process opening verifies
that the provider thread remembers prior conversation context. It may use credentials and
consume model tokens.

Provider-session identity and persisted history are always hard assertions. Exact semantic
recall is also required by default for Codex, while other adapters report a warning because
their selected model may ignore correctly loaded context. Set
`ACP_TEST8_REQUIRE_SEMANTIC_RECALL=1` to require the exact recall assertion for any adapter,
or `0` to make it observational.

### SQLite metering persistence

SQLite-backed agents always persist the bounded metering state needed to restore lifetime
totals and the active provider-counter baseline. By default they also retain every complete
`OperationMeteringRecord` locally:

```ts
const agent = await Agent.open({
  persistence: { kind: "sqlite", path: "/state/atlas.sqlite" },
  adapters: { codex: ADAPTERS.codex },
  defaultAdapterId: "codex",
  meteringPersistence: {
    meteringRecords: "all", // default
  },
});

const page = await agent.persistence.metering.list(conversationId);
const records = page.records;
const state = await agent.persistence.metering.state(conversationId);

// Internal work not caused by a conversation has a separate agent-level scope.
const internalState = await agent.persistence.metering.agentState(agent.id);
const internalRecords = await agent.persistence.metering.listAgent(agent.id);
```

Consumers with a separate authoritative billing store can omit the detailed local history:

```ts
meteringPersistence: {
  meteringRecords: "none",
}
```

`"none"` still writes a minimal operation marker for idempotency, adds the independently
configured conversation-timeline reference, and always advances the bounded restoration
state. It only omits the full serialized metering record. Continue to
consume `result.metering` or `metering_recorded` notifications when delivering records to
an external billing repository.

### Run durable internal inference

`internalInference` is agent-scoped background model work for checkpoint, recovery, and
identity features. It is not a participant turn and does not write its prompt or output
into the visible transcript. Attempts are queued in SQLite, leased to one worker, retried
with a new `aii-…` attempt ID, observable, cancellable, and resumed when the database is
reopened.

Consumers register versioned strategies. A strategy derives a prompt from durable input,
then validates and publishes the result inside the transaction that completes the attempt.
The generic runtime deliberately does not define checkpoint or identity artifact schemas.

```ts
import {
  ADAPTERS,
  Agent,
  HarnessInternalInferenceRuntime,
  type InternalInferenceStrategy,
} from "@qlairoslabs/acp-client";

const strategy: InternalInferenceStrategy<{ throughSequence: number }> = {
  strategyId: "checkpoint-v1",
  purpose: "conversation_checkpoint",
  version: 1,
  validatePayload(value) {
    const sequence = (value as { throughSequence?: unknown }).throughSequence;
    if (!Number.isSafeInteger(sequence)) throw new Error("invalid sequence");
    return { throughSequence: sequence as number };
  },
  async prepare(context, input) {
    const page = await context.persistence.messages.list(context.attempt.agentConversationId!, {
      throughSequence: input.throughSequence,
    });
    return {
      prompt: `Summarize this conversation. Do not use tools.\n${JSON.stringify(page.messages)}`,
    };
  },
  async complete(context, result) {
    // Validate and write the artifact through context.persistence here.
    return {
      internalInferenceId: result.internalInferenceId,
      rootInternalInferenceId: context.attempt.rootId,
      internalSessionId: result.internalSessionId,
      purpose: context.attempt.purpose,
      completedAt: new Date().toISOString(),
    };
  },
  classifyError() {
    return { kind: "retryable", code: "provider_failure" };
  },
};

const runtime = new HarnessInternalInferenceRuntime({
  controllerConfig: (request) => ({
    adapter: ADAPTERS.codex,
    adapterId: request.adapterId,
    cwd: process.cwd(),
  }),
});

const agent = await Agent.open({
  persistence: { kind: "sqlite", path: "/state/atlas.sqlite" },
  adapters: { codex: ADAPTERS.codex },
  defaultAdapterId: "codex",
  internalInference: {
    runtime, // optional; omit to use the agent's harness adapter and runtime defaults
    strategies: [strategy],
    adapter: "same",
    maxConcurrency: 1,
    retry: { maxAttempts: 3, backoffMs: [1_000, 10_000, 60_000] },
    retention: { retain: 100 },
  },
});

const run = await agent.internalInferences!.enqueue({
  purpose: "conversation_checkpoint",
  agentConversationId: conversation.agentConversationId,
  input: {
    strategyId: "checkpoint-v1",
    version: 1,
    payload: { throughSequence: 42 },
  },
  requestedThroughSequence: 42,
});

const unsubscribe = run.subscribe(({ snapshot }) => {
  console.log(snapshot.stage, snapshot.status);
});
const completion = await run.result;
unsubscribe();
```

The harness runtime starts a fresh disposable provider session and inherits the supplied
launcher, environment, working directory, and container boundary. Empty MCP/client
handlers and cancelled permission requests do not disable filesystem or terminal tools
built into the harness; enforce that boundary with the launcher or container when needed.
Custom runtimes should call `lifecycle.sessionStarted(...)` before prompting so strict
metering preflight can run. Completed custom results are metered as a fallback.

### Generate recovery checkpoints and recover missing provider sessions

Enable `checkpointing` on an SQLite-backed `Agent` to generate rolling continuation
summaries outside the visible provider thread:

```ts
const agent = await Agent.open({
  persistence: { kind: "sqlite", path: "/state/atlas.sqlite" },
  adapters: { codex: ADAPTERS.codex },
  defaultAdapterId: "codex",
  checkpointing: {
    schedule: {
      milestones: [1, 5, 10, 15, 30, 50],
      everyAfterMilestones: 50,
    },
    recovery: {
      onLoadFailure: "recover", // default
      maxTailMessages: 100,
    },
  },
});
```

Checkpoint generation is durably enqueued after the configured successful response counts;
the visible prompt does not wait for the summary model call. Each new checkpoint combines
the previous summary with canonical records added since its covered message boundary.
Checkpoint artifacts and their `conversation_checkpoint` timeline actions are committed in
the same transaction as the generating internal inference.

```ts
const checkpoint = await agent.checkpointing!.latest(conversationId);

// Explicitly request a checkpoint outside the configured milestones.
await agent.checkpointing!.request(conversationId);
```

When `conversations.open()` cannot load the recorded provider session and the error is
classified as a missing session, the agent creates a fresh provider thread and privately
seeds it from the latest checkpoint plus canonical messages written after that checkpoint.
The seed is metered as `conversation_recovery` and recorded as a native action; it is not a
user or assistant transcript message.

```ts
const opened = await agent.conversations.open(conversationId, {
  onRecoveryProgress(event) {
    console.log(event.stage, event.checkpointId);
  },
});

if (opened.providerSession === "recovered") {
  console.log(opened.recovery);
}
```

ACP does not standardize missing-session errors. The default classifier recognizes common
“session not found,” “does not exist,” and missing Codex rollout-path failures. A harness
with different errors can provide `recovery.isMissingProviderSession(error)`. Authentication,
network, and arbitrary internal failures remain fatal by default. Set `onLoadFailure:
"error"` to disable automatic recovery.

Checkpointing requires message capture at `"content"` or `"raw"`. The checkpoint is a
continuation aid, not the authoritative transcript: complete messages and other records
remain independently queryable from SQLite.

### Share a basic identity across conversations

Checkpoint-backed identity is opt-in. It privately delivers knowledge from an agent's
other conversations to each provider thread, using the existing per-conversation
checkpoint summaries and messages after those checkpoints:

```ts
const agent = await Agent.open({
  persistence: { kind: "sqlite", path: "/state/atlas.sqlite" },
  adapters: { codex: ADAPTERS.codex },
  defaultAdapterId: "codex",
  checkpointing: {},
  identity: {
    kind: "checkpoint-backed",
    maxContextChars: 32_000,
    maxSourceChars: 8_000,
  },
});
```

The first prompt to a provider thread receives each other conversation's latest
checkpoint summary plus its uncovered messages. Later prompts receive only messages
not yet delivered to that thread. Successful prompts advance sparse, durable cursors;
failed prompts do not. A new provider thread gets a fresh identity view, while loading
the same provider thread reuses its cursors. The current conversation never receives
its own history through identity; normal provider continuity and recovery handle that.

The character budgets are hard limits, not claims that all agent knowledge fits. When
the backlog is too large, the runtime delivers an ordered prefix and leaves the rest
pending. It may request a checkpoint in the background to compress an oversized gap.
`identityConsistency: "through-current"` rejects a prompt whose available cross-
conversation messages cannot all fit; the default `"eventual"` permits partial delivery.
All non-deleted conversations are shared in v1, including conversations with different
users, so consumers should enable this only where such cross-conversation visibility is
appropriate. A custom `AgentIdentityRuntime` remains available for other policies.

## Legacy direct and managed sessions

The remaining sections describe the compatibility `AgentSession` and
`SessionManager`/JSONL APIs. They remain useful when an application needs a transient
connection or the existing file-oriented persistence model.

Interactive helpers are a separate entry point:

```ts
import {
  createAgentSessionCommands,
  dispatchReplInput,
  getAgentSessionCommands,
  parseReplInput,
  runAgentSessionRepl,
} from "@qlairoslabs/acp-client/repl";
```

## Resolve adapters in the consumer

An adapter only tells the library how to launch a harness. Capabilities, authentication,
configuration, and harness commands are discovered after ACP initialization.

```ts
const adapters: Record<string, Adapter> = {
  opencode: ADAPTERS.opencode,
  codex: ADAPTERS.codex,
  claude: ADAPTERS.claude,
  pi: ADAPTERS.pi,
  internal: {
    command: ["internal-agent", "--acp"],
    ptyCommand: ["internal-agent"],
    displayName: "Internal agent",
  },
};

function resolveAdapter(adapterId: string): Adapter {
  const adapter = adapters[adapterId];
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
  return adapter;
}
```

The managed registry stores `adapterId`, not executable configuration or credentials.
Consequently, loading a session still requires the consumer to resolve that ID.

## Choose direct or managed sessions

Use a direct `AgentSession` when the application wants a transient ACP connection or owns
all persistence externally. Direct sessions perform no V2 persistence by default.

Use `SessionManager.open()` when the library should maintain a durable logical-session
registry and transcripts. Calling `SessionManager.open()` is the opt-in to managed local
persistence.

For most orchestrators, the managed path is the recommended starting point.

## Open a managed session manager

```ts
const sessions = await SessionManager.open({
  root: "/absolute/path/to/application-state",
  sessionDefaults: {
    transcript: { preset: "activity" },
    auditLog: false,
  },
});
```

Root resolution is:

1. An explicit `root`.
2. `ACP_CLIENT_HOME`.
3. `~/.acp-client`.

The default managed configuration enables an `activity` transcript and disables the
independent audit log. A session can override manager defaults unless a manager constraint
forbids the resulting configuration. For example, a product that must always retain
continuation history can separately set `sessionConstraints.transcript` to `"required"`;
that manager will intentionally reject the registry-only example below.

## Create a managed logical session

```ts
async function createSession(adapterId: string): Promise<AgentSession> {
  const session = await sessions.createAgentSession({
    adapter: resolveAdapter(adapterId),
    adapterId,
    cwd: process.cwd(),
    title: "Repository agent",
    defaultPermission: "cancel",
    persistence: {
      transcript: { preset: "activity" },
    },
    onOpenProgress: projectOpenProgress,
  });

  liveSessions.set(session.agentSessionId, session);
  return session;
}

function projectOpenProgress(event: AgentSessionOpenStage): void {
  // Project this ephemeral event into your own UI/WebSocket protocol.
  console.log(event.stage, event);
}
```

`agentSessionId` and `creationId` are generated when omitted. A consumer that needs
idempotent retries across process failure may supply stable values itself.

To create a registry-only session:

```ts
const session = await sessions.createAgentSession({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  persistence: {
    transcript: false,
    auditLog: false,
  },
});
```

Registry-only mode preserves continuation state but not conversational history. It cannot
reconstruct the conversation if the provider thread becomes unavailable.

Managed creation and loading currently require normal ACP mode. Managed degraded/PTY
sessions are not implemented.

## Prompt and stream a turn

```ts
const handlers: PromptHandlers = {
  onChunk: (text) => process.stdout.write(text),
  onActivity: (event) => renderActivity(event),
  onRecord: (record) => publishFoldedActivity(record),
  onPermissionRequest: (request) => {
    const allow = request.options.find((option) => option.kind === "allow_once");
    return allow
      ? { outcome: "selected", optionId: allow.optionId }
      : { outcome: "cancelled" };
  },
};

const result = await session.prompt("Inspect the failing tests.", handlers);

console.log(result.status);
for (const message of result.messages) {
  renderAssistantMessage(message);
}
// Only when this consumer explicitly needs one string:
console.log(formatResponseMessages(result.messages, "\n\n"));
console.log(result.operationId);
console.log(result.metering);
```

Prompts, configuration changes, handoffs, and other mutations are serialized by each
`AgentSession`. Multiple different `AgentSession` objects may operate concurrently.

`result.messages` is the canonical response. A prompt operation may contain several
distinct assistant messages; render them separately when the UI supports that. The
deprecated `result.text` property is only a compatibility projection and inserts a blank
line between messages. `formatResponseMessages()` makes any deliberate flattening policy
consumer-owned.

## Send a message while a turn is running

A prompt sent while a turn runs waits. How it waits is its **delivery**:

- `"queue"` (the default): it runs after the running turn ends, as its own turn.
- `"steer"`: it is delivered at the next tool boundary. The library cancels the running turn once a
  tool call has settled and nothing else is running, then sends the message, so the agent gets the
  information without losing the work it has done. If the turn ends first, the message is sent as the
  next prompt, so a message is never delivered later than the end of the turn. A text-only turn is not
  cut short: use `interrupt()` for that.

```ts
const turn = conversation.prompt("Refactor the parser.");

// A second message, sent while the first turn is running.
const note = conversation.prompt({ text: "Also keep the public API unchanged.", delivery: "steer" });

const first = await turn;   // stopReason "cancelled", endedBy "steer", followedBy [note.id]
const answer = await note;  // the turn that carried the message
```

`prompt()` and `promptFrom()` return a handle: the promise of that prompt's result, plus `id` and
`withdraw()`. A prompt that does not have to wait runs immediately and `delivery` has no effect.

Set the default for prompts that do not say, per Agent or per conversation. It is `"queue"` unless you
change it:

```ts
const agent = await Agent.open({
  // ...
  conversationDefaults: { busyDelivery: "steer" },
});
```

### What waits, and in what order

The conversation keeps one FIFO. A `steer` message is appended like any other, so a `queue` message sent
earlier keeps its place ahead of it. At a boundary the library only delivers a message if the head of the
queue is a `steer` message.

**Consecutive `steer` messages at the head are sent as one prompt**, so the agent sees the whole
correction at once:

```text
> working...
Also, remember x
and y
and z
no, actually forget about y and z      <- the agent receives all four together
```

The text is the messages in order, separated by a blank line; the library adds nothing, not even sender
names. It is one operation with one metering record, and every message's promise resolves with the same
result. Each original message is still stored as its own user message, with its own `participantId` and
`consumerMetadata`, so a consumer can render or filter them from its own metadata. Each message's
streaming handlers receive the events of the shared turn.

```ts
conversation.pendingMessages;           // what waits, in the order it will be sent
conversation.withdraw(note.id);         // take a message back; also note.withdraw()
conversation.interrupt();               // cancel now; pending steer messages are then sent
conversation.interrupt({ clearQueue: true });   // cancel and drop what waits
```

A withdrawn or dropped message settles as a cancelled prompt (`stopReason: "cancelled"`, `usage: null`,
`metering: null`).

### Events and results

Messages that had to wait emit events on the conversation event stream:

| Event | Meaning |
|---|---|
| `message_pending { id, delivery }` | Accepted and waiting. `delivery` is the mode in effect: `"queue"` while the running operation is not a consumer prompt turn (a handoff, a configuration change). |
| `message_delivered { ids, via, turnId }` | Sent to the agent. `ids` lists every message in the prompt; `via` is `"tool_boundary"`, `"interrupt"` or `"turn_end"`. |
| `message_withdrawn { id }` | Removed before delivery. |

A turn cancelled by steering or by `interrupt()` carries `endedBy: "steer" | "interrupt"` and
`followedBy` (the messages sent after it). They are set only when the provider really stopped the turn:
if the turn finished by itself before the cancel took effect, neither is present.

### Limits to know about

Cancelling is the only control ACP offers during a turn, so what a harness does with the cancelled turn
is its own. Measured with the `test11-steerTurn` smoke test:

- Work the agent has completed is kept: the follow-up continues the task rather than restarting it.
- Codex: a shell command already running keeps running after the cancel, and text the agent was
  streaming when cancelled is dropped from its context. OpenCode aborts the command.
- Usage reported over ACP for a cancelled turn is unreliable (OpenCode reports 0 over ACP for a turn
  whose inference had completed). Only a certified metering integration sees the real spend, so with
  plain ACP telemetry a steered conversation can under-count the cancelled turn.
- Codex reports usage in a way the cumulative-counter check can reject: the turn after a cancel was
  recorded with status `counter_reset` and no attributed tokens in testing. This looks like a property of
  Codex usage reporting rather than of steering (see the `s9` control in `test11-steerTurn`).
- `status` and the stored message status follow what the provider reported: a turn the provider ended
  normally despite a late cancel is `completed`, and `endedBy` is absent.
- Pending messages live in memory only. They are lost if the process stops, like queued prompts.

## Adopt a session the provider already holds

A harness may hold sessions this library did not create (made in its own UI, by another client, before the
conversation existed here). `agent.conversations.create({ adopt })` brings one in as a conversation of the Agent: it
is created around the session and loaded with `session/load` instead of starting a new provider thread.

```ts
// Which sessions does the provider hold, and which are already owned by a conversation?
const sessions = await agent.conversations.listProviderSessions({ limit: 20 });
for (const session of sessions) console.log(session.providerSessionId, session.title, session.adoptedBy);

const conversation = await agent.conversations.create({
  adopt: { providerSessionId: sessions[0].providerSessionId },
});
await conversation.prompt("Where were we?"); // continues the provider's own session
```

`listProviderSessions({ adapterId?, cwd?, limit? })` starts the harness for the call and asks it (`session/list`, so
the provider decides the order and which sessions it reports). It throws `ProviderSessionListUnsupportedError` if the
agent does not advertise `session/list`.

### What adopting stores

The provider keeps the history; adoption does not copy it unless asked.

| option | effect |
|---|---|
| `importHistory: true` / `{ last: n }` | Also store the history the load replays: messages, tool calls and thoughts, through the same capture policy as a live turn (a kind the conversation does not capture is not stored). A turn starts at each user message. Stored records are marked `imported: true` and carry the time of the import, since a replay has no timestamps. |
| `recap: true` | Ask the model to summarize its own history, as a hidden turn on the adopted session, and store the answer as an assistant message (`origin: "adoption_recap"` in its metadata) ahead of the imported turns. It is not shown as a user message, and `create()` returns once it is answered. The model decides how to compress a long history. |

Defaults: when the Agent has an identity runtime that shares conversations, `recap` is on and the last two turns are
imported; otherwise nothing beyond what happens from now on is stored. A recap lets the Agent's *other* conversations learn
about this one: identity delivers stored messages to them. A recap that fails is recorded as an error
(`adoption_recap_failed`, retryable) and the conversation still works, but is not in the Agent's memory.

Adopting needs the conversation to capture messages at `content` or `raw` (otherwise it would join the Agent's memory
empty); a conversation that must store nothing is driven with `acp-client` instead. A conversation persistence resolver can
tell an adopted conversation by `adopted: true` in its context and choose what it stores.

### Failures and ownership

- **One owner.** A provider session can belong to one conversation. Adopting one that another conversation owns (or has
  asked to adopt) throws `ProviderSessionInUseError`, whose `ownedBy` names it, so a UI can open that one instead. The check
  and the new row are one transaction. Deleting the conversation frees the session. A persistence backend that cannot tell
  who owns a session cannot adopt one.
- **The session cannot be loaded** (it no longer exists, the agent does not support `session/load`, degraded mode): a
  `ProviderSessionError` is thrown and the failure is recorded, and the conversation row **stays**. Opening that conversation
  later retries the load of the session it asked for; it never starts a new session in its place. Retrying records the
  session on success but does not repeat the history import or the recap.
- **After a restart** an adopted conversation opens like any other: by loading its recorded provider session.

### Limits to know about

- Replays differ by harness (measured on Codex and OpenCode with `smoke-tests/session-replay-probe`): both send message
  boundaries, tool calls and, for OpenCode, thoughts; neither sends timestamps or usage. Codex replays the tool call of a turn
  that was cancelled mid-tool after the next turn's user message, and it is imported where it arrives.
- The recap is a hidden turn on the adopted session itself, so the provider's own history then contains the question and the
  answer. The model is asked not to use tools; ACP gives no way to forbid them for one turn.
- With `importHistory: true`, every imported message is also delivered to the Agent's other conversations (within identity's
  budget): prefer the default tail with a recap for long sessions.
- The first prompt after an adoption runs on a thread whose usage counters did not start at zero, so its metering is
  attributable only after a baseline.

## Clear a transcript, delete a conversation

```ts
// Remove what is stored, keep the conversation (its title, participants and provider session).
await agent.conversations.clearTranscript(id);                    // { recordsDeleted, checkpointsDeleted: 0 }
await agent.conversations.clearTranscript(id, { checkpoints: true }); // also its recovery checkpoints

// Delete the conversation; optionally ask the provider to delete its session too.
const { providerDeleted } = await agent.conversations.delete(id, { providerSession: "best-effort", checkpoints: true });
// providerDeleted: true | "unsupported" | false
```

`clearTranscript` physically deletes every stored record of the conversation (messages, tool calls, and the rest). It
refuses a conversation that is running an operation. Sequence numbers are not reused, so new records continue after the
deleted ones. `delete` is a soft delete as before (the records stay, the conversation stops being listed, and a provider
session it owned can be adopted again); a string second argument is still read as the deletion time.

Both are **local** deletions, not forgetting:

- The provider's own session is untouched unless you ask `delete` for `providerSession: "best-effort"`. That sends
  `session/delete`, which not every agent offers: Codex advertises it, OpenCode does not (`"unsupported"`). A failure is
  reported as `false` and does not undo the local deletion.
- Recovery checkpoints summarize the records being deleted. They are kept unless `checkpoints: true`, so by default the Agent's
  other conversations can still receive a summary of cleared content.
- Audit entries already written, content already delivered into other conversations, and identity state derived from the
  records are not removed. No event is published when records are deleted, so a UI has to refresh.

## Observe state, context, and usage

Read a snapshot first, then subscribe to changes:

```ts
publishState(session.state);

const unsubscribe = session.subscribe((notification: AgentSessionNotification) => {
  publishNotification(notification);

  if (notification.event.kind === "state_changed") {
    publishState(notification.event.state);
  }

  if (notification.event.kind === "metering_recorded") {
    persistBillingMetadata(notification.event.record);
  }

  if (notification.event.kind === "presentation_recorded") {
    upsertChatItem(notification.event.item.id, notification.event.item);
  }
});
```

`onResponseChunk` and activity callbacks are provisional live streams. A
`presentation_recorded` notification means the displayed item revision has been appended
to the V2 transcript. Its ID, first position, revision, record sequence, and operation ID
are exactly the values the presentation reader returns after a restart. Upsert by `id`
and ignore revisions older than the one already rendered.

Useful live properties include:

```ts
session.state;
session.isBusy;
session.queuedOperationCount;
session.contextWindow;     // active thread only, or null
session.providerCost;      // provider telemetry, not asserted invoice truth
session.meteringSnapshot;  // logical-session totals and coverage
session.model;
session.providerId;
```

`contextWindow` describes the latest usage observation for the active internal thread. It
is cleared after a handoff until the new thread reports its context. Metering totals belong
to the stable logical session and continue across internal-thread changes.

Each completed token-consuming operation carries its own `OperationMeteringRecord`. Store
that record in the consumer's billing or analytics system if it is financially relevant;
do not use the transcript as an authoritative billing ledger.

Metering defaults to `best_effort` with the pinned models.dev pricing catalog. The other
enforcement modes have narrower meanings:

- `telemetry_required` stops after missing or invalid ACP usage, but ACP telemetry is not a
  billing guarantee.
- `billing_required` requires a registered certified per-inference integration. Plain ACP
  usage can never satisfy it.

```ts
const session = await sessions.createAgentSession({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  metering: {
    enforcement: "best_effort",
  },
});
```

Subscription authentication is not inferred as a metering mode. Treat subscription usage
as informative telemetry; use a certified integration and consumer-controlled API billing
when token costs must be enforceable.

## Interrupt, stop, and own live objects

```ts
session.interrupt();
session.interrupt({ clearQueue: true });

await session.stop();
liveSessions.delete(session.agentSessionId);
```

`stop()` is terminal for that object. The logical session remains in the manager and can
later be loaded into a new live object.

## List and inspect managed sessions

Listing is cursor-paginated and does not start a harness:

```ts
const page = await sessions.listAgentSessions({
  limit: 100,
  includeDeleted: false,
  order: "updated_desc",
});

for (const item of page.sessions) {
  console.log(item.agentSessionId, item.adapterId, item.lifecycle);
}
```

Inspect one session or its current continuation checkpoint:

```ts
const info = await sessions.getAgentSessionInfo(agentSessionId);
const resolved = await sessions.getAgentSessionCheckpoint(agentSessionId);

if (!info || !resolved) throw new Error("Unknown session");

console.log(resolved.source);        // "transcript" or "registry_projection"
console.log(resolved.authoritative);
console.log(resolved.checkpoint.internalSessionId);
```

Maintenance inspection is also offline:

```ts
await sessions.getSessionMaintenance(agentSessionId);
await sessions.listSessionMaintenance({ limit: 100 });
```

A prepared maintenance record means an interrupted create, restore, reconfiguration, or
deletion should be resumed or resolved before ordinary mutations continue.

## Load an existing session

The manager requires the adapter at runtime but selects continuation from persisted state:

```ts
async function loadSession(agentSessionId: string): Promise<AgentSession> {
  const info = await sessions.getAgentSessionInfo(agentSessionId);
  if (!info) throw new Error(`Unknown session: ${agentSessionId}`);

  const opened = await sessions.loadAgentSession(agentSessionId, {
    adapter: resolveAdapter(info.adapterId),
    adapterId: info.adapterId,
    defaultPermission: "cancel",
    onOpenProgress: projectOpenProgress,
  });

  console.log(opened.continuation);
  console.log(opened.recovery);
  console.log(opened.configuration);
  console.log(opened.promptability);
  console.log(opened.repairs);

  liveSessions.set(agentSessionId, opened.session);
  return opened.session;
}
```

Managed creation and loading report the same ordered progress vocabulary:

```text
initializing
→ initialized (ACP capabilities are available)
→ internal_session_acquired (created or resumed)
→ ready (managed persistence is finalized and promptability is known)
```

The callback exists because the live `AgentSession` is not available for subscription
until the operation returns. Progress is ephemeral and is not transcript or registry
authority. A failed operation does not report `ready`, and a retry begins a new sequence.
Callback failures are logged and do not fail or roll back the managed operation.

Loading never silently creates a replacement provider thread. By default it attempts the
persisted `internalSessionId`. If that thread is unavailable, continuation reports the
failure and the returned session may be non-promptable.

For cross-adapter or missing-thread recovery, supply an explicit ordered continuation
strategy, such as a consumer-owned continuation:

```ts
const opened = await sessions.loadAgentSession(agentSessionId, {
  adapter: resolveAdapter(targetAdapterId),
  adapterId: targetAdapterId,
  continuation: {
    strategies: [
      { kind: "load_internal_session" },
      {
        kind: "new_from_consumer_continuation",
        continuationId: "summary-v3",
        continuation: portableSummary,
      },
    ],
  },
});
```

The consumer should always inspect `promptability`. Do not assume that successfully
opening files means the provider state is safe to mutate.

## Resolve recovery and configuration blockers

An uncertain operation boundary is never guessed away. The consumer explicitly decides:

```ts
await session.resolveRecovery({
  strategy: "accept_harness_state",
});

// Or deliberately replace the provider thread:
await session.resolveRecovery({
  strategy: "start_new_internal_session",
  continuation: portableSummary,
});
```

If persisted configuration no longer matches what the harness announces:

```ts
await session.resolveConfigurationMismatch({
  strategy: "accept_effective",
});

// Or apply an exact ordered replacement target list:
await session.resolveConfigurationMismatch({
  strategy: "replace_restoration_targets",
  selections: [
    { configId: "model", value: "anthropic/claude-sonnet-4" },
  ],
});
```

These are separate state machines. Resolving recovery does not implicitly accept a
configuration mismatch.

## Handoff without losing logical identity

```ts
const handoff = await session.handoff();
```

The current thread generates portable continuation context, the library creates a new
thread on the same adapter, and the same `AgentSession` continues:

```ts
handoff.agentSessionId === session.agentSessionId;
handoff.toInternalSessionId === session.internalSessionId;
```

If the consumer already has a summary, bypass summary generation:

```ts
await session.handoff({
  summary: "Objective, decisions, current state, and next steps...",
});
```

V0 handoff uses the current adapter. The default summary-generation and new-thread
introduction prompts are library-defined, and introduction is an ordinary user prompt
because ACP has no portable system-prompt field.

### Provider attachment

A newly created provider thread is not selected for a later open until a provider turn has
completed on it. Until then the running process uses it, but a restart returns to the
previous thread — or, for a conversation that never had one, starts fresh.

`HandoffResult.providerAttachment` reports which of those a transition produced:

```ts
handoff.providerAttachment === "recorded";     // a turn completed on the target
reset.providerAttachment === "runtime_only";   // live on the target, not yet selected
```

A promptless `reset()` has no turn to confirm its target, so it reports `runtime_only` and
the previous thread stays the restart fallback until the next completed prompt. This
describes local state only; it never claims the provider will still accept the session.

`providerAttachment` is a required field, so code that constructs a `HandoffResult` value
itself — rather than consuming one — needs updating. `AgentSessionHandoffError` gained
`fromInternalSessionId`, `toInternalSessionId`, `providerAttachment`, `activationCompleted`,
`summary` and `targetResult`; `activationCompleted` distinguishes a target prompt that
failed after the target was already selected from a transition that never reached one.

Because a transition keeps its source alive until the target is confirmed, both
same-adapter and cross-adapter transitions now run a second provider process for the
duration of the transition.

## Harness configuration and commands

ACP configuration is available through the stable session:

```ts
console.log(session.configOptions);
await session.setConfig("model", "some-model");
await session.authenticate(methodId, { onOutput: showAuthOutput });
```

Configuration selected through `AgentSession` is checkpointed according to the configured
`sessionConfiguration` persistence policy and reapplied during loading.

Harness slash commands are discovered as metadata:

```ts
for (const command of session.internalSessionCommands) {
  console.log(command.name, command.description, command.input?.hint);
}

await session.executeInternalSessionCommand("usage");
await session.executeInternalSessionCommand("status", "verbose");
```

ACP sends a harness command as a prompt. `executeInternalSessionCommand()` makes the layer
explicit and routes it through the logical session's queue, lifecycle, transcript, and
metering machinery. Advertisement is discovery rather than an allow-list.

## Discover commands for a UI

The library exposes command metadata separately for the two local operation layers. A UI
bound to one stable logical session can read the AgentSession command registry:

```ts
const clientCommands = getAgentSessionCommands(session);

for (const command of clientCommands) {
  renderCommand({
    name: command.id,
    description: command.description,
    arguments: command.arguments,
    disabled: !command.available,
    disabledReason: command.unavailableReason,
  });
}
```

This registry contains `/handoff`, `/bridge`, and the introspection commands implemented
by `createAgentSessionCommands()`. Its availability is recomputed from current session
state. `/exit` is intentionally absent because it belongs to a particular REPL, not to an
`AgentSession`.

The lower-level controller exposes its own dynamically negotiated registry:

```ts
for (const command of controller.getCommands()) {
  console.log(command.id, command.description, command.arguments);
  if (!command.available) console.log(command.unavailableReason);
}
```

These are provider-thread and transport controls such as `/load`, `/fork`, `/config`, and
`/degrade`; they are not aliases for logical-session operations. Harness-advertised
commands remain the third source in `session.internalSessionCommands` and are invoked
explicitly with `executeInternalSessionCommand()`. A consumer can merge all three sources
for display while retaining their origin so dispatch never crosses layers accidentally.

## Configure transcripts

Transcripts and audit logs are separate artifacts:

- A transcript supports conversation display, continuation, debugging, and restoration.
- An audit log supports a filtered operational history without copying conversation text.
- The registry is the managed inventory and current routing projection.

Configure them per session:

```ts
const session = await sessions.createAgentSession({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  persistence: {
    transcript: {
      path: "/absolute/path/to/transcripts", // directory or exact file
      preset: "detailed",
      capture: {
        permissions: "decision",
        protocol: "none",
      },
    },
    auditLog: {
      path: "/absolute/path/to/audit",
      capture: {
        tools: "input",
        usage: true,
      },
    },
    sessionConfiguration: {
      values: "typed",
      exclude: ["secret-option"],
    },
  },
});
```

If a configured path is an existing directory, the library derives the filename from
`agentSessionId`. A file path is used exactly. Default managed locations are beneath the
manager root in separate transcript and audit directories.

Available transcript presets are:

| Preset | Intended use |
|---|---|
| `conversation` | User/assistant text with minimal transition metadata |
| `activity` | End-user operation history without reasoning or tool contents |
| `detailed` | Reasoning, tool input/output, and richer transition details |
| `diagnostic` | Full diagnostic capture, including raw protocol records |

Capture filtering happens before persistence. Selecting a more detailed preset is an
explicit decision to persist more sensitive content. Limits and truncation protect record
size; structural identity is never truncated merely to force an invalid record to fit.

The files are plaintext. The library does not provide encryption, tamper resistance, a
billing source of truth, or automatic retention policy. Apply filesystem permissions,
retention, backup, and deletion policy appropriate to the application.

## Read a transcript with pagination

Resolve its authoritative path without starting the harness:

```ts
const resolved = await sessions.getAgentSessionCheckpoint(agentSessionId);
const path = resolved?.checkpoint.transcript?.path;
if (!path) throw new Error("This session has no transcript");

const reader = new TranscriptReader(path);
```

The reader offers three projections:

```ts
const conversation = await reader.readPage({
  view: "conversation",
  limit: 50,
});

const timeline = await reader.readPage({
  view: "timeline",
  types: ["message", "activity", "transition"],
  limit: 50,
});

const records = await reader.readPage({
  view: "records",
  limit: 50,
});
```

For an end-user chat timeline, prefer the folded presentation projection:

```ts
const presentation = await reader.readPresentationPage({ limit: 50 });

for (const item of presentation.items) {
  // message, reasoning, or activity; activity revisions are already folded.
  renderOrReplace(item.id, item);
}
```

`readPresentationPage()` preserves the order in which logical items first appeared. A
tool that settles later keeps its original position, and distinct assistant messages stay
separate around intervening activity. The raw `timeline` view intentionally remains
available when the consumer needs every physical lifecycle revision rather than a chat
projection. Presentation pagination scans the snapshot with bounded item memory and does
not require the consumer to load the entire transcript.

Each page is ordered oldest-first within that page, while the initial page selects the
newest matching records. Navigate using `olderCursor` and `newerCursor`:

```ts
const older = timeline.olderCursor
  ? await reader.readPage({
      view: "timeline",
      types: ["message", "activity", "transition"],
      cursor: timeline.olderCursor,
      limit: 50,
    })
  : null;
```

Navigation cursors are bound to the snapshot, view, and filter. Reusing one with another
view or filter fails explicitly. Appends after the snapshot do not reorder the page being
read, while rewrites before its boundary invalidate the cursor.

Presentation navigation uses its own cursor type and the same stable snapshot semantics.
V1 and older V2 records without presentation metadata remain readable through `readPage`
but are not assigned invented interleaving in the folded V2 presentation view.

Fold revisioned activities at the same snapshot:

```ts
const activity = await reader.listActivityStates({
  at: timeline.snapshot,
  status: "open",
  order: "updated_desc",
  limit: 100,
});
```

An activity that was open at the snapshot remains `historically_open`; the reader does not
claim that a tool is still executing in a process it cannot observe.

## Read the independent audit log

```ts
const audit = new AuditLogReader(knownAuditLogPath);

const page = await audit.readPage({
  types: ["operation", "activity", "permission", "metering_reference"],
  limit: 100,
});
```

Audit pagination has the same stable-snapshot behavior. V0 summaries expose whether an
audit log is available but do not expose its path. A consumer that enables an audit log
should retain the configured path or derive it as part of its own persistence policy.

## Reconfigure persistence offline

Stop the live session before reconfiguration. Transcript and audit mutations are separate
fenced V0 operations.

```ts
const info = await sessions.getAgentSessionInfo(agentSessionId);
const resolved = await sessions.getAgentSessionCheckpoint(agentSessionId);
if (!info || !resolved) throw new Error("Unknown session");

await sessions.reconfigureAgentSessionPersistence(agentSessionId, {
  reconfigurationId: crypto.randomUUID(),
  expectedIncarnationId: info.incarnationId,
  expectedRecordRevision: info.recordRevision,
  transcript: {
    action: "replace",
    config: {
      path: resolved.checkpoint.transcript!.path,
      preset: "conversation",
    },
    checkpoint: resolved.checkpoint,
    acknowledgeContinuationLoss: true,
  },
});
```

V0 replacement changes the generation and policy while retaining the recorded path.
Disablement permanently removes that artifact and requires the corresponding explicit
acknowledgement. Use the managed CLI when an operator-facing confirmation flow is desired.

## Delete and restore managed sessions

Deletion is tombstoning by default. The consumer supplies incarnation and revision CAS
tokens so a delayed request cannot delete a newly reused logical identity.

```ts
const info = await sessions.getAgentSessionInfo(agentSessionId);
if (!info) throw new Error("Unknown session");

await sessions.deleteAgentSession(agentSessionId, {
  deletionId: crypto.randomUUID(),
  expectedIncarnationId: info.incarnationId,
  expectedRecordRevision: info.recordRevision,
  deleteTranscript: false,
  deleteAuditLog: false,
  removeRegistryEntry: false,
});
```

Hard registry removal is allowed only when all retained artifacts are deleted in the same
operation. Prefer tombstones when restoration or identity history matters.

Restore a tombstone explicitly:

```ts
const deleted = await sessions.getAgentSessionInfo(agentSessionId, {
  includeDeleted: true,
});
if (!deleted) throw new Error("Unknown session");

const opened = await sessions.restoreAgentSession(agentSessionId, {
  adapter: resolveAdapter(deleted.adapterId),
  adapterId: deleted.adapterId,
  restorationId: crypto.randomUUID(),
  expectedIncarnationId: deleted.incarnationId,
  expectedRecordRevision: deleted.recordRevision,
});
```

Retained artifacts are reused. If an artifact was deleted, restoration requires an
explicit `false` or an absolute normalized replacement filename; directory shorthand is
not accepted because restoration IDs must remain stable if filesystem state changes. It
never silently recreates the previous file. The returned value has the same continuation, recovery, configuration,
promptability, and repairs report as ordinary managed loading.

## Use the command layers in a UI

The one-session REPL uses unambiguous routing:

```text
ordinary text     -> session.prompt(...)
/command          -> local AgentSession command
//command [input] -> session.executeInternalSessionCommand(...)
```

```ts
try {
  await runAgentSessionRepl(session, {
    activity: true,
    onSlashCommand: async (command, args) => {
      if (command !== "tag") return false;
      await addTag(session.agentSessionId, args.join(" "));
      return true;
    },
  });
} finally {
  await session.stop();
}
```

Built-in local commands include `/session`, `/state`, `/commands`, `/handoff`, and
`/bridge`. Unknown `/...` commands never fall through as prompts. A graphical application
can skip slash parsing and bind the same methods directly to buttons, RPC methods, jobs,
or orchestration events.

The packaged managed CLI is a reference consumer:

```bash
acp-client create [AGENT_SESSION_ID] --adapter opencode
acp-client open AGENT_SESSION_ID
acp-client sessions --json
acp-client info AGENT_SESSION_ID
acp-client checkpoint AGENT_SESSION_ID
acp-client maintenance [AGENT_SESSION_ID]
acp-client restore AGENT_SESSION_ID
acp-client reconfigure AGENT_SESSION_ID --replace-transcript --preset detailed --yes
acp-client delete AGENT_SESSION_ID --delete-transcript --yes
```

## Direct sessions

Direct sessions are intentionally persistence-free unless configured:

```ts
const session = await AgentSession.create({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  providerSession: { kind: "new" },
});
```

Direct V2 persistence requires stable logical and creation identities because there is no
manager catalog to discover generated ones after a crash:

```ts
const session = await AgentSession.create({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  agentSessionId,
  creationId,
  providerSession: { kind: "new" },
  persistence: {
    root: "/absolute/application-state",
    transcript: { preset: "activity" },
  },
});
```

In V0 this direct transcript path is a preview convenience, not a crash-resumable creation
transaction. A failure after the transcript header is installed can leave an initialized
artifact which must be opened or cleaned up explicitly. Direct audit persistence is
rejected instead of creating an audit file which the live session cannot safely own.

For durable persistent applications, use `SessionManager.createAgentSession()` and
`SessionManager.loadAgentSession()`. The manager owns prepared creation, registry fencing,
audit attachment, retry discovery, and completion receipts.

## Legacy compatibility

`FileSessionStore`, `sessions:`, `transcriptPath`, `transcriptDir`, and
`transcriptActivity` remain for compatibility with the earlier flat catalog/transcript
model. They should not be used for new managed implementations.

Legacy transcript conversion and registry import are explicit:

```ts
await migrateLegacyTranscript(options);
await sessions.importLegacySessions(legacyStore);
```

Migration preserves the legacy prefix for presentation and establishes a new V2 authority
boundary. Strict V2 creation never claims an already initialized legacy file implicitly.

## Current V0 boundaries

- Managed creation and loading support normal ACP mode only.
- Direct V2 creation supports transcript-only persistence and is not crash-resumable;
  direct V2 audit persistence is rejected.
- Direct V2 opening currently requires an explicit `agentSessionId` and transcript;
  checkpoint-only and exact-file identity inference are deferred.
- Handoff creates a new thread on the current adapter.
- Tombstone restoration currently loads only the recorded provider thread; reconstruction
  strategies remain available to ordinary managed loading but are deferred for restoration.
- Transcript and audit reconfiguration are separate operations.
- Replacement reconfiguration retains the existing artifact path.
- Generic ACP load cannot prove what happened after a crash; uncertainty requires an
  explicit consumer decision.
- Session logs are plaintext and do not provide encryption or tamper resistance.
- Metering records are application telemetry, not an invoice or trusted billing ledger.
- A transcript or audit generation has one active writer, enforced by a writer lock.
- Retention policy and automatic pruning belong to the consumer.

## Recommended ownership rules

- Key application state by `agentSessionId`, never `internalSessionId`.
- Keep live `AgentSession` objects in the consumer; use the manager for durable discovery.
- Resolve adapter IDs in the consumer and fail explicitly when one is unknown.
- Inspect `AgentSessionOpenResult.promptability` before dispatching work.
- Read state before subscribing so no initial snapshot is missed.
- Persist operation metering records separately when they matter financially.
- Use transcript presets deliberately; detailed and diagnostic capture can contain secrets.
- Keep local commands distinct from harness commands.
- Stop every live session during application shutdown.
- Do not infer provider loading from a transcript path or file contents.
