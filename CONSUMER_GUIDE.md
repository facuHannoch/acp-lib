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
              └── ConversationController (ACP or native)
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

### Messages made of parts

`prompt({ parts })` accepts ordered `MessagePart` values. An optional `text` is a leading text
part; `pasted` retains its optional name and is sent as text. The text-only `result.text` view
and positional calls remain available. A response containing media also has ordered
`result.messages[i].parts`; streaming `onResponseChunk` exposes each non-text `part`.

```ts
await conversation.prompt({
  parts: [
    { kind: "text", text: "Review this plot and these notes." },
    { kind: "image", path: "plot.png" },
    { kind: "pasted", name: "notes", text: "The red line is the baseline." },
    { kind: "file", path: "/shared/report.pdf", mode: "link" },
  ],
});
```

Media kinds are `image`, `audio`, and `file`. Each input has exactly one source: `data:
Uint8Array`, `path` (relative to the conversation's working directory, absolute, or a `file://`
URI), or `ref` (a previously kept copy). MIME types are inferred from file paths; supply the
MIME type for byte-array inputs when known. SVG is a `file` and is embedded as markup, retaining
its MIME type. Text files are ACP embedded text resources; other files use blob resources.
An embedded copy's uri is `attachment:///<name>`: it names the copy, not a file the agent could
open. A UI rendering SVG must sanitize it.

Some adapters drop kinds they advertise. Claude's (`claude-agent-acp`, checked at 0.85.0) keeps
embedded text files but silently drops binary ones (PDFs, any blob), although it advertises
`embeddedContext`, so the model never sees them and nothing fails. Send binary files to Claude as
links (`mode: "link"`, a file it can reach): its Read tool opens PDFs. Whether a model reads a
kind also depends on the model: OpenCode on DeepSeek V4.1 Flash has no PDF input.

`mode: "copy"` sends the actual content. `keep: false` records name, MIME type, size and SHA-256
without retaining bytes; the default keeps bytes when a store is available. `mode: "link"`
requires a path and sends an absolute `file://` resource link. It records a pointer, so later
edits/deletion of the original affect what history can display. The library does not open a
link: one whose file cannot be read is still sent, with no size. `keep` is invalid on links.
A link the agent sends without a size is recorded without one.
`record: false` sends a part without recording it and cannot be combined with `keep`.

With no mode, path sources use copies up to 100,000 bytes for files, 3,750,000 for images and
5,000,000 for audio; larger paths use links. Configure these byte thresholds on the Agent with
`media: { thresholds: { file, image, audio } }`. Byte-array and ref sources remain copies.
There is no library size ceiling. Provider errors surface to the caller. Unsupported explicit
copies are refused using the agent's prompt capabilities; an automatic path source falls back
to a link. PTY mode refuses media parts.

Declare shared directories with `conversationDefaults: { additionalDirectories: ["/shared"] }`
or a conversation's `runtime.additionalDirectories`. They are sent only to an agent that advertises
`sessionCapabilities.additionalDirectories` (otherwise left out, with a warning). They reach ACP session creation/load;
the harness applies its own permissions. The library does not restrict pointers. A harness on
another machine or in an isolated container needs a shared mount or a copy.

SQLite schema 16 stores kept blobs separately from message rows in the same database and
transaction. History and audit records contain refs/URIs and metadata. Ordinary text messages
remain strings; mixed messages use `PersistedContentBlock[]`, including `media` and `pasted`.
Old inline image/resource blocks can still be read; migration rebuilds structured message
search text and its FTS index without old inline bytes or refs. Raw canonical protocol capture and debug
prompt logs redact inline media; a consumer's explicitly requested `wire` callback is verbatim.

```ts
const agent = await Agent.open({
  // ...persistence, adapters, and other settings...
  capture: { message: "content", media: "metadata" },
  // media: { store: yourMediaStore }, // optional MediaStore override
});

const store = agent.media.store ?? agent.persistence.media;
const saved = await store?.get(ref); // { ref, info, data } or null when removed
await conversation.prompt({ parts: [{ kind: "image", ref }] });
await agent.deleteMedia(ref); // removes bytes; history retains the dangling ref
await agent.deleteMediaForConversation(conversation.id);

const files = await agent.persistence.files?.search({
  text: "plot", agentConversationId: conversation.id, kind: "image", minSize: 1,
});
```

`capture.media` is `none`, `metadata`, or `content` (default), independently of message text.
The conversation persistence resolver can override it, and a part's own `record`/`keep` wins.
Checkpointing still summarizes text. A backend without `media` and no override defaults to
metadata; explicit `keep: true` is refused. The older SessionManager/AgentSession JSONL
transcript records text and descriptive part lines, with no media store.

A `MediaStore` implements async `put(bytes, info) -> ref`, `get(ref)`, `delete(ref)` and
`list(owner)`. `get` returns `{ ref, info, data }` or null; `list` returns `{ ref, info }`
entries. Preserve all `MediaInfo` fields. Separate stores cannot share the record transaction: failed
writes stop dispatch, and `list(owner)` supports orphan cleanup. Reusing a kept ref within
its conversation reuses bytes; another conversation gets a new copy. Copies record SHA-256
but are not deduplicated. Clearing records deletes SQLite media; the Agent clear API also
cleans an overridden store. Soft deletion retains media.

`files.list` and `files.search` browse media metadata, including unkept/deleted copies and
links, with optional conversation, name, kind, MIME type and size filters. They accept `limit`
and `cursor`; response revisions are folded. Message search covers text and pasted text,
without indexing media names, refs or bytes. Offset file cursors can shift under concurrent
inserts. Custom backends can supply the optional `files` repository.

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

Paging by records cuts turns anywhere: a tool call is several records, so a page can start
mid-turn. To page by what the conversation shows, count agent messages instead:

```ts
const page = await agent.persistence.records.listRecent!(conversation.id, {
  agentMessages: 50,  // each page: 50 agent messages and the activity that led to each
  fold: true,         // timeline items instead of records
  detail: "summary",  // tool calls without input and output
});
let items = page.items;
// Expanding a step: its full record merges into the summary item.
const full = await agent.persistence.records.get(step.current.recordId);
items = reconcileConversationTimeline(items, [full!]);
```

- The cut goes right after an agent message (out-of-band appends count), so a page usually
  begins with a turn's user message, and activity after the newest message (a running turn)
  stays on the newest page.
- A record goes to the page where its item's first revision falls. A page holds every revision
  of its items, including later ones up to the snapshot, and none of another page's: a message
  that completed after the next tool started is not split across pages.
- `limit` caps the page (records, or items when folded; default 2000). A page that reaches it
  ends at a whole item with `truncated: true`, and `olderCursor` continues from there.
