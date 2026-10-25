# Migrating from 0.10.2 to 0.12.0

For agents-core and the webapp, which pin `@qlairoslabs/acp-client` `0.10.2`. This covers everything
since: `0.11.0`, the operation lifecycle (`0.11.2`), and the work done for the 2026-10-13
requirements list. `CONSUMER_GUIDE.md` is the full reference; this file says what changed and what to do
about it.

**Status.** 0.12.0 is on the library's `beta` branch, not yet pushed or published. Until it is,
point agents-core at a local checkout of the library to try it.

## Before you upgrade

- **Back up the SQLite agent databases.** Opening one migrates it to schema 16 (from 14, through 15).
  The migration is one way: an older library refuses the migrated file.
  - Schema 15 rebuilds `conversation_records` to admit a new record kind, and recovers `operationId` on
    older records from their record ids.
  - Schema 16 adds a blob table for kept media and an out-of-band delivery table, and rebuilds the
    message full-text index without inline bytes. On a large database the first open takes longer.
- JSONL transcripts and audit logs need no migration; they gain new line types (below).

## Breaking changes checklist

Each item says what changed and what agents-core has to do.

| # | change | what to do |
|---|---|---|
| 1 | **A prompt sent while a turn runs is steered by default** (`busyDelivery: "steer"`, was `"queue"`). | agents-core already passes `delivery: "steer"` when a turn runs. Elsewhere, set `busyDelivery: "queue"` to keep the old behavior. |
| 2 | **Silent turns now fail as stalled.** No output for 120 s after the request, or 180 s between outputs (tools and permissions pause the clock), fails the operation with `OperationStalledError` (`code: "stalled"`). Agent-owned conversations record an error record and mark the partial reply failed. | Handle `stalled` like other turn failures. Raise or disable limits with `operationLifecycle: { turns: { firstOutputMs, nextOutputMs } }` (`false` disables one). |
| 3 | **The conversation reconnects by itself** after the provider process exits or is force-stopped, on the next operation (`provider_reconnected`, `via: loaded \| recovered \| fresh`). | If agents-core retires a conversation whose provider died, it can keep it instead and prompt again. |
| 4 | **Queued messages are held after a failed turn** the provider received. Pending steers run after recovery; the next consumer turn that completes releases the hold. | Show `state.pendingHold` and `pendingMessages[].heldBy` if the UI lists pending messages. With `busyDelivery: "queue"`, send one prompt with `delivery: "steer"` to release. |
| 5 | **Cancelled results say how the cancel ended:** `cancel: "acknowledged" \| "forced"`. Pending permissions are answered as cancelled, and the permission handler gets an optional `AbortSignal`. | Nothing required. Use the `AbortSignal` to close a permission dialog. |
| 6 | **Every record carries `operationId`** (typed field), not only messages in their metadata. | Prefer `record.operationId` over `JSON.parse(record.metadata).operationId`; both work for messages. |
| 7 | **Appended out-of-band messages have no operation.** `appendAssistantMessage` used to give each its own operation id; now the record is standalone, at the sequence it was appended. | Don't expect `operationId` on appended messages. |
| 8 | **New record kind `cancellation`** (SQLite and JSONL; audit key `cancellation`). It has `requested` (reason: `steer`, `interrupt`, `stalled`, `stop`, `abort`) and `resolved` (outcome: `acknowledged`, `forced`, `too_late`, `failed`) revisions, under the cancelled operation. | `projectSqliteChatRecord` maps unknown kinds to activities, so these show up as `cancellation` activity items. Decide whether to show them (a turn shown as stopped or redirected after reload) or skip them. |
| 9 | **Timeline item ids for tool calls, permissions, thinking and activity change once**: items are now keyed by operation, so two turns reusing a provider id stay two items. Message ids don't change. | If agents-core stores timeline item ids (from `conversationTimelineItemId`), expect them to change once for those kinds. |
| 10 | **Message content can be blocks, not just a string.** A message with media or a named paste stores `PersistedContentBlock[]`: `text`, `pasted`, `media`. Plain text messages stay strings. | `projectSqliteChatRecord` keeps only `type: "text"` blocks, so a pasted block's text disappears. Include `pasted`, and render `media` blocks (below). Note that it joins text blocks with `"\n"`, while the library joins a message's text parts with nothing (separators are their own parts). |
| 11 | **Attachments go out as their real kind.** `prompt(text, handlers, attachments)` used to send every attachment as an ACP `image`. Now an image is an `image`, audio is `audio`, and anything else is an embedded file, which needs the agent's `embeddedContext`. An agent that can't take the kind refuses the prompt with `agent does not support <kind> copies`. | Expect that error for non-image attachments to agents without that support. Claude's adapter advertises embedded context but silently drops binary files (PDFs), so send those to Claude as links (`mode: "link"`); text files work. |
| 12 | **Attachments are recorded** on Agent-owned conversations, as media blocks with name, type, size and hash (`keep: false`, no bytes). The user message's `content` becomes blocks when it has attachments (see 10). | Nothing required; it's the start of dropping the `chat-attachments` side store (below). |
| 13 | **Presentation items' `timestamp` is deprecated**, an alias of the new `updatedAt`. Timeline items gain `startedAt` and `updatedAt`. | Show a message's time with `startedAt`. |
| 14 | **`AgentConversation.listSessions()` is deprecated** and now throws when the harness listing fails, instead of silently returning the catalog half. | Use `agent.conversations.list()` for conversations and `agent.conversations.listProviderSessions()` for harness sessions. |
| 15 | **`setConfig` with the value the option already has does nothing**: no request, record or event. | Nothing required. The Hub's re-applied settings stop filling the history. |
| 16 | **`PromptPart` is renamed `CombinedMessage`** (steering's original messages of a combined prompt). `PromptPart` stays as a deprecated alias. | Rename when convenient. |

## The requirements, before and after

### 1, 2. Operation ids, and history pages that don't cut turns

`identity-store.ts` reads recent history with `listRecent({ limit })`, which counts records, so a page can
start in the middle of a turn.

```ts
// now: N agent messages per page, each with what led to it; nothing is split
const page = await persistence.records.listRecent(conversationId, {
  agentMessages: 20,               // the page unit; the cut is right after an agent message
  fold: true,                      // timeline items instead of records
  detail: "summary",               // tool calls without input/output
  ...(cursor ? { olderCursor: cursor } : {}),
});
page.items;          // ConversationTimelineItem[]
page.olderCursor;    // next older page
page.truncated;      // the page hit `limit` (default 2000)

// a tool call's full input/output, on demand
const record = await persistence.records.get(recordId);
```

- Every record lands on the page where its item began, so an item never spans two pages.
- A cursor remembers its unit; a records cursor can't be used for an agent-messages page.
- `records.list(id, { operationId })` filters by operation.
- Without the new options, `listRecent` behaves as before.

### 3. How a turn ended

The `cancellation` records (checklist item 8) say whether a turn was stopped, steered or interrupted,
and whether the cancel was acknowledged or forced. A failed turn already had an error record.

### 4. Re-applied settings

Not recorded any more (checklist item 15).

### 5. A message's time

`ConversationTimelineItem.startedAt` is the first revision's time, `updatedAt` the latest. Messages are
also recorded `completed` when the next message or a tool call starts, with that time, instead of all
at turn end with one timestamp. A tool call now ends the message before it, also when the agent sends
no message ids.

### 6, 7, 10. Messages made of parts

agents-core keeps attachments in its own `chat-attachments` store (files under the agent's shared
directory, plus `prompt-records.json` joined to history by operation id). The library can now hold
them itself:

```ts
await conversation.prompt({
  text: "compare these",
  parts: [
    { kind: "image", data: bytes, name: "chart.png", mimeType: "image/png" },   // copy, kept by default
    { kind: "file", path: "/srv/files/report.pdf" },                            // copy or link, by size
    { kind: "file", path: "/srv/files/big.log", mode: "link" },                 // the agent opens it
    { kind: "pasted", text: longPaste, name: "error output" },                   // a named paste
    { kind: "text", text: "Answer in Spanish.", record: false },                 // sent, not recorded
  ],
});
```

- **A part's source:** `data` (bytes), `path` (a path or `file://` uri) or `ref` (a copy already kept).
- **`mode: "copy"`** sends the content in the prompt. **`mode: "link"`** sends a pointer and the agent
  opens the file itself; later edits or deletion of the file affect what history shows. Without a mode,
  a path goes as a link above 100 KB for files, 3.75 MB for images and 5 MB for audio (configurable:
  `Agent.open({ media: { thresholds } })`).
- **`keep: false`** records name, type, size and hash without the bytes. **`record: false`** sends the
  part without recording it. This is requirement 7: text for the provider only.
- **Where kept bytes go:** by default a table in the agent's SQLite database, written in the same
  transaction as the message. To keep them elsewhere, pass your own store:
  `Agent.open({ media: { store } })`, an object with `put`, `get`, `delete` and `list(owner)`.
- **What's recorded is controlled by `capture.media`** (`none`, `metadata`, `content`; default
  `content`), separately from `capture.message`, and per conversation through the persistence resolver.
