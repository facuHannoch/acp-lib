# Log: consumer fixes (branch `consumer-small-fixes`, from `operation-lifecycle`)

Source: `10-13-acp-client-requirements.md`, the four small items.

## 2026-10-19

- **5, item times.** `ConversationTimelineItem.startedAt` / `updatedAt`; presentation items
  `startedAt` (reader tracks the first revision's `ts`; live `AgentConversationPresentation` keeps
  a map by item id). Tests: consumer read (Agent), presentation (SessionManager, live = reload).
- **13, `message_completed`.** Emitted from `runPrompt` when the next message starts and at turn
  end (success and failure), once per message (`ended` flag). Message tracking now runs without
  persistence too; the flushes still write nothing there.
- **4, no-op settings.** `isUnchangedSelection` in the pump, before any event or record: the
  harness reports the value and, with a v2 transcript, it is already an `explicit_selection`
  restoration target. Any doubt (connection failure, no option) takes the normal path.
- **9, capabilities.** Checked: not persisted (only inside raw protocol records when protocol
  capture is on; the v2 `protocol_metadata` record type has no writer). Added
  `promptCapabilities` to the provider attachment descriptor and `ProviderSessionRecord`, written
  at all four append sites; SQLite schema 15 (`prompt_capabilities_json`, added by column check so
  rebuilt tables don't collide). Migration test v14 → 15.
- Full suite: 1045 pass.

## 2026-10-19, rework after review

Each proposal was re-checked against its original problem:
- **9 reverted.** Capabilities come from `initialize`; a consumer that needs them starts the
  session, as for configuration. Schema stays at 14.
- **`message_completed` removed.** The client already upserts message records by logical id; a
  completed revision is the signal. A separate event would need its own mapping.
- **5 / 13 root cause was the library**, not Codex: `afterPrompt` wrote every assistant message's
  completed record at turn end with one timestamp. Now `runPrompt` records a message completed
  when the next message or a tool call begins (`endAssistantMessage`), and passes `messageEnds`
  to `afterPrompt` / `promptFailed`, which keep those times and statuses; only the last message
  takes the turn's outcome.
- **Tool calls end messages.** `ResponseAccumulator.closeMessage()`, called by the client on a new
  `tool` activity (not `tool_update`). Without message ids, message → tool → message used to be
  one message. Test with the presentation fixture's `no-ids` mode (fails without the change).
- **Times:** presentation items gain `updatedAt`; `timestamp` deprecated alias. Timeline items keep
  `startedAt` / `updatedAt`.
- **4 checked:** Agent-owned conversations run with `persistence: false`
  (`conversation-manager.ts:873`), so `restoreOpeningConfiguration` is a no-op for them: they
  never restore settings. That is why the Hub re-applies. The skip stays; restoring settings for
  Agent-owned conversations is a separate item.
- Full suite: 1046 pass.

## 2026-10-20, item 1: operation id on every record

- Finding: the `operation_id` column existed and was indexed, filled from `metadata.operationId`
  (messages) or the record's own field (metering, error). Tool calls, thinking, activity,
  permissions and configuration only had the id inside their record id; native actions in
  `transitionId`; protocol lines nowhere. So most were stored without it.
- `operationId?` on the record envelope (write and read); the backend fills the column from it,
  `metadata` stays the fallback for old records. Capture reduction keeps it.
- Stamped at every write site: runtime records (`recordOperation`: a tool call keeps its announcing
  operation through `toolCallOperations`, removed at a terminal state), permissions (the tool's
  operation), configuration, native actions (`transitionId`), imported and recap messages, assistant
  snapshots, lifecycle messages, protocol lines (`runningOperationId`, set by the pump for prompt,
  handoff, set_config, set_mode).
- Not stamped: out-of-band messages and the checkpoint `native_action` record (written outside the
  conversation's operation queue).
- `records.list(id, { operationId })`.
- Schema 15 backfills `operation_id` from `<id>:runtime:`, `<id>:permission:`,
  `<id>:configuration:` record ids and native action `transition_id`. Migration test.
- Not tested: a tool update arriving in a later turn keeping the announcing operation (no fixture
  spans turns).
- Full suite: 1047 pass.

## 2026-10-20, end-to-end smoke test for operation ids

- `smoke-tests/end-to-end`: collects each turn's `operationId`, appends one out-of-band assistant
  message, and checks through raw SQL (`listStoredOperations`, `listStoredUnattributedRecords` in
  `queries.ts`) that the turns are operations in run order, each with its messages, that only the
  out-of-band message is outside any operation, and that `records.list({ operationId })` matches.
  Runs after the initial phase and after the reopen.
- It found a gap: the checkpoint `native_action` record had no operation id. Now stamped with the
  internal inference id that wrote the summary (`src/checkpointing/strategy.ts`).
- Deterministic run (`ACP_TEST8_ADAPTER=test`, recovery skipped): all PASS. Real harness not run.
- Appended (out-of-band) messages now carry their own one-record operation (`append-<uuid>`), so
  paging by operations can't drop them. The smoke test expects no record outside an operation
  (protocol lines aside). Deterministic run: all PASS.

## 2026-10-22, item 3: cancellations recorded

- Problem restated: after a reload, a turn cut short showed only `cancelled`; why (steer, Stop)
  was lost. `endedBy` / `followedBy` existed only on the live result. A cancel itself (ACP
  `session/cancel`) was stored nowhere by default (protocol capture is off).
- Options weighed: fields on the turn (the doc's suggestion), a timeline record of the cancel,
  marks on the steer messages, a per-operation row, inference. Chosen with the user: a
  mechanism-independent record kind, `cancellation`, so a non-ACP controller fits too.
- Written by the supervisor (`onCancelRequested` / `onCancelResolved`), the one place every turn,
  inference and recap cancel goes through. Outcome: `acknowledged`, `forced`, `too_late`,
  `failed`. `stop()` now cancels with reason `stop`.
- SQLite: kind, detail table `conversation_cancellation_events`, schema 15 rebuild of
  `conversation_records` (one rebuild admits `error` and `cancellation`). JSONL: `t: cancellation`,
  validated, written through the presentation queue so it stays ordered. Audit: capture key.
- `sameConversationRecord` now accounts for `operationId` read back from `metadata`.
- Tests: supervisor outcomes; Agent-owned interrupt (acknowledged), steer (too_late with the
  fixture, which answers in the same instant the tool settles), ignored cancel (forced); JSONL
  transcript; migration from a real version 14 table.
- Pre-existing flakiness under load (`session-manager-restoration` "replacement generations",
  config-persistence `accept_effective`): fails about 1 in 6 on the previous commit too.

## 2026-10-23, review of the branch and its fixes

The branch was reviewed (no edits), each finding was weighed with options, and these were decided
with the user. In the order fixed:

1. **JSONL sequence collision** (`b95d8de`). A cancellation queued while an internal prompt ran,
   then the prompt wrote its reply directly; both read the writer's next sequence before either
   landed, the second write failed, and the transcript refused every later write. The cause is
   older than the branch: any two overlapping writes collided. Options: drain before every direct
   write (whack-a-mole), write the cancellation synchronously (the supervisor's cancel is sync),
   or number records inside a serialized write. Chosen: the transcript runtime and the audit
   runtime run their writes one at a time (`exclusive`), so the number is taken when the write
   runs; an internal prompt also drains queued records before its reply, so the cancellation is
   written before the reply and the settle. Test: a stalled handoff target prompt on JSONL
   (failed before the fix).
2. **`error` result after a cancel** (`c49519b`). Was labelled `too_late`; now `failed`, which
   already meant "ended in an error". Storing the raw stop reason as well was set aside.
3. **Two connection attempts per `setConfig`** (`08f5897`). The no-op check connected, and on
   failure the normal path connected again. Not connecting in the check would defeat it (its case
   is settings re-applied right after start); remembering the error was awkward. Chosen: the
   branch connects once, compares, and otherwise runs; a connection failure is reported through
   `configuration_started` / `configuration_failed`. Test counts load attempts (fixture appends
   a line per failed load).
4. **`stop` vs `endedBy: "interrupt"`** (`9572a1f`). Planned: add `"stop"` to `PromptEndedBy`.
   Found: `stop()` closes the connection, so the turn always rejects and `endedBy` is never seen
   for a stop. The public type was left unchanged (widening it for an unreachable value would
   only break exhaustive switches); the stored reason `stop` is what consumers see. Test.
6. **`toolCallOperations`** (`23784f3`). Planned: a tool announcement takes the current turn.
   Found: at turn end every unfinished tool is flushed as `failed`, which removed it from the map,
   so the map never outlived a turn; neither the reuse risk nor the "late update keeps its
   announcing operation" behaviour existed. The map is removed; a tool still running at turn end
   is recorded failed there, and a later update is recorded under the turn it arrives in. Docs
   corrected. Test with a fixture mode (`late-tool`) that settles the tool in the next turn.
7. **Timeline scope** (same commit). `operationScope` read only `metadata.operationId`, which tool
   records lack, so a tool id reused by a later turn merged into one item. Now the metadata's id,
   then the record's `operationId`. Items whose metadata had it keep their ids; tool call items
   (and others without it) get new ids once. Noted in the changelog.
8. **JSONL audit dropped cancellations** (`1c5ebf6`). Now written (`AuditLogCancellationRecord`),
   as the SQLite agent audit already did.
9. **Reason and outcome lists in three places** (same commit). `CANCEL_REASONS` /
   `CANCEL_OUTCOMES` in `operations/contracts.ts`; the types and JSONL validation derive from
   them. The SQLite CHECK stays literal (migration SQL must not change after it ships); a test
   compares it to the lists.
10. **Presentation `startedAt` map** (`7116510`). Planned: move it into the runtime's per-item
    table and rebuild that table on reopen. Found: an item's id names its operation and the
    runtime refuses a revision from another operation, so an item never continues after a reopen;
    the remaining issue was growth. The start time now lives in the runtime's table next to the
    position, and an operation's entries are dropped when it ends (turns drain queued writes
    before finishing). Test.
5. **Protocol lines of internal prompts** (`98f0d61`). A handoff's summary/seed/target lines
   carried the handoff's id while their records carried `<handoffId>:summary` etc.; recap and
   recovery seeding lines carried none. Checked first: internal prompts run inside a queued item
   (handoff, reconnect during a turn or setting) or while the conversation opens (adoption recap,
   recovery seed), never beside a queued item. So the running id is swapped for the prompt and
   restored after it. Test (failed before the fix).
13. **Missing test** (`b8c3bf1`): a turn that fails after message A ended keeps A `completed`
    (fixture mode `fails`). The other two missing tests came with 1 and 6.

Not changed, kept on the list:
- 11: every database older than schema 15 copies `conversation_records` on upgrade. Accepted;
  dropping the base `kind` CHECK (so a new kind needs no rebuild) to be raised next time a kind
  is added.
- 12: the end-to-end "no record outside an operation" check may be too strict on a real harness
  (errors written while opening). Needs a real-harness run (authorization) before deciding
  between giving those records the opening's id or exempting them.
- 14: steers act only at tool boundaries; a text-only turn is not redirected. Design list.

Full suite: 1058 pass. End-to-end smoke test (`ACP_TEST8_ADAPTER=test`, recovery skipped): all
PASS.

## 2026-10-23, real-harness end-to-end run (review item 12)

- `smoke-tests/end-to-end` against Codex (default model) and OpenCode
  (`opencode-go/deepseek-v4.1-flash`, set for the run only), throwaway data directories, the
  provider-session deletion step answered `skip`.
- Both PASS, exit 0: initial (4 turns, 2 other operations), reopened (6 turns, recall answer "3"),
  checkpoint, metering, audit (Codex 203 entries, OpenCode 304).
- The "no record outside an operation" check held on both: kinds seen were message, metering,
  thinking, tool_call, all attributed. Item 12 is closed; the check stays as strict as it is.
  Not covered: the graceful-recovery opening (skipped), and Claude (not an adapter of this test).

## TODO (2026-10-23): tool output is lost for some harnesses

Seen in a consumer webapp: a Codex shell step shows its input but an empty output box. The stored
Codex tool records (smoke-tests/test11-steerTurn) hold only `rawOutput: { exit_code }` and a
`{ type: "terminal", terminalId }` reference.

A tool's output can reach the client three ways. From reading the installed adapters:

| Channel | Who uses it (for a client like ours) | Library today |
|---|---|---|
| `content` / `rawOutput` on the tool update | OpenCode (confirmed in records), Claude (because we don't declare `_meta.terminal_output`), Pi (no side channel in its code) | stored |
| `_meta.terminal_output_delta` / `terminal_output` chunks (Zed convention) | Codex | dropped: no `_meta` handling in `src` |
| the client's own terminal (`terminal/create`, `terminal/output`) | Kimi, whenever the client advertises `terminal: true` (our default) | output lives in our terminal, never linked to the tool record (unconfirmed by a run) |

To do:
- Assemble the output whatever the channel: collect `_meta` chunks per tool call; on completion
  attach the referenced terminal's output; store it as the tool's output text (size cap).
- Before building: one short run per harness (Codex, Kimi, Claude, Pi), one command each, protocol
  capture with bodies, to see exactly what arrives. Needs authorization (tokens).
- Presets: add Grok Build (`grok agent stdio`, ACP, early beta, SuperGrok Heavy) as unverified,
  like `gemini` / `copilot`.

## 2026-10-23, paging history by agent messages (requirement 2)

**Problem.** `records.listRecent({ limit })` pages by raw records. A tool call is several records
(one per revision), so a page cuts a turn anywhere: it starts without the user message, splits a
run of activity, and "load older" brings the other half.

**Weighed and set aside.**
- An operations table (kind, times, outcome per operation): paging doesn't need it; how a turn
  ended is already in cancellation and metering records; a crash marker can be a smaller field.
  Worth it only if consumers come to query operations themselves.
- Paging by operation (N operations per page): every operation counts the same (a setting change
  takes a slot), the per-page `GROUP BY` grows with the conversation, and interleaved records
  have to be pulled back to their operation.
- Paging by turn (user messages): the right size for nobody here; the consumer wants many agent
  messages per page.
- Paging by timeline items: still cuts turns.

**Decided.**
- The page unit is agent messages (`agentMessages: N`), counted as logical messages (by
  `logicalMessageId`, falling back to the record id), out-of-band appends included. The cut goes
  right after an agent message: a page holds N agent messages and the activity that led to each;
  activity after the newest message (a running turn) stays on the newest page; a page usually
  begins with the turn's user message.
- Records are assigned to the item they belong to, and an item to the page where its first
  revision falls. Revisions are spread through a turn (a message is completed when the next tool
  starts, and again at turn end), so a plain sequence range would leave lone revisions on the
  wrong page. All revisions of an item lie in one operation, so a page reads the rest from the
  operations it touches. A page in this mode is a range of item starts, not of sequences.
- `fold: true` returns timeline items (the reconcile's `ConversationTimelineItem`) instead of
  records. The consumer gets what it renders; live revisions still merge with
  `reconcileConversationTimeline(items, records)`.
- `detail: "summary"` leaves out a tool call's input and output (the bulk of a page: ~100 bytes
  for the step against KBs for one file read). The consumer fetches the full record on expand with
  `records.get(recordId)` (indexed by its unique id). Folded summary items keep two revisions, the
  first and the merged current (under the latest revision's id), not all of them. (Planned as no
  revisions; changed while implementing: the reconcile rebuilds an item from its revisions, so an
  empty list would drop the item at its next merge with live records.) Input stays out for now; the step title is
  the harness's `name`, which varies by harness (Codex: the command; Claude: `Read file '…'`).
- `limit` is the cap in this mode (records, or items when folded; default 2000). A page that
  reaches it ends at an item instead of an agent message and says `truncated: true`; the next page
  continues from there.
- All three options are independent and off by default: without them `listRecent` is unchanged.
  The return type follows `fold` through overloads. The cursor stays a sequence bound to the
  snapshot and the filters, and records which unit it was made for; a cursor of one mode is
  refused by the other. SQLite only (JSONL has no paged reader).

Implemented: `SqliteAgentPersistence.listRecent` (`recentAgentMessagePage`). The page's agent
messages come from one `GROUP BY` over the conversation's assistant message records (first revision
per logical message); the records of the range and of the operations it touches are read, assigned
to items by `conversationTimelineItemId`, and kept when the item began in the range. Tests: a
backend test over a hand-laid turn (spread revisions, an out-of-band append mid-turn, the cap, a
cursor of the other unit), and an agent test over the fixture (two turns, folded summaries, the
step expanded with `records.get`). Full suite: 1060 pass.

- `smoke-tests/end-to-end`: after the reopen, `assertHistoryPages` walks the history two agent
  messages per page: every record on exactly one page, at most two agent messages per page, folded
  summary items never on two pages and tool steps without input or output. One line in the main
  flow, `PASS history pages ...`. Test adapter: 4 pages, 47 records, 41 items. The test adapter
  makes no tool calls, so the summary check on tool steps only bites on a real harness.
- Note (cost): each page counts agent messages with a `GROUP BY` over the conversation's
  assistant message records (first revision per logical message). A few milliseconds even at
  thousands of messages, but it grows with the conversation. If it ever shows up, a small index
  (e.g. on the first revision of each logical message) fixes it.
- Real-harness run (OpenCode, `opencode-go/deepseek-v4.1-flash` for the run only, recovery step
  skipped): all PASS, exit 0. `PASS history pages agentMessages=2 pages=4 records=83 items=58`,
  with tool calls and thinking in the turns, so the summary check on tool steps ran.

## 2026-10-23, messages made of parts (requirements 6, 7, 8, 10): design

**Problem.** A message is a string. Sending: every attachment goes out as ACP `image`, whatever its
mimeType (`client.ts` `runPrompt`), with no check against the agent's `promptCapabilities`, and
what is sent always equals what is stored. Receiving: an agent's non-text `agent_message_chunk`
(image, resource, link) is dropped (`extractResponseChunk` keeps text only); the Claude adapter
does send image chunks (assistant and user, on history replay). Persistence: user messages keep
their text only, out-of-band messages are text only, though `content_json` already accepts blocks.
Loading and search: text only.

How harnesses keep images (checked here): all three inline in their own transcript. Claude Code:
an Anthropic `image` block with base64 (plus a copy on disk whose path the model is given).
Codex: `input_image` with a data URL. OpenCode: a generic `file` part (`mime`, data `url`,
`filename`).

**Decided so far.**
- Our own part type, close to ACP, mapped per controller (helps the non-ACP controller).
- One model for user input, agent output and out-of-band messages.
- Kinds: `text`, `pasted` (a named paste, sent as text), `image`, `audio`, `file` (anything else).
  Separate media kinds because the agent's capabilities (`image`, `audio`, `embeddedContext`) and
  the rendering are per kind. A `link` kind was dropped: image, audio and file can each be a link.
- The axis for media is **copy or pointer**, not "stored or not":
  - a copy: the agent receives the content in the prompt. `keep` says whether the bytes are kept
    (`keep: false` records that it was sent, with name, type and size, and nothing else; fine
    for feeding an agent files that may go with compaction);
  - a pointer: the agent receives a reference to the original and opens it with its own tools;
    edits and deletions affect the original.
  A copy is never sent as a link (a copy the agent did not see would make the record lie).
- `record: false` on a part: sent, not recorded at all (a call-mode wrapper). The library's own
  provider-only text (identity preamble, out-of-band block) can use the same mechanism.
- An agent's `image`/`audio` chunk becomes a copy; a `resource_link` becomes a pointer part of the
  kind its mimeType says (`file` when unknown).
- Pointers, first version ("point 2"): the library does not limit them. It passes the pointer and
  the agent's own permission flow decides; the consumer can declare directories for the
  conversation, passed as ACP `additionalDirectories` (the Claude adapter honors it, the Codex
  adapter parses it, our low-level client already sends it). Documented limit: an agent that
  cannot see the file (another machine, an unshared container) needs a mount, a copy, or later
  tools. Revisit after real use.
- Set aside for now: a library directory of symlinks (`~/.cache/acp-lib/links/<conversation>/`):
  careful sandboxes resolve a symlink's real target, so it helps only a narrow band; media tools
  over MCP (works anywhere, but not "just works" for the agent); ACP client fs methods (text only).
- Not yet run: how each harness's sandbox treats a read/edit outside the workspace, directly and
  through a symlink.

**Decided (second and third pass; this supersedes earlier wording).**

The part, as input:
```ts
type Part =
  | { kind: "text";   text: string;                record?: false }
  | { kind: "pasted"; text: string; name?: string; record?: false }
  | MediaPart;
type MediaPart = {
  kind: "image" | "audio" | "file";
  mimeType?: string; name?: string;
  mode?: "copy" | "link";       // unset: chosen by size
  keep?: boolean;               // copies only
  record?: false;
} & ({ data: Uint8Array } | { path: string });   // path: a file path or a file:// uri
```
- `mode` says what the part is, and with it what the agent receives, what the record can hold and
  which other fields are valid. (`delivery` was set aside: the field does more than deliver.)
  - `copy`: the agent receives the content in the prompt. With `path` the library reads the file.
    `keep` decides whether the bytes are kept.
  - `link`: the agent receives an ACP `resource_link` to the original, an absolute `file://`
    path (a relative path is resolved against the conversation's working directory), plus name,
    mimeType and size, and opens it with its own tools; edits and deletions affect the original.
    Requires `path`: `data` with `link` is refused (nothing to point to). `keep` with `link` is
    refused. The record holds the pointer only (uri, kind, name, mimeType): nothing is fetched or
    kept, so history shows what is there today, changed or broken. Later, size and mtime at
    sending could let a UI say "changed since".
  - `record: false` with `keep` is refused.
- In history a media part carries its `mode` plus, for a copy, the store's `ref` (kept) or
  nothing (not kept: name, type, size and SHA-256 only), and for a link the `uri`. A kept `ref`
  can be sent again as input (`{ ref }` as a source) without uploading it again.
- `mode` unset: by size, with a threshold per kind, configurable on the agent. Defaults: `file`
  100 KB, `image` 3.75 MB, `audio` 5 MB. Why: tokens depend on the kind. Text costs about 4 bytes
  a token, so 1 MB of text is about 250k tokens (a whole context window) and 100 KB about 25k. An
  image costs by its pixels, not its bytes (on Claude about width × height / 750, around 1.6k
  tokens at the most after resizing); the providers' per-image limits are around 5 MB, likely on
  the base64 form, a third larger than the file, hence 3.75 MB. `data` over the threshold has no
  file to link to: it is sent as a copy and may fail.
- Kinds: SVG (`image/svg+xml`) is a `file`: it is XML text, and the providers' image inputs take
  PNG, JPEG, GIF and WebP. Sent as text the model reads the markup; the mimeType stays, so a UI can
  still show it as an image (sanitized: an SVG can carry scripts). Rasterizing it is a later option.
- Where kept copies live: the agent's media store, an object, not a name on the part:
  `media: { store }`, any object implementing `MediaStore` (`put(bytes, info) → ref`, `get`,
  `delete`, `list(owner)`); the default is `SqliteMediaStore`, a blob table in the agent's
  database kept out of the message rows. A consumer wanting several places routes inside its own
  store (`put` receives the kind, size and conversation). The rest of the library only sees refs.
  A failed `put` fails the prompt before sending; `list(owner)` lets a cleanup pass find bytes
  whose delete failed.
- Agent level: a `media` key in the V2 `capture` settings (`none` = not recorded, `metadata` =
  not kept, `content` = kept; default `content`), overridable per conversation by the resolver. It
  decides for the media the agent sends and is the default for the consumer's parts; a part's own
  `record`/`keep` wins. Independent of `message` capture, like tools: an image recorded without
  its text is odd but valid. Allowed with checkpointing on (checkpoints summarize text). The older
  transcript settings (`capture.messages: "none" | "text"`) stay text only.
- Duplicates: none detected; every copy is new and belongs to its conversation. A kept ref sent
  again in the same conversation is reused; in another conversation it is copied. Each copy
  records its SHA-256, so deduplication can come later without a migration.
- Deleting: `deleteMedia(ref)` (and per conversation) removes the bytes only; the record keeps its
  metadata and a dangling ref, shown as removed. Deleting records deletes their media; today that
  is `records.deleteForConversation` only (no single-record delete). Soft-deleting a conversation
  (`deletedAt`) does not touch media: hiding is not a media question.
- Agent output: an `image`/`audio` chunk becomes a copy; a `resource_link` becomes a link of the
  kind its mimeType says (`file` when unknown); an embedded `resource` (a file's content inline,
  text or blob) becomes a `file` copy, shown like `pasted` when it is text. Media chunks replayed by
  `session/load` (the Claude adapter sends user and assistant images) are skipped like replayed
  text, so loading does not duplicate them.
- Unsupported kinds (no `image`/`audio`/`embeddedContext` in `promptCapabilities`): an explicit
  `copy` is refused with an error, nothing silently dropped; a part with `mode` unset and a `path`
  goes as a link instead.
- The Claude adapter ignores embedded blob resources, so a binary `file` copy may not reach it
  whatever its size; the per-harness runs will say.
- No size limits of our own: we are harness agnostic, any number is wrong for most harnesses. Any
  size goes through and a harness error surfaces as it is.
- Handoff and recovery: they send one text (the handoff summary, the recovery seed), not messages,
  so they carry text parts only; media is not mentioned.
- Audit log (JSONL): never bytes; refs or uris plus metadata.
- Degraded (pty) mode refuses non-text parts for now.
- `prompt({ text, attachments })`: text plus copies with `keep: false` (today's behavior).
- Out-of-band messages (8): they can carry media parts, sent with the next turn's block like any
  part, the block saying which message they belong to. The block delivers them once; after that
  they are ordinary history (the recovery seed includes them as text). Appended during a running
  turn: a standalone record (no operation) at its sequence, interleaved where the user saw it,
  delivered at the next turn. Paging already counts it as an agent message.
- Search (10): message search stays over text and pasted text. A separate "files shared" listing
  and search over name, kind, mimeType and size, filterable by conversation; usable later by the
  agent through a tool.

**Implementation order.**
1. The part type, its ACP mapping and the capabilities check (fixes today's "everything goes as
   `image`").
2. The `MediaStore`, `SqliteMediaStore` and persistence of parts; `deleteMedia`.
3. The `media` capture key.
4. Receiving the agent's media chunks.
5. Out-of-band media.
6. The files listing and search.
7. Docs (`CONSUMER_GUIDE`, changelog) and the media step in the end-to-end smoke test.
8. Real-harness runs (need authorization): which media each harness accepts, whether Claude reads
   blobs, how sandboxes treat paths outside the workspace.