- `fold: true` returns `ConversationTimelineItem`s; live records still merge with
  `reconcileConversationTimeline(items, records)`. With `detail: "summary"` an item keeps two
  revisions, its first (its start) and its merged current (under its latest revision's id),
  so it reconciles like any other item.
- `detail: "summary"` also works on records. The step title is the harness's `name`, which
  varies by harness; `records.get` returns the input and output.
- Without `agentMessages`, `fold` or `detail`, `listRecent` is unchanged. A cursor is bound to
  its unit: a record-paging cursor is refused when paging by agent messages, and the reverse.

Every physical record has a stable `recordId` and a conversation-local `sequence`.
`operationId` says which library operation wrote it: a turn (`result.operationId`), an
internal inference or recap, a setting change, a mode change, or a handoff. Appended out-of-band messages are standalone records
without an operation id. Every record of one
operation shares it, so a turn's messages, tool calls, permissions and thinking can be grouped
without inferring turns from their position; `sequence` gives the order. A tool call still
running when its turn ends is recorded `failed` in that turn; if the harness reports it later, that
update is recorded under the turn it arrived in, as a separate timeline item. Protocol lines
carry the operation that sent them: a handoff's own lines its id, the lines of its summary, seed
or target prompt that prompt's id (`<handoffId>:summary`, `:seed`, `:target`); a recap's or a
recovery seed's lines theirs. Records written outside any operation (protocol lines while
connecting) have none. Operations can interleave:
a message appended during a turn sits inside the turn's sequence range, so group by
`operationId`, not by range. Timeline items for tool calls, permissions, thinking and activity are
keyed within their operation, so a provider id reused by a later turn is a new item.
A cancelled operation records why and how in a `cancellation` record (two revisions under one
`cancellationId`, carrying the cancelled operation's `operationId`): `requested` with its
`reason` (`steer`: a message sent mid-turn; `interrupt`: Stop; `stalled`: the stale policy;
`stop`: the conversation was stopped), then `resolved` with its `outcome` (`acknowledged`,
`forced` when the process had to be killed, `too_late` when the turn finished first, or
`failed`). So after a reload a client can still show a turn as "Stopped" or "Redirected"; for
a steer, the redirecting message is the next turn's. It describes the cancellation, not the
mechanism (ACP `session/cancel`). JSONL transcripts and audit logs write the same record
(`t: "cancellation"`).
Databases from before schema 15 recover it for tool call, thinking, activity, permission,
configuration and mode-change records; `records.list(id, { operationId })` filters by it.
The reconciliation helper keeps distinct messages separate and groups revisions of an
assistant message, tool call, permission, thinking block, activity, or transition by its
logical ID. Assistant snapshots take their position from the first streamed text; the
completed revision supplies their final content and status. Providers that expose a
message only in the final prompt result cannot supply an earlier position. Records
written before schema version 11 have no such boundaries to reconstruct. The helper's
items retain every revision, carry the latest merged fields in `current`, and sort by
the earliest loaded sequence. `startedAt` is when the item's first revision was written
(when a message began) and `updatedAt` when its latest was (also `current.timestamp`).
Loading an older page may move an item to its true
earlier position when its first revision arrives.

ACP has no "message finished" signal, so an assistant message ends when the next one begins:
a chunk with a different message id, or a new tool call (with or without ids; tool *updates*
do not split a message). That message is recorded `completed` at that moment, so a client
sees it finish as soon as the next text or tool appears. The turn's last message ends with
the turn and takes its outcome (`completed`, `cancelled` or `failed`); messages that ended
before a failure stay `completed`. The live `result.messages` uses the same boundaries. Configuration, protocol, agent
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
physical revisions for timeline reconstruction and audit (except `listRecent` with `fold: true`
and `detail: "summary"`, which keeps two per item). `listRecent` and `listPreviews` are SQLite
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

### Message status

Every prompt handle has a `status`, and each change is a `message_status { id, status, turnId? }`
event on the conversation. One sequence for every backend:

`queued` → `received` → `taken` → `delivered` → `seen`, or the end states `withdrawn` and `failed`.

```ts
import type { AgentConversation, MessageStatus } from "@qlairoslabs/acp-client";

async function promptWithStatus(
  conversation: AgentConversation,
  text: string,
  showTicks: (status: MessageStatus) => void,
) {
  const handle = conversation.prompt(text);
  showTicks(handle.status);
  const unsubscribe = conversation.subscribe(({ event }) => {
    if (event.kind === "message_status" && event.id === handle.id) showTicks(event.status);
  });
  try {
    return await handle;
  } finally {
    unsubscribe();
  }
}
```

- **Native conversations** use the harness's milestones: `received` when its inbox accepted the
  message, `taken` when a turn took it, `delivered` and `seen` from its `items_receipt` evidence.
- **ACP conversations** approximate: `received`, `taken` and `delivered` together when the prompt is
  sent, `seen` at the provider's first output (it started answering, not proof it read the message).
- A status only moves forward; skipped steps are still reported in order.
- `failed` means it never reached `seen`; a seen message whose turn fails stays `seen`, and the
  prompt's result says how the turn ended. `withdrawn` is only possible before a take.
- Live only: statuses aren't restored after a restart. The other message events are unchanged.

### Provider notices: retries, warnings and failures

Harnesses report retries, warnings and failures in an update's `_meta`, not as ACP errors.
acp-client reads two shapes and turns them into one `provider_notice` activity:

- the JetBrains AIR session-failure extension, which acp-client now advertises in
  `clientCapabilities._meta` (`jetbrains.air`, version 1, `sessionFailure`): codex-acp and
  claude-agent-acp then send typed notices with an id, a revision, a category, a severity,
  a title and suggested actions;
- codex-acp's own fallback, `_meta.codex.error`, for a Codex that doesn't use AIR.

```ts
handlers.onActivity = (activity) => {
  if (activity.kind !== "provider_notice") return;
  // activity.severity: "info" | "warning" | "error"
  // activity.category: "limit" | "service" | "connection" | "access" | "request" | …
  // activity.code (when known: "rate_limited", "auth_required", …), activity.title,
  // activity.actions: "retry" | "login" | "new_session"
  // activity.noticeId + activity.revision: later revisions of one notice replace it
};
```

A `warning` or `info` notice ends nothing: a retry in progress ("Rate limited, retrying"),
a reconnect, an advisory. Show it as a passing status, keyed by `noticeId`. An `error`
notice is a failure the provider reported. Notices are stored as activity records, so they
appear in the conversation's timeline. When a turn is judged stalled while the provider was
retrying, its `stalled` error record says so in its `message` and carries the cause in
`details.providerCode` (for example `rate_limited`). Adapters that send neither
recognized shape produce no `provider_notice`.
Unmodeled `session_info_update` metadata and `usage_update` metadata are kept
as `meta` on their respective activities. Extend exhaustive `ActivityEvent`
switches to cover `provider_notice`.

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
- SQLite commits a delivery cursor with a successful turn, including turns whose message
  text is not captured.
- The block is capped at `OUT_OF_BAND_PROMPT_MAX_CHARS`; the oldest messages are dropped
  first with an omission note. The transcript always keeps all of them.

Other conversations of the same agent see the message through identity like any other
canonical message. Text-only appends require `capture.message` of `"content"` or `"raw"`;
media-only appends are supported under the independent media capture policy. An append rejects
empty input and unknown or deleted conversations. `appendAssistantMessage(id, { parts })` uses
the same part/store rules. Parts are accepted whatever the next turn's agent supports.

A message waits for the next successful turn. When its record can restore it (text captured,
every copy kept, no `record: false` part), it is delivered from the record. Otherwise its parts
wait in memory: unkept bytes are never written anywhere, and a failed turn keeps them for the
retry. After a restart such a message is delivered from its record, and a copy whose bytes were
not kept (or were deleted) is named instead, as `[image plot.png: not available]`; an unrecorded
part is gone. A copy the agent cannot take is named too (`[image plot.png: not supported by this
agent]`), so an out-of-band message never makes a turn fail. A PTY agent receives every media
part as such a line.
Custom backends can supply `outOfBandDelivery` to track completion independently of captured
text; otherwise delivery uses visible completed messages, scanning forward without `listRecent`.

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

Each attempt runs in a fresh, disposable harness session that is stopped as soon as its prompt is answered. A harness
may start work of its own in that session which the answer does not wait for, and ACP gives the client no way to wait for
it: OpenCode names a session with a second request on a small model, started at the first prompt, and stopping the process
right after the answer can cut it off mid-stream (behind a gateway that is a cancelled, half-accounted request). So for
OpenCode the default runtime starts the disposable process with `OPENCODE_CONFIG_CONTENT` set to turn the title agent off,
for internal inference only: conversations are not touched, and an `OPENCODE_CONFIG_CONTENT` you already set (in
`conversationDefaults.env` or the process environment) is kept, with the title agent switched off inside it. With a
`launcher`, the variable is added to its `spawnEnv`; a launcher that starts the harness elsewhere (a container, a remote
host) must forward it. Set `internalInference: { suppressHarnessBackgroundWork: false }` to leave the harness as configured.
It has no effect with a custom `runtime`; see `withoutHarnessBackgroundWork` to apply it there.

A failed attempt keeps the original error for whoever awaits it, and records on the attempt (`failureDetails`) the
JSON-RPC code and the labels harnesses send in `data` (`service`, `errorName`, `providerCode`), nothing else of `data`. A
harness decides what its errors carry: OpenCode's ACP adapter, for example, sends the upstream message text but not the HTTP
status, gateway error code or request id, so those cannot be recovered here.

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

## Permissions and approval UI

Use `permissions: { default, rules? }` for Agent, conversation, direct session,
or raw ACP client configuration. Omission means `ask`. Agent defaults are
overridden by `conversationDefaults`, then conversation settings, then its
`runtime`. Each supplied `permissions` object replaces the previous one.

An explicit `permissionRule(request)` result wins. On ACP, the next step matches
`kind:<tool-kind>` and `command:<exact command>`. Command rules apply to execute
requests whose arguments the library can normalize to one command. Supported
input includes a single command string, a simple argument array, and the
recognized `bash -lc` wrappers. Rules match exactly and do not use glob or
substring matching. The stricter matching level wins
(`deny`, then `ask`, then `allow`). An unmatched request uses the default.
Deny selects `reject_once` where offered and otherwise cancels the request.

```ts
import { Agent, type AgentAdapter } from "@qlairoslabs/acp-client";

export async function openApprovalDemo(adapter: AgentAdapter, path: string) {
  const agent = await Agent.open({
    persistence: { kind: "sqlite", path },
    adapters: { main: adapter },
    defaultAdapterId: "main",
    permissions: {
      default: "ask",
      rules: { "kind:read": "allow", "command:git status": "allow", "kind:delete": "deny" },
    },
    permissionRule: request => request.tool?.name === "publish" ? "deny" : undefined,
    conversationDefaults: { answersPermissions: true, permissionTimeoutMs: 60_000 },
  });
  const conversation = await agent.conversations.create();
  const unsubscribe = conversation.subscribe(({ event }) => {
    if (event.kind === "permission_requested") {
      console.log(event.id, event.title, event.options, event.expiresAt);
    } else if (event.kind === "permission_resolved") {
      console.log(event.id, event.outcome, event.by);
    }
  });
  // Call with the request ID and the option ID selected by your UI.
  const answer = (id: string, optionId: string) => conversation.answerPermission(id, optionId);
  return { agent, conversation, answer, unsubscribe };
}
```

Allow and deny resolve immediately. Ask first uses a per-prompt
`onPermissionRequest` handler. Without one, it waits for a consumer only if
`answersPermissions` is true. An ask with neither responder uses `permissions.unanswered`. The default,
`"reject"`, refuses the tool and lets the turn continue. ACP selects
`reject_once` when offered and sends cancellation otherwise. Native responds
with `deny`. Use `permissions: { default: "ask", unanswered: "cancel" }`
to send ACP's cancelled permission response or interrupt the requesting
native turn. The setting applies only to an unanswered ask. It leaves
explicit deny, handler responses and consumer timeout behavior unchanged.
A forwarded ask uses the giving conversation's setting when it is
available. Without a giving conversation, an applicable worker policy with
`unanswered: "cancel"` cancels an otherwise unanswered ask. The consumer wait defaults to five minutes, starts at request ingress, and expires
to a refusal. Supply a positive integer below 600,000 to override it.
`expiresAt` is epoch milliseconds and is present only for a consumer wait.
Check `answerPermission()`'s `{ accepted }` result. Unknown, expired,
invalid-option, handler-owned and already resolved requests return false.
Each request has one resolution event in a microtask after it closes.
`by` is `handler`, `consumer`, `default`, `timeout` or `turn_ended`.
Forwarded worker requests include a worker `source` and can omit `turnId`.

A harness policy first decides whether a native tool needs approval. For
native asks the library uses `permissionRule` and the configured default.
Native requests supply the tool name and raw argument string. ACP kind and
command rules apply only to ACP. Native approval options are `allow_once`
and `deny`. The harness also has a ten-minute approval limit. A configured
`harness.approvalResponder(request, answer, signal)` can answer centrally,
including while detached. Await `answer("allow_once")` or `answer("deny")`
to learn whether the harness accepted the decision.

## Built-in ACP terminal environments

Set `terminalEnv` on the client, controller or conversation runtime, or
return it from `launcher.prepare()`. The prepared value takes precedence.
For example, `terminalEnv: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }`
passes exactly those environment variables to built-in terminals. Use an
empty object to pass none. In this mode ACP terminal request environment
entries cannot add to or override the host's environment.

When no exact environment is configured, the built-in ACP terminal uses the
variables supplied in the terminal request. The hub's process environment,
client spawn settings and the launcher's `spawnEnv` are separate.
`TerminalRegistry` also accepts `terminalEnv` in its options and in a direct
`create()` call. A direct per-terminal setting wins. Custom terminal
handlers are responsible for their own environment isolation.

## Cancellable ACP startup and deferred connections

Agent-owned normal ACP conversations connect on open by default. Use
`providerStart: "on_first_use"` in `conversationDefaults` or override it in
`runtime` on create or reopen. The first provider-bound operation starts the
connection. A deferred reopen returns `providerSession: "deferred"`. Provider
settings and commands can be empty until then. Watch reopen progress and
`provider_reconnected` for first-use recovery.

```ts
import { AgentSession, ConnectionCancelledError, type Agent, type Adapter,
  type AgentConversationId } from "@qlairoslabs/acp-client";

export async function reopenLazily(agent: Agent, id: AgentConversationId) {
  const opened = await agent.conversations.open(id, {
    runtime: { providerStart: "on_first_use" },
    onRecoveryProgress: event => console.log(event),
  });
  if (opened.providerSession === "deferred") console.log("Connects on first use");
  return opened.conversation;
}

export async function startDirect(adapter: Adapter, adapterId: string, signal: AbortSignal) {
  try {
    return await AgentSession.create({ adapter, adapterId, signal });
  } catch (error) {
    if (error instanceof ConnectionCancelledError) return null;
    throw error;
  }
}
```

An explicit stop or a superseding ACP connection attempt rejects the pending
connection with `ConnectionCancelledError` and code `connection_cancelled`.
Direct session startup accepts an `AbortSignal`, as above. Use eager startup
when a failed session creation must leave the connection available for
authentication.

## Native harness conversations (experimental)

An Agent can run native conversations on its own harness alongside external ACP
adapters. Configure a real OpenRouter model with a key supplied through the
environment, or use a scripted model with a local JSONL scenario for offline
development. Keep the harness home on durable storage. Backend kind stays fixed
across a conversation's mode changes and handoffs.

### Compiled launchers

A compiled Bun application can import `serve(home)` from
`@qlairoslabs/acp-client/native-harness` and call it from its own subprocess
command. For example, route `agents __native-harness serve --home <directory>`
to `await serve(directory)` in the application, then set `harness.command` to
`[process.execPath, "__native-harness", "serve", "--home", directory]`.
Handle that command before normal application startup and keep stdout reserved
for the harness protocol. The command override includes all arguments, so pass
the same directory as `harness.home`.

### Configuration

```ts
import { Agent, ADAPTERS, type AgentHarnessConfig } from "@qlairoslabs/acp-client";

export async function openNative(
  directory: string,
  model: AgentHarnessConfig["config"]["model"] = {
    protocol: "openrouter", model: "openai/gpt-6-luna", apiKeyEnv: "OPENROUTER_API_KEY",
  },
) {
  return Agent.open({
    persistence: { kind: "sqlite", path: `${directory}/agent.sqlite` },
    adapters: { main: { kind: "native" }, codex: ADAPTERS.codex },
    defaultAdapterId: "main",
    harness: {
      home: `${directory}/harness-home`,
      config: {
        version: 1, system: "Be concise.", model,
        defaultPolicy: "open",
        policies: { open: { fallback: "deny", tools: { lookup: "ask" } } },
      },
      approvalResponder: async (request, answer) => {
        await answer(request.tool === "lookup" ? "allow_once" : "deny");
      },
      functions: {
        tools: {
          lookup: {
            description: "Read the configured status.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            handler: (_args, context) => ({ status: "ready", channel: context.channel }),
          },
        },
      },
    },
  });
}
```

Use a supported OpenRouter model ID configured for your account. `harness.config.model` is typed from the harness SDK
and passed through unchanged on every open. Besides `scripted` and `openrouter`, the SDK defines an inference-source arm,
`{ protocol: "openai-compatible", providerId, model, baseUrl, apiKeyEnv? }` (decision 0034): an OpenAI-compatible Chat
Completions endpoint chosen by the consumer. `baseUrl` is HTTPS or a literal loopback address over HTTP (`127.x` or `::1`,
not `localhost`) with no credentials, query or fragment; the harness appends the Chat Completions path and follows no
redirects; `apiKeyEnv` names a variable in the harness's environment, is optional for keyless endpoints and is read only
when the session opens. For an offline equivalent, pass
`{ protocol: "scripted", script: "/path/to/scenario.jsonl" }`
as the second argument. Function parameters are JSON Schema. Functions return
JSON values and receive a context with invocation identity and an abort signal.
Harness policies grant `allow`, `ask` or `deny` by tool name and define a
fallback. This host responder grants one call to the read-only lookup.
Subscribe to `items_receipt` when you need delivery evidence.

To use an OpenCode Go API key with the native harness, make the key
available in the harness process and pass the Go preset to `openNative`.

```ts
const agent = await openNative(directory, {
  protocol: "opencode-go",
  model: "deepseek-v4.1-flash",
});
```

The harness reads `OPENCODE_API_KEY` by default. Set `apiKeyEnv` if your
launcher supplies a different variable, such as `OPENCODE_GO_API_KEY`.
The preset sends a stable routing header per channel and uses Go's Chat
Completions endpoint. DeepSeek V4.1 Flash may require allowing the Global
region in the Go workspace. [OpenCode Go model settings](https://opencode.ai/docs/console/go/#enable-restricted-models)

Set `harness.config.model.contextBudget` on OpenRouter, OpenCode Go or OpenAI-compatible models
to fit a larger inference request. For example, a model with a 128,000-token
window can use `contextBudget: { contextWindowTokens: 128_000, outputReserveTokens: 4096 }`.
The reserve only affects local fitting. Set `maxOutputTokens` to also request an
upstream cap. This uses `max_tokens` with OpenRouter and
`max_completion_tokens` with a custom Chat Completions endpoint that supports it.
The estimate uses UTF-8 request size for text and a separate image allowance.
Use `estimationMarginTokens` to leave extra room. The independent serialized
request cap defaults to 64 MiB and can be lowered with `maxRequestBytes`.
The harness fits optional history around the complete policy-filtered offer.
A failed turn reports `context_limit` and leaves the channel usable. The
underlying `NativeTurnError.contextFailure` gives the applicable limit and,
for local token and byte limits, the measured budget.

When a native inference attempt fails, the prompt rejection and
`turn_failed` event include the harness diagnostic. A metered conversation
rejects with `AgentSessionOperationError` whose `cause` is a
`NativeTurnError`. Both errors carry the same message. Use
`NativeTurnError.outcome` for the turn classification. `"interrupted"`
records an external interruption. A provider deadline leaves the turn
`"failed"` and records `"timeout"` on the model call.

Provider diagnostics identify HTTP status where available, for example
`Chat Completions HTTP 429` or `OpenRouter HTTP 500`. Other diagnostics
identify a transport failure, refused redirect, invalid response,
configuration error, or model request deadline. The harness uses fixed
fallback wording when it has no validated provider detail. Remote
response bodies, headers and URLs are excluded from these failure
diagnostics. Reconciliation preserves the recorded reason, and the next
prompt can run when the provider recovers.


```ts
import { NativeInputStoppedError, type Agent, type ItemsReceipt } from "@qlairoslabs/acp-client";

export async function nativePrompt(agent: Agent) {
  const conversation = await agent.conversations.create({ title: "Native example" });
  const receipts: ItemsReceipt[] = [];
  const unsubscribe = conversation.subscribe(({ event }) => {
    if (event.kind === "items_receipt") receipts.push(event);
  });
  try {
    const prompt = conversation.prompt("Report the status.");
    // Use await prompt.withdrawAsync() if the user asks to take it back.
    return { result: await prompt, receipts };
  } catch (error) {
    if (error instanceof NativeInputStoppedError) return { stoppedInput: error.messageId, receipts };
    throw error;
  } finally {
    unsubscribe();
    await conversation.stop();
  }
}
```

- **One Agent is one harness session; one conversation is one channel.** All
  native conversations of an Agent talk to the same agent and share one process.
  `conversation.internalSessionId` is the Agent's id for each of them.
- **The process starts on first use,** not when the Agent or a conversation
  opens. Concurrent first prompts share one start. It stops with `agent.close()`.
  Use `agent.nativeHarness.start()`, `suspend()`, `resume()`, and `stop()`
  for agent-wide controls. `operatorStatus()` reports process health and the
  last confirmed session view. `workingChannels` counts running turns.
- **Attachment** is independent of the channel and agent. Call
  `conversation.attachObservation()` and dispose the returned handle to
  detach without interrupting. Read `conversation.connection.attachmentConnected`
  for attachment state and the host's `status()` for channel and session
  lifecycle. `restartConversation(conversation.connection)` starts only after
  confirmed stop.
- **The harness schedules turns.** A prompt resolves with the turn that took its
  message. A `delivery: "steer"` message sent while a turn runs is accepted at
  once and taken by that turn at its next model call; both prompts then resolve
  with the same `operationId`.
- **Item receipts** are live conversation events with
  `{ kind: "items_receipt", turnId, itemIds, milestone }`. They carry the
  harness's committed `delivered` and `seen` advances for a turn. The IDs can
  include external notices as well as prompts. Receipts can arrive for a held
  turn and are not replayed as history after reconnect. The existing
  `message_delivered` event and prompt settlement keep their own meanings.
- **Approvals** use the [permission configuration and events](#permissions-and-approval-ui) above.
- **Interrupting** (`conversation.interrupt()`, or `connection.forceStop()`)
  ends that conversation's turn only. Other conversations and the shared
  process keep running, and the interrupted conversation accepts new input.
- **Withdrawing input.** `promptHandle.withdraw()` and `conversation.withdraw(id)`
  remove local input synchronously. Use `await promptHandle.withdrawAsync()` or
  `await conversation.withdrawAsync(id)` once a native input has been submitted.
  A confirmed withdrawal cancels its prompt. If take wins, the call returns
  false and the prompt follows its turn. Push and withdraw can be dispatched
  concurrently. A `not_found` reply can leave the withdrawal unresolved and
  the async call can reject. The host retains its intent and suppresses push
  replay while checking the original channel and item ID on reconnect. If those
  checks still leave a push unacknowledged, its prompt can reject with the
  unresolved error. The intent remains available for later reconciliation.
  Default submission records are in memory even with SQLite persistence.
  Configure file-backed host records to retain the intent across Agent reopen.
  A custom submission store needs `markWithdrawing` to track async withdrawal
  and clears that flag on `markAccepted(id, true)` when take is confirmed.
  `interrupt({ clearQueue: true })` still clears locally queued input. Already
  submitted native input remains with the harness on interrupt. Stop and Agent
  close give withdrawal of submitted, unclaimed inputs a shared one-second
  grace period before interrupting the active turn. A prompt whose input was
  taken resolves as cancelled. It returns completed messages from the turn
  and its cancelled metering record. If the first message was still
  streaming without a completion, the returned text is empty. Before stop
  finishes, the Agent tries to recover missed committed replies from that
  prepared turn for persistence. Recovered replies are stored once and do not
  change the caller's result. If the controller never saw the turn and learned
  of the take only from withdrawal, a committed reply can remain missing
  after reopening the conversation in the same Agent. A new Agent can recover
  it from the persisted harness session.
  A silent host can add about six seconds for withdrawal and reply recovery.
  Submitted
  inputs that were never taken reject with `NativeInputStoppedError` (includes
  `messageId`). If take wins or the host is unavailable or silent, the input
  may still run and incur model charges.
- **Channel changes** go through `agent.nativeHarness.changeChannel(conversationId,
  { displayName, policy, lifecycle })`. While the harness is stopped they are
  stored (they never start it) and applied by the next start before any pending
  work can run. Creating a conversation with a title, and deleting one, record
  the channel's name and retirement the same way.
- **After a harness crash** the host reopens the session, restores committed
  replies it missed, settles interrupted turns as failed, and keeps accepted
  input pending. Interrupted tool calls are never replayed.

Use `conversationMessages({ channel })` for a page from the harness.
`catchUp(channel, savedPosition, commitPage)` requests missed messages.
Persist each page and its position together, using message IDs to deduplicate.
The default acp-client transcript remains available independently. Use
`timeline()` for harness activity and `usage(channel?)` for reported token
totals, missing field counts, and completeness. Usage is an explicit scan
of the model-call pages. For per-turn records, see [Native turn metering](#native-turn-metering).

### One-off reminders (experimental)

Use `conversation.reminders` on an Agent-owned native conversation. Check
`conversation.conversationCapabilities.reminders` before offering controls.
Native support is provisional before the harness connects. On initialize,
the host checks the harness description for `capabilities.reminders` and
reads its `reminderLimits`. ACP conversations and harnesses that lack support
reject reminder operations with `ReminderError` code `reminders_unsupported`.

```ts
import type { Agent, AgentConversation } from "@qlairoslabs/acp-client";

export async function scheduleFollowUp(conversation: AgentConversation) {
  if (!conversation.conversationCapabilities.reminders) return;
  const reminder = await conversation.reminders.create({
    text: "Check whether the build has finished and report the result.",
    schedule: { in: 5 * 60_000 },
  });
  if (reminder.state === "blocked") {
    console.warn("Reminder blocked", reminder.id, reminder.reason);
  }
  return reminder;
}

export async function listReminderPages(agent: Agent) {
  let after: string | undefined;
  do {
    const { items, nextCursor } = await agent.reminders.list({ after, limit: 50 });
    for (const reminder of items) console.log(reminder.id, reminder.status, reminder.state);
    after = nextCursor ?? undefined;
  } while (after !== undefined);
}
```

- **Schedule.** Use `{ at: epochMilliseconds }` or `{ in: delayMilliseconds }`.
  The library converts relative time to an absolute time at acceptance and
  keeps it across retries and restarts. The bundled harness requires at least
  two minutes of lead time. See [Reminder routines](#reminder-routines) for
  interval and cron schedules on compatible harnesses.
- **Expiry.** Grace starts at the scheduled instant. Omit `expiresAfter`
  for twice the lead time, clamped to five minutes through 24 hours with the
  bundled limits. Supply an integer millisecond duration within those bounds
  or `null` to allow late delivery without expiry. At the expiry instant
  the reminder expires without queuing a notice. A schedule edit resolves
  a new default grace from the new lead and preserves an earlier explicit
  duration or `null` unless you supply a replacement. An expiry-only edit
  uses the saved schedule anchor. Pause and resume do not extend the expiry
  or move the scheduled time.
- **Read or edit.** Use `get(id)` (returns `undefined` for a missing view)
  or `list()` for the conversation. Use `update(id, patch)` for text, a new
  schedule or expiry, and `pause(id)`, `resume(id)` or `cancel(id)` for
  lifecycle changes. Cancelling a reminder cannot retract a notice already
  queued. The Agent-wide list returns `{ items, nextCursor }`, defaulting to
  50 items with a maximum of 100. Pass the cursor as `after` for the next page.
- **Offline writes.** With a durable reminders repository, stopped writes are
  journaled and applied on the next executable open before due work runs.
  A stopped write does not directly start the harness. Eligible pending work
  can arm a wake. Without a durable repository, mutations that need to write
  offline reject with `reminders_unavailable`. In-flight changes retain their
  identity and payload on retry. A blocked journal entry stays visible with
  its reason. Use `discardBlocked(id)` to clear the local refusal. To correct
  a blocked create, call `create()` again for a new ID.
- **Read freshness.** `state` describes the local view (`pending`,
  `maybe_sent`, `blocked` or `confirmed`), while `status` describes the
  reminder lifecycle. Offline reads combine the last-confirmed cache and
  local intents. The harness rows are authoritative. The host reconciles at
  open and refreshes reads while connected, so re-read after reconnect for
  current state.

`AgentConfig.reminders.authorize(conversationId, operation)` can veto host
changes. Operations are `create`, `update` and `cancel`. The `limits`
option supplies local validation defaults before negotiation. Harness
limits take precedence when available. A host create can include additional
`policyNames`. The library does not copy the destination channel's policy
onto that request, and updates cannot replace the original names.

Local validation and availability errors reject with a `ReminderError`.
A blocked harness change stays in the journal and appears on a
`ReminderView` with `state: "blocked"` and a `reason`. Some code names
are shared, so check whether the operation rejected or returned a blocked
view.

| Where | Code | Meaning |
| --- | --- | --- |
| Local | `invalid_schedule` | The time is invalid or does not meet the minimum lead. |
| Local | `invalid_input` | Invalid text, expiry, update patch or page size. |
| Local | `conflict` | The edit conflicts with a terminal reminder or a cancellation already in progress. |
| Local | `not_found` | The mutation has no matching editable reminder in this conversation. |
| Local | `unauthorized` | The configured authorization callback refused the change. |
| Local | `reminders_unavailable` | The mutation needs a live reminder service or durable storage. Agent-owned storage and service setup are required for this API. |
| Local | `reminders_unsupported` | The conversation or connected harness lacks reminder support. |
| Local | `routines_unavailable` | The peer lacks routine or unattended guard support, or executable open has yet to confirm an effective guard. |
| Local or harness startup | `invalid_config` | The unattended-turn limit is invalid or differs from the saved limit. |
| Harness request | `storage_failure` | A retryable storage or proof-budget failure returned no receipt. A live routine mutation that still has no receipt after retry returns a pending view. Retrying the same input reuses the saved ID and change. |
| Startup | `reminder_batch_retry_exhausted` | Three startup attempts returned a storage failure. The session stays stopped and the frozen batch remains unacknowledged. See the recovery steps below. |
| Harness | `unattended_guard_required` | Routine activation was blocked because the session lacks an enabled guard. |
| Harness | `invalid_policy` | The reminder names a policy the harness does not accept. |
| Harness | `channel_missing`, `channel_retired` | The destination channel is missing or retired. |
| Harness | `invalid_schedule` | The harness refused the scheduled time, acceptance anchor or expiry. |
| Harness | `limit_exceeded` | A harness reminder limit was exceeded. |
| Harness | `conflict` | The change would reuse an identity with different content or collide with an existing reminder. |
| Harness | `not_found` | The target reminder is missing. |
| Harness | `stale` | An unseen change ID is at or below the recorded high-water mark for the reminder. |
| Harness | `invalid_state` | The requested change is incompatible with the reminder's current state. |

Subscribe on the conversation for live updates. Extend exhaustive
`AgentSessionEvent` and `AgentConversationEvent` switches for these events.

| Event | When it appears |
| --- | --- |
| `reminder_intent_recorded` | A local change was journaled. |
| `reminder_intent_confirmed`, `reminder_intent_blocked` | A live mutation returned its outcome. Read the cache after startup to get outcomes of changes submitted offline. |
| `reminder_intent_discarded` | A local blocked entry was discarded or cancellation removed an unsent create. |
| `reminder_changed` | The harness reported a row change, including an agent-created reminder. |
| `reminder_fired` | A notice was queued. Use its `noticeId` to relate it to inbox activity. This event does not indicate a completed turn. |
| `reminder_cancelled`, `reminder_expired` | The harness cancelled or expired the reminder. |
| `routine_disposition` | A routine processed a range of occurrences. Includes `reminderId`, `firstScheduledAt`, `lastScheduledAt`, `count` and `reason` (`missed`, `catch_up_limit`, `overlap`, `expired` or `coalesced`). |
| `routine_migration_blocked` | A timezone data update held a cron routine. Includes `reminderId`, `fromVersion`, `targetVersion` and `cause` (`invalid_schedule` or `proof_budget`). |

The harness tools `schedule_reminder`, `list_reminders` and
`cancel_reminder` are scoped to the calling channel and subject to its
tool policy. Historical events are not replayed. Read reminder rows and
normal inbox or turn history after reconnect.

#### Reminder routines

A 0032-compatible native harness advertises both `routines` and
`unattendedTurnGuard`. The Agent enables authoring when an executable open
also confirms a non-null guard. Check `conversationCapabilities.routines`
after that open. Routine authoring requires an executable open in this Agent
process, including for offline writes after a restart. Guard evidence stays
in memory and each connection obtains it from its own executable open.
The bundled one-off harness reports a zero routine cap.

Set `AgentConfig.harness.config.limits.unattendedTurns` to a positive safe
integer or `"unlimited"` to enable the guard on session creation or on the first executable
open that enables it for an existing session. There is no default. The
harness persists the bound value and later opens can omit it. Setting a
different value fails with `invalid_config`. Explicit configuration on a
peer lacking support fails as incompatible. Inspection cannot enable the
guard.

`"unlimited"` sends `9007199254740991` (`Number.MAX_SAFE_INTEGER`). The
guard stays on and keeps counting, with a limit high enough that it
effectively leaves unattended paid turns uncapped. A spending cap is
still a TODO. Both spellings bind the same numeric value.

The guard counts consecutive turns per channel that begin without
owning-host participant input. A taken participant item resets the count.
Automated work should use notices. When the limit is exhausted, the
channel's routines wait for eligible participant input and contribute no
routine wake. No disposition is emitted when the guard holds work.

Use the existing reminder API to author a routine after startup.

```ts
import type { ReminderCreate } from "@qlairoslabs/acp-client";

export const checkQueue = {
  text: "Check the queue and summarize new items.",
  schedule: { every: 600_000, count: 6 },
  missedRuns: "coalesce",
  overlap: "skip",
} satisfies ReminderCreate;

export const reviewCalendar = {
  text: "Review today's calendar.",
  schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Paris" },
  expiresAfter: null,
} satisfies ReminderCreate;
```

Pass either input to `conversation.reminders.create(input)`.

- Intervals take milliseconds and an optional epoch-millisecond `startAt`.
  The first occurrence defaults to acceptance plus one interval. Cron accepts
  five numeric fields with wildcards, lists, ranges and steps. Both day
  fields must match. Supply a timezone. The harness validates the zone and
  proves the spacing between occurrences.
- Use a positive safe integer `count` or an inclusive epoch-millisecond
  `until`. Omitting both allows the routine to continue indefinitely.
  Each processed occurrence consumes count, including skipped ones. A
  routine can remain active after `reminder_fired`.
- A schedule edit replaces the remaining recurrence and resets its anchor
  and bound. The schedule kind stays the same. Text, grace, policy and
  lifecycle edits preserve the anchor. Default grace is twice the time to
  the next calendar match, clamped to five minutes through 24 hours. Explicit
  durations and `null` are preserved unless replaced. Read a confirmed row
  for the next occurrence's expiry and any remaining count.
- `missedRuns` defaults to `coalesce`, which produces one notice for the
  live backlog. `skip` consumes it without a notice. `each` queues a
  bounded backlog. `overlap` defaults to `skip` and also accepts `queue`.
  The harness advertises a 600,000 ms minimum interval, 20 active routines
  per channel and 10 catch-up notices per routine per eligibility episode.
  The harness enforces its active cap.
- Offline mutations require durable storage and guard confirmation in this process.
  At startup, cancellations, pauses and other non-activating changes go
  before due work. Creates, resumes and schedule replacements wait for
  the connection's executable open and retain their original acceptance time.
  A held entry also holds any later changes to its ID. An entirely unsent
  create can be cancelled locally. A create followed by pause is sent live
  in order, and a due occurrence may commit between those requests. An
  offline schedule replacement can take effect after overdue work from the
  old calendar. Held changes alone do not launch the harness. If open
  confirms no effective guard, the harness can record
  `unattended_guard_required` when the queued activation is sent live.

If startup exhausts its reminder batch retries, correct the storage cause
and start again to replay the exact frozen batch. The harness does not
identify the failing entry. To recover by elimination, stop the harness,
call `conversation.reminders.discardExhausted(reminderId)` for one
reminder, then start the harness again. Repeat if the remaining batch still
fails. The call returns `true` when it removes that reminder's frozen
entries. Later pending entries for the same reminder stay queued. If they
target a discarded create that never committed, they can come back blocked
with `not_found`. Use `discardBlocked(reminderId)` to clear them.

Discard removes local intent only. If the harness already committed a
discarded create, the reminder can still fire and the next startup sweep
will show it as a confirmed row. Check that row before creating a new
reminder. A new ID creates a duplicate if the original is still alive.

Routine events are live, and identical frames are all delivered. An
`expired` disposition counts occurrences. The client refreshes the row to
learn the remaining count, next run and terminal state. Within one commit a disposition precedes the fire
it describes. A migration hold precedes the updated row, whose state is
`blocked` with `blockedReason: "invalid_schedule"` and `timezoneMigration`.
The row remains visible and contributes no wake while held. Use confirmed
rows after reconnect.

#### Cold wake and idle stop

Only an Agent holding the file-backed SQLite owner lock arms a cold wake.
While running, the harness owns reminder scheduling. While stopped, the
host uses the earliest eligible deadline, including any earlier validation
wake from a pending change. Validation can launch the host early without
moving the reminder's schedule. Paused or suspended work contributes no
eligible deadline from the harness. Executable opens and deadline events
share a revision fence for the same session. Older revisions and conflicting
values at the same revision are ignored, and conflicts are logged. Only a
replacement session starts a new fence.

During `agent.nativeHarness.stop()`, the host drains deadline updates from
the stopping connection and rearms the cold wake from the stored index when
stop finishes. `agent.close()` clears the timer and retains the stored wake
for the next Agent open. Each cold timer
wait is capped at 60 seconds and the wall clock is checked again before
launching. Wakes only run while acp-client is running. Starting the process
and reopening its session adds delay. If acp-client dies after the harness
commits a new deadline but before acp-client saves it, the next eligible
open recovers it. The reminder can then run late or expire.

Configure optional idle stop under `AgentConfig.harness`. A positive
`idleStopMs` enables it. Omit it or set it to zero to leave it off.
`idleStopWindowMs` defaults to zero, and an attached conversation can
override it through its runtime settings. The host uses the largest window
for channels with active confirmed reminders. The optional `reminderTimer`
injects a clock and cancellable timer for wake and idle checks. Its
`ReminderTimer` shape is structural. Supply `now(): number` for the current
epoch time in milliseconds and `set(delayMs, task)` to schedule `task` after
that many milliseconds. Return a `() => void` cancellation function from
`set`. Without an override, the host uses the wall clock and unref'ed timers.

Idle stop waits until local work is clear, then asks the harness to stop
atomically with `session/stop { ifIdle: true, unlessDueWithinMs }`.
The harness can refuse with `busy` or `next_due_soon`. A refusal leaves
the session running. Work that arrives after a successful idle stop can
start it again.

### Restart the native agent and apply live settings

Use `await agent.previewNativeRestart()` to get `conversationCount` and
`conversationIds` for a confirmation dialog. The preview includes active
native conversation records, including ones whose harness channel is created
on first use. ACP conversations are outside its scope.

```ts
const preview = await agent.previewNativeRestart();
const result = await agent.restartNative({ when: "idle", config: nextHarnessConfig });
```

`when: "idle"` waits for active turns, approvals and queued native input
across the agent, then uses the harness's atomic idle stop. Use
`waitForNativeIdle({ signal })` to wait without restarting. An idle wait is
a snapshot and new input can arrive after it resolves. Suspended work
with queued input can keep the wait pending. Supply an abort signal when
the user can cancel the wait. `when: "now"` requests interruption of
running turns and restarts the shared native process. The harness retains
its durable queue and reminder wake. Closing the Agent cancels idle waits.

The executable open takes the replacement `config` and optional
`functions` catalog. Omit either to keep the Agent's current setting.
Pass `functions: null` to clear application-supplied functions.
The harness applies its normal configuration precedence and compatibility
checks, including a managed configuration sidecar when present. The
Agent uses the new settings for subsequent opens in the same process.
Persist application configuration separately if future Agent instances
need to supply it.

`subscribeNativeRestart(listener)` returns an unsubscribe function.
The listener receives the same `restarted` or `restart_failed` result
as the caller, with interrupted harness turn IDs and per-conversation
outcomes. A `reconnected` channel was reconciled by the replacement
open. A `deferred` conversation has no channel in that open and can
materialize on use. On failure the result includes the error. Native
conversation handles retain their identity and subscriptions.

Read `agent.channelSettingsLive` for channel-scoped edits, session-wide
tool controls and settings to defer to an executable open.

- `applyNativeChannelSettings(id, { displayName, policy, lifecycle })`
  uses the ordered channel change path. A running harness applies it
  live. A stopped harness stores it for its next open. `policy` selects
  an existing named policy. A policy-only change keeps the channel
  name. Pass `null` to clear a name or policy. The lifecycle values
  `"suspended"`, `"open"` and `"retired"` map to suspend, resume and
  delete. To delete the local conversation and its records as well,
  use `agent.conversations.delete(id)`.
- `applyNativeToolSetting(name, operation)` enables or removes runtime
  tools, or revokes or restores revocable tools. It requires a running
  harness. The operations affect the whole session. Per-channel access
  can be restricted by the channel's named policy.
- Named policy definitions, the default policy, model, system prompt and
  tool catalog take effect on executable open. The native wire has no
  participant-roster edit for an existing channel. An open alone cannot
  replace that roster, so hold or refuse that edit. Unsupported
  channel fields return `channel_settings_not_live` with the field
  names, without applying any part of the patch.

### Native turn metering

Agent-owned native conversations meter turns by default (`best_effort`). The
native path ignores a consumer-supplied `inferenceSource` and pricing policy.
The source is scoped to `<Agent id>/<channel id>` and reads bounded pages from
the harness's model-call ledger for the exact channel and wire turn ID. Read
`result.metering` or the persisted metering operation. Native per-call usage
events and native values in `TurnResult.usage` are deferred.

`nativeUsage` carries observed call and attempt IDs, outcomes, and usage fields,
or an unavailable reason. Missing or still-running attempts stay unmeasured.
A partially measured turn includes a reason. For measured native usage,
provenance is always `native_ledger` with unknown routing, partial attribution,
and no certification ID, even when every attempt was measured. An empty scan,
an unavailable host, or an undispatched turn gives unavailable usage. A prompt
cancelled while still queued may have no metering record. The current wire
leaves provider and model identity unknown, so measured native usage has
`pricing_unavailable`.

SQLite upgrades schema 20 to 21 on open. The upgrade is one-way. Older code
refuses a schema 21 database. The per-channel cursor lives in the metering
state. The bounded proof lives on the operation index row and survives when
operation detail is pruned.

A failed final save can replay under the same operation ID when the write-ahead
record was staged. If staging and final save both fail, a later close can
recover the sealed calls as unaccounted usage of an earlier turn.
`nativeUsage.earlierEvidencePending` means an earlier turn is still awaiting confirmation
that it ended.

The turn's usage and `state.totals` carry attributed usage. Read totals from the
record's `nextState.totals` or from `(await persistence.metering.state(id))?.state.totals`
for conversation `id`. A later close can record earlier-turn evidence in
`nativeUsage.unaccountedEarlierCalls` and accrue measured tokens once in
`state.unallocatedUsage`. These additions represent unaccounted usage of an
earlier turn. Between-turn usage remains unsupported. Attributed and
unallocated tokens together cover known spend and may still be a lower bound.
If only truncated proof survives, later-sealed attempts outside the retained
proof appear as unmeasured. Earlier evidence can also list an already-counted
attempt as unmeasured when its ID was omitted from proof. The unmeasured count
is an evidence count and cannot be summed as lost spend.

Native `billing_required` throws `MeteringPreflightError` until the harness can
attest `native-harness@1` sealed per-turn accounting. Certification still needs
provider and model identity, normalized cache categories, reported cost and
currency when available, attempt purpose, and a sealed turn manifest that can
attest zero usage. Between-turn billing needs a harness producer for calls
without turn ownership and a bounded collection path while idle.

### Offline native rehearsal

From the repository root, run the checked-in multi-minute fixture:

```sh
bun run test/native/rehearsal-cli.ts test/native/fixtures/rehearsal-two-minutes.jsonl 150000
```

The driver creates a fresh local harness home and uses a scripted stdio child.
The fixture schedules two bursts and a final notice after idle gaps. Its
policy allows only `notify_channel` and the test callback `quiet`, which
waits up to two seconds and has a five-second tool deadline. The command
requires no provider credentials or manual answers. It checks exact
consumption, reports input outcomes and callback effects, compares reply IDs
against bounded history reads at a settled revision, and reports the child
exit code. Full inference-request capture is off. Longer JSONL fixtures use
the same command with a deadline in milliseconds. Deterministic tests handle
manual barriers and process replacement in code.

### Functions the model can call

Register functions in `harness.functions.tools` before the Agent starts.
The host declares the handler names during initialize and sends the tool
catalog on every executable session open or create. Set `defaultPolicy` and
`policies` under `harness.config`. The harness uses those policies to decide
which tools to offer and whether a call needs approval. It validates the
arguments against `parameters` before calling the handler in this process.

`harness.config.system` supplies the complete consumer system text. At the
next executable open, changing it replaces that text for subsequent model
requests in the same saved session. The harness still appends its own
instructions and retains the conversation history. To apply a different
configuration, close the Agent and open it with the new configuration and
the same persisted Agent and harness home.

```ts
harness: {
  home, config,
  functions: {
    defaultDeadlineMs: 60_000,                    // optional; without it a call has no deadline
    tools: {
      lookup: {
        description: "Look up an order",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        handler: async ({ id }, { signal, channel }) => findOrder(id, signal),
      },
      refund: { group: "revocable", description: "...", parameters: {...}, handler: refund },
      export: { group: "runtime", enabled: false, description: "...", parameters: {...}, handler: exportData },
    },
  },
},
```

- **Groups.** `fixed` (default) cannot be removed while running. `revocable`:
  `agent.nativeHarness.revokeTool(name)` and `restoreTool(name)`; the harness
  stores this with the session, so it survives restarts. `runtime`:
  `enableTool(name)` and `removeTool(name)`; the selection lives in this
  process and is sent again when the harness reopens.
- **Why a tool cannot run.** `agent.nativeHarness.tools()` lists each tool
  with `available` and a reason (`revoked`, `not_enabled`, `handler_missing`).
  Policy is separate: a tool the conversation's policy denies is not offered.
- **Handlers.** The second argument contains `invocationId`, `channel`,
  `turnId`, `tool`, `policyNames` and `signal`. `policyNames` comes from
  the harness authorization snapshot. The names have no precedence by order.
  Return a JSON value as the tool result. Throw `FunctionError(code, message)` for
  a failure the model should see. `signal` aborts when the harness stops
  waiting: the tool's deadline passed, the turn was interrupted, or the harness
  stopped. A value returned after that is ignored.
- **Quiet handlers are fine.** A native turn is not cancelled by
  `operationLifecycle` silence limits. The harness enforces the model,
  approval and tool deadlines. `agent.nativeHarness.status()` shows each
  running turn's `activeTurn.phase` (`model`, `approval` or `tool`, since when,
  and the ID it concerns).
- **Deadlines.** `deadlineMs` on a tool overrides `defaultDeadlineMs`. When it
  passes, the model receives a timeout result that says the effect is unknown,
  and the turn continues.
- **Large results.** A result over 16 384 bytes is written to a private
  directory (`resultDirectory`, or a temporary one removed on stop) and the
  model receives a preview and an ID. It reads parts with the built-in
  `read_tool_result` tool. Only the conversation that produced a result can
  read it. Results expire after `resultTtlMs` (24 hours by default).
- **Records.** `agent.nativeHarness.toolInvocation(id)` and
  `toolInvocations(turn)` return each call's state. A call that was dispatched
  but has no recorded result (crash, lost connection, interrupt) is
  `interrupted` with `effect: "unknown"`. It is never run again automatically.

#### Native MCP servers

Configure native servers in `harness.config.mcpServers`. The harness
supports stdio and Streamable HTTPS. `agent.nativeMcpStatus()` reports
negotiated transports and per-server state. Restart results include
the same MCP status snapshot. A stopped host reports its last snapshot
as stale.

The npm package installs the MCP SDK and Undici as optional dependencies.
If an install omits them, the configured MCP entries report
`state: "unavailable"`, with `reason: "discovery"` for stdio or
`reason: "connect"` for HTTPS. These statuses describe the failed stage
without exposing credential values. Install the optional dependencies to
use MCP. Other native features still work without them.
A failing MCP server leaves the harness running. A plain HTTP 500 on discovery marks that entry unavailable, and on a tool
call the model sees one sanitized `mcp_uncertain` result with no replay. Other channels and servers keep working.

```ts
import type { AgentHarnessConfig } from "@qlairoslabs/acp-client";

export function withNativeMcp(
  config: AgentHarnessConfig["config"],
  getAuthorization: () => Promise<string>,
) {
  return {
    config: {
      ...config,
      defaultPolicy: "guest",
      policies: {
        owner: { fallback: "allow", tools: {}, mcp: "allow" },
        guest: { fallback: "allow", tools: {}, mcp: "deny" },
      },
      mcpServers: {
        docs: { transport: "stdio", command: "/app/bin/docs-mcp", args: [] },
        account: { transport: "http", endpoint: "https://example.com/mcp",
          headers: { Authorization: { runtime: true } } },
      },
      limits: { ...config.limits, mcpCallTimeoutMs: 5_000 },
    },
    mcpRuntimeHeaders: async () => ({ account: { Authorization: await getAuthorization() } }),
  } satisfies Pick<AgentHarnessConfig, "config" | "mcpRuntimeHeaders">;
}
```

Merge those fields into the Agent's `harness` settings. Only the trusted
owner supplies `mcpRuntimeHeaders`. The callback runs for every
executable open or create request, including retry, reconnect and restart.
It can resolve refreshed credentials. Header names are case-insensitive.
The encoded runtime headers are limited to 8 KiB total and 2 KiB per value.
Larger material fails locally with `mcp_runtime_headers_too_large`.
Missing or empty material disables that server entry before it connects,
while other servers can still start. Keep credentials out of configuration,
prompt content and metadata. Runtime header values are never persisted.

On an attributed prompt, the trusted caller can select an existing policy
for that input with `conversation.promptFrom({ participantId, text,
nativePolicy: "guest" })`. Object-form `prompt` accepts `nativePolicy` too.
When the caller omits it, the harness uses the channel's selected policy,
then the session default. Omitting `nativePolicy` denies MCP only when that
fallback policy has no MCP grant. An owner channel still needs an explicit guest
policy on guest input. Participant kind, sender ID, display name and text
never grant MCP access. Do not populate `nativePolicy` from participant input.

The `mcp` grant covers all `mcp__` tools for that named policy. Every
taken or inherited contributing policy must explicitly allow MCP. A
mixed owner and guest turn, or a policy with no `mcp` value, denies it.
The local deterministic fixtures verify this transport and policy wiring.
Approval behavior in deployments using agents-tools or door integrations
requires separate acceptance.

Tool changes need a running harness: `revokeTool` and the others fail with
`HarnessUnavailableError` while it is stopped.

Not available on a native conversation yet: `startFresh` and anything that
needs a fresh context (`conversationCapabilities.freshContext` is `false`),
handoff, modes, config options, provider session listing, adoption, and a
local user-message record for native prompts. See [native turn metering](#native-turn-metering)
for available usage evidence and its limits.

## Orchestrator and worker delivery (experimental)

Enable the orchestrator on the same Agent as the native harness. It requires
`capture.message: "content"` and persistence capabilities for workers and worker
delivery. SQLite provides both. Use an ACP adapter for the worker pool. The
example adds a native `owner` policy that can call the delegation tools and a
separate policy for approvals requested by workers.

```ts
import { Agent, type AgentAdapter, type AgentHarnessConfig } from "@qlairoslabs/acp-client";

export async function openWorkerPool(
  directory: string,
  worker: AgentAdapter,
  model: AgentHarnessConfig["config"]["model"],
) {
  const delegation = { use: true, scope: "all", redirect: true, maxOpen: 2 } as const;
  return Agent.open({
    persistence: { kind: "sqlite", path: `${directory}/agent.sqlite` },
    adapters: { main: { kind: "native" }, worker },
    defaultAdapterId: "main",
    capture: { message: "content" },
    harness: {
      home: `${directory}/harness-home`,
      config: {
        version: 1, system: "Delegate bounded tasks and report the results.", model,
        defaultPolicy: "owner",
        policies: { owner: { fallback: "deny", tools: {
          delegate: "allow", check: "allow", list: "allow", stop: "allow",
        } } },
      },
    },
    orchestrator: {
      workers: { adapterId: "worker", cwd: directory, limit: 2, idleStopMs: 60_000 },
      ownerPolicies: ["owner"],
      defaults: { delegation, workerPermissions: { default: "ask" } },
      policies: { owner: { delegation, workerPermissions: { default: "ask" } } },
    },
  });
}

export async function workerControls(agent: Agent, handle: string) {
  const workers = agent.workers;
  if (!workers) throw new Error("Enable the orchestrator first");
  const summary = await workers.check(handle);
  return {
    summary,
    list: () => workers.list(),
    retryBlockedDelivery: () => workers.retryDelivery(handle),
    stop: () => workers.stop(handle),
    delete: () => workers.delete(handle),
  };
}
```

The harness exposes `delegate`, `check`, `list` and `stop` as native tools.
Grant them in the harness policy as well as configuring the corresponding
orchestrator policy. For `delegate`, send `{ text, about? }` to create a
worker, or include `worker` to send to a known handle. `check` and `stop`
take `{ worker }`; `list` takes an empty object. These names are reserved
while native delegation is enabled. The trusted host can also use
`agent.orchestrator` with a consumer actor. Use
`agent.events.subscribeWorkers` for worker lifecycle events. Event kinds are
`worker_opened`, `worker_busy`, `worker_idle`, `worker_replied`,
`worker_reloaded`, `worker_dropped`, `worker_redirected`, `worker_failed`
and `worker_stopped`.

A busy worker follows its current assignment. Its current giver can steer
with another message for the same handle. A different giver needs redirect
authority and `redirect: true` to take over the destination. Without a redirect,
a send from another giver reports `busy` and queues nothing. Use
`assignment: "new"` to replace the assignment. Outstanding forwarded
approvals stay with their original giving conversation. The giving
conversation answers forwarded requests with `answerPermission`. Non-owner
requests omit persistent approval options. Without an eligible answerer,
an ask is refused.

`workers.limit` bounds the active pool. Policy can further narrow scope,
redirection and the maximum number opened by a giver. An idle worker may be
evicted to make room. If no slot can be freed, sending reports
`no_worker_free`. Idle stop defaults to ten minutes and accepts `false`
to keep idle connections open. The next send reloads a stopped worker.
`workers.delete` returns the provider cleanup outcome. Consumer defaults
apply to consumer work or when no native policy contributes. When several
named policies contribute, their restrictions compose and all must be in
`ownerPolicies` to grant owner authority.

The Agent records the assignment before dispatch. A finished worker leaves
one saved outcome, tied to that assignment and destination. An ACP
destination receives an out-of-band message for the next prompt. A native
destination receives a harness notice. Restart recovery looks for the saved
result by assignment ID, and retries eligible notices without running the
worker again. A lost result can be reported as uncertain. `check` and
`list` show the latest outcome and delivery state when available. Native
results may be absent until the harness opens. Delivery states are `pending`
(awaiting delivery), `delivered`, `blocked_policy` (policy rejection), and
`failed_destination` (the destination is missing or retired). `retryDelivery` explicitly
retries only the newest policy-blocked delivery. A retired or missing
destination remains a failed delivery.

From the source checkout, run the offline smoke test with
`bun smoke-tests/orchestrator/run.ts`. Live mode requires explicit approval
for spend, `ACP_ORCH_LIVE=1`, `OPENROUTER_API_KEY`, local Codex binaries
and a separately authenticated disposable `ACP_ORCH_CODEX_HOME`. Use
throwaway work, supervise with the documented external wall-clock cap, and
never set the flag for an offline run. The runner caps native requests and
worker submissions. The Codex CLI's internal calls are uncapped.
[Smoke-test instructions](smoke-tests/orchestrator/README.md)


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
    permissions: { default: "ask" },
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

## Choose what each conversation persists

One Agent has one set of persistence defaults (`capture`, the audit log's `capture`, `meteringPersistence`), and every
conversation it owns uses them. A consumer that hosts different kinds of conversations in one Agent (user chats,
agent-to-agent channels, adopted sessions) can persist less for some of them with a **resolver**:

```ts
const agent = await Agent.open({
  persistence: { kind: "sqlite", path },
  adapters,
  capture: { message: "none" },                           // default: keep no message content
  checkpointing: {},
  auditLog: { directory, capture: { message: "none" } },
  conversationPersistence: ({ agentConversationId, title, metadata, participants, adopted }) =>
    isUserChat(agentConversationId)
      ? {
          capture: { message: "content" },                // keep content, and so recovery
          auditLog: false,                                // stay out of the audit stream
          meteringRecords: "none",                        // no detailed metering history
        }
      : undefined,                                        // everything else: the Agent's defaults
});
```

The resolver returns an **override** over the Agent's defaults, or `undefined`: keys it sets replace the Agent's value
(`protocol` counts as one key, so its level and method filters are replaced together), keys it omits follow the Agent,
and `undefined`, `{}` or `{ capture: {} }` mean the Agent's defaults. The library never infers a policy: what a
conversation *is* stays the consumer's business, and the context carries only what the library knows (id,
participants, title, metadata, and whether it was created by adopting a provider session).

| key | what it changes |
|---|---|
| `capture` | The canonical record kinds stored, and at what level (`none`, `metadata`, `content`, `raw`). |
| `auditLog` | `false`: no audit entry about the conversation, and none caused by its records (`identity` entries, internal-inference entries). `{ capture }`: what its audit entries capture. Agent-scope kinds (`agent_lifecycle`, `identity`, `internal_inference`) cannot be tuned per conversation. Requires the Agent to have an audit log (`false` is accepted anyway). |
| `meteringRecords` | Retention of the detailed metering records of the conversation, including those of its internal inferences: `"all"`, `"none"` or `{ retain: n }`. The bounded metering state is always kept. |

**Contract.** The resolver is synchronous, free of side effects, and stable for a given conversation. It is called when a
conversation starts (`create()` and `open()`), once, and the result is held for the life of the live conversation: a
change in the resolver's answers applies the next time it is opened. It is also called, just before the write, for
writes about a conversation that is not live (a checkpoint finishing, an audit observation). A resolver that throws, or
returns something invalid, is a caller mistake: the start rejects with that error and writes no row, no error record and
no provider session. A background write whose policy cannot be resolved fails that write; it is never done under the
Agent's defaults, which could record more than the consumer allowed.

**What it covers.** Every write made for the conversation: its records and audit entries, the error records of a failed
start, load or recovery, the checkpoint completion record (stored at the conversation's `native_action` level, and audited as
the conversation says), and the detailed metering records of its inferences. Always persisted, whatever the policy: the
conversation row, provider-session mappings, the bounded metering state, identity delivery cursors, internal-inference jobs.

**Audit fingerprints.** Each audit entry carries the fingerprint of the policy that projected it: for a conversation with
its own audit capture, that conversation's; for everything else, the Agent's. `agent.audit.status().captureFingerprint` is
always the Agent's own.

**Checkpointing.** Checkpoints summarize stored messages, so a conversation that stores none (`message: "none"`) is never
checkpointed, `checkpointing.request()` for it does nothing, a lost provider session throws instead of recovering, and it
contributes nothing to other conversations' identity. An Agent may therefore enable checkpointing with a default of
`message: "none"` and let the conversations that need recovery override to `content`. `message: "metadata"` is refused
while checkpointing is enabled, at the Agent and per conversation.

**Limits.** A policy is not retroactive: records and audit entries already written stay. A conversation still *receives*
identity from its siblings (controlling that needs a per-conversation identity switch, not provided). One Agent is one
SQLite file and one audit destination; different storage locations need a second Agent.

## Send a message while a turn is running

A prompt sent while a turn runs waits. How it waits is its **delivery**:

- `"queue"`: it runs after the running turn ends, as its own turn.
- `"steer"` (the default): it is delivered at the next tool boundary. The library cancels the running turn once a
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

Set the default for prompts that do not say, per Agent or per conversation. It is `"steer"` unless you
change it (before this was `"queue"`; set `busyDelivery: "queue"` to keep the old behaviour). With `"queue"`
as the default, a failed turn holds every later prompt until one is sent with `delivery: "steer"`; see
[Operation lifecycle](#operation-lifecycle-and-automatic-provider-recovery).

```ts
const agent = await Agent.open({
  // ...
  conversationDefaults: { busyDelivery: "queue" },
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
| `message_status { id, status, turnId? }` | Live delivery progress for an individual prompt. See [Message status](#message-status). |
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

### Where checkpointing starts

Summarizing stored messages is a prompt, and a long history does not fit one (Codex refuses a message past 1,048,576
characters), so an adopted conversation's checkpoints never look at the history that came before its adoption. When the
conversation checkpoints, adoption places a **floor**: a checkpoint covering everything up to 50 messages before the end of
what is stored (or the recap, when the history is shorter than that).

- With a recap, the floor's summary *is* the recap. It stands for the whole provider history, imported or not, and a
  recovery seeds the recap plus the messages after the floor.
- Without a recap, the floor is a baseline with no summary: a recovery seeds only the messages after it, and identity
  delivers the stored messages as it would without a checkpoint.
- A conversation with no recap and 50 messages or fewer stored gets no floor; its first scheduled checkpoint summarizes them.
- Every stored message stays readable (listing, pagination, search); only summarizing starts after the floor. Checkpoints that
  follow chain from it.
- The checkpoint schedule (responses 1, 5, 10, ...) counts responses after what the adoption stored, as for a new conversation.
- A checkpoint whose records do not fit one prompt (700,000 characters) fails with `checkpoint_source_too_large` and is not
  retried. Only a conversation that stores a very long run of messages between two checkpoints can reach it.

### Limits to know about

- Replays differ by harness (measured on Codex and OpenCode with `smoke-tests/session-replay-probe`): both send message
  boundaries, tool calls and, for OpenCode, thoughts; neither sends timestamps or usage. Codex replays the tool call of a turn
  that was cancelled mid-tool after the next turn's user message, and it is imported where it arrives.
- The recap is a hidden turn on the adopted session itself, so the provider's own history then contains the question and the
  answer. The model is asked not to use tools; ACP gives no way to forbid them for one turn. A later adoption of the same
  session does not import that question or its answer as turns.
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
and ignore revisions older than the one already rendered. `startedAt` is when the item's
first revision was written and `updatedAt` when this one was; `timestamp` is a deprecated
alias of `updatedAt`.

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
    permissions: { default: "ask" },
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
`sessionConfiguration` persistence policy and reapplied during loading. Selecting the value an
option already has (the harness reports it, and with a transcript it is already the explicit
restoration target) is a no-op: nothing is sent, recorded or emitted, so re-applying
settings on every start does not fill the history with repeated changes. Agent-owned
conversations do not restore their settings when reopened; a consumer that wants them pinned
re-applies them, and only real changes are recorded.

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

## Operation lifecycle and automatic provider recovery

`conversation.state.operation` is null when no model request is running. While running it exposes
`operationId`, `kind`, `stage`, `startedAt`, `lastOutputAt`, `toolsInFlight` and optional cancellation
reason/time. `operation_stage_changed` fires on stage changes; read the snapshot for current output
timestamps. Internal-inference attempt handles expose the same information at `handle.snapshot.operation`.

Set `operationLifecycle` on `Agent.open()` or a detached conversation:

```ts
operationLifecycle: {
  turns: { firstOutputMs: 600_000, nextOutputMs: 900_000 },
  internalInference: { firstOutputMs: 600_000 },
  recap: { nextOutputMs: 900_000 },
}
```

Individual inference limits accept `false`; tools and pending permissions suspend output deadlines.
`toolMs` is optional and disabled by default. Each adapter may set `cancelGraceMs` (default 30 seconds).
Permission handlers may accept a second optional AbortSignal; discard UI and stop asynchronous work
when it aborts. A late permission answer cannot change the cancelled outcome.

A stalled turn rejects with `OperationStalledError`, including `phase` (`no_response` or
`incomplete_response`), `messages`, `operationId`, `metering` and optional `followedBy` steer IDs.
Its partial response is failed, and its metering outcome is cancelled. Forced interrupts and steers
resolve cancelled and expose `cancel: forced`; acknowledged cancellation reports `acknowledged`.

After a provider exit or forced stop, keep the conversation and send the next prompt. The library
loads its provider session automatically and emits `provider_reconnected` with `via: loaded` or
`recovered` (Agent-owned checkpoint recovery under the configured policy). The snapshot connection
moves through `disconnected`, `reconnecting`, and `connected`. A transient reconnect failure fails
that prompt, and the next prompt tries again.

When the harness no longer has the session, the conversation applies the same rule it applies when
opened: checkpoint recovery for Agent-owned conversations (`onLoadFailure: "recover"`), the
`continuation.strategies` list for SessionManager conversations (only `new_from_transcript` or a
consumer continuation can replace the session; the default list is load only), and
`providerSession.onFailure` otherwise (`"new"` starts a fresh session without the earlier context and
reports `via: fresh`). When the rule has nothing left, the prompt rejects with the reason, `promptability`
reports `continuation_unavailable`, and later prompts are refused until the conversation is reopened
with a different policy. SessionManager's existing library-crash uncertainty recovery remains separate.

Harness behaviours seen after a crash (test13, 2026-10-19):

- **OpenCode finishes the interrupted turn first.** When a reloaded session has a turn that was cut
  off (the process was killed or frozen mid-turn), OpenCode completes that interrupted request before
  answering the next prompt. The reply to the next prompt can therefore start with the old turn's
  output, and it can be silent for longer than usual while the old request runs. The failed turn was
  already reported as an error; treat the start of the next reply accordingly, and keep the silence
  limits generous on OpenCode (the defaults are).
- **Codex archives a deleted session.** Loading it fails until it is unarchived with
  `codex unarchive <id>`; the library treats it as missing, so the conversation's continuation rule
  applies (a replacement session, when the rule provides one).

After a turn the provider received fails (stalled, crashed, or errored), queued messages remain held.
A prompt that fails before reaching the provider holds nothing. Read `state.pendingHold`,
`pendingMessages[].heldBy` and the `message_held` / `message_released` events. Steers waiting after a
stall are sent as the recovery prompt, up to the next queued message (not including it); steers after
that message run after it. Send a message with `delivery: steer` to continue; its successful
completion releases queued messages in order (internal prompts such as a recap do not release). Explicit queue delivery while held
adds to the hold, including when idle. `withdraw()` remains available.

**If your default is `busyDelivery: "queue"`**, every prompt sent after a failure joins the hold, so
nothing runs until you send a prompt with `delivery: "steer"` explicitly (or withdraw). Give the user
a way to send that steer, for example when `state.pendingHold` is set. These message events are live
observations; consumers may store them if needed.

Control requests (initialize, new, load, list, delete, config, authenticate) have no deadline. They
end when the harness answers or when the process exits. A large session can take a minute or more to
load; that is not treated as a failure.

Degraded PTY mode observes raw terminal output but cannot identify ACP tools or permissions. Its
output silence limits are disabled by default to preserve long-running tools; explicit configured
limits still apply, and cancellation is bounded.