- **Reading media back:** a message's `media` block has `kind`, `mode`, `mimeType`, `name`, `size`,
  `sha256`, and `ref` (kept copy) or `uri` (link). Get bytes with
  `(agent.media.store ?? agent.persistence.media).get(ref)`. Delete bytes with `agent.deleteMedia(ref)`
  (history keeps the metadata) or `agent.deleteMediaForConversation(id)`.
- **Search (10):** message search stays over text and pasted text. Files have their own listing and
  search over name, kind, MIME type and size: `agent.persistence.files.list({ agentConversationId })`,
  `files.search({ text: "report" })`.
- **Media the agent sends** (images, audio, links, embedded files) is recorded the same way and comes
  back as `result.messages[].parts`; `text` stays the text-only view.
- **Shared directories:** `conversationDefaults: { additionalDirectories: ["/srv/files"] }` declares
  directories to the harness, which applies its own permissions to links outside the workspace.
- Media is recorded on Agent-owned conversations only. The `SessionManager` / JSONL path can send parts
  and records a line per part (`[image chart.png]`).

**For agents-core:** with `keep: true` copies (or links into the shared directory) the
`chat-attachments` store and the operation-id join in `identity-store.ts` and `hub/index.ts` can go.
`session.prompt({ text, attachments })` keeps working as before (attachments become `keep: false`
copies), so this can be done later.

### 8. Out-of-band messages with media, delivered once

```ts
await agent.conversations.appendAssistantMessage(conversationId, {
  parts: [
    { kind: "text", text: "Here is the chart I sent you on Telegram" },
    { kind: "image", data: bytes, mimeType: "image/png", name: "chart.png" },
  ],
});
```

- `text` alone still works; media-only messages are allowed.
- The next successful turn delivers it once, in a `<messages-you-sent>` block, media included. After
  that it is ordinary history.
- If the agent can't take a part's kind, or its bytes are gone, the part is named instead
  (`[image chart.png: not supported by this agent]`), so the turn never fails because of it.
- Parts that aren't kept wait in memory until delivered. After a restart such a copy is named
  (`[image chart.png: not available]`).

### 13. Live message completion

No separate event: a message's record turns `completed` when the next message or a tool call starts
(see 5), and `agent.events` publishes that record as it commits.

### Not done, or done differently

| # | requirement | status |
|---|---|---|
| 2 | paging by operations | done by agent messages instead (above) |
| 9 | persist agent capabilities | not stored: they come from `initialize`, so start the session to read them |
| 11 | Claude thinking rarely persisted | not investigated yet |
| 12 | Codex steer handover delay | not investigated yet; it may be in agents-core rather than the library |
| 13 | live completion event | done through the completed record, no event |

## Also new since 0.10.2, not breaking

- Adopting a session the provider already holds: `agent.conversations.create({ adopt })`, with an
  optional recap, and `listProviderSessions()` to choose one.
- Per-conversation persistence through a resolver (capture, audit, metering retention).
- `agent.conversations.clearTranscript(id)` and `agent.conversations.delete(id)`, optionally at the
  provider.
- Operation visibility: the current operation's stage and last output time on conversation state.
- Codex per-turn usage counters in metering.

## Known gaps

- The media probes on real harnesses ran before the last fix to embedded copies' uri, and need a rerun.
- Codex's tool output (sent through `_meta` terminal chunks) is not captured yet: its tool calls show
  empty output.
- Claude's adapter silently drops binary embedded files (PDFs): its `promptToClaude` has no branch for
  blobs. Send them as links (`mode: "link"`); Claude's Read tool opens PDFs. A fix belongs upstream
  (map a PDF blob to an Anthropic `document` block).
