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
- Presets: add Grok Build (`grok agent stdio`, ACP, early beta, SuperGrok Heavy) as unverified (done
  2026-10-26 as `grok`, verified; see that entry),
  like `gemini` / `copilot`.

Related harness-specific gaps, added 2026-10-25 (the same per-harness runs can cover them):
- **Claude ignores binary embedded files.** The media probe (step 8 of message parts) got
  `UNAVAILABLE` for a PDF blob, although the adapter advertises `embeddedContext`; text files work.
  Cause (2026-10-25): `claude-agent-acp` 0.85.0, `promptToClaude` in `dist/acp-agent.js`, handles a
  `resource` only when it has `text` ("Ignore blob resources (unsupported)"); audio is dropped too.
  Documented: send binary files to Claude as links (its Read tool opens PDFs). Possible upstream fix:
  map a PDF blob to an Anthropic `document` block. Recheck on adapter upgrades.
- **Requirement 11: Claude thinking is rarely persisted.** Compare a live Claude turn's wire
  messages with what is stored; the fix is likely small unless Claude just does not send it.
- **Requirement 12: Codex steer handover delayed.** Not investigated. (The "review item 12" run of
  2026-10-23 is a different item: the operation-id check on real harnesses.) To find which await
  between the Hub's reservation and `prompt()` blocked: agents-core's admission, or the library
  reporting a busy Codex session as disconnected. Details: `10-5-steer-delivery-delay-codex.md`.

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
} & ({ data: Uint8Array } | { path: string } | { ref: string });  // path: a file path or file:// uri; ref: a kept copy
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
- Where kept copies live: a store, not a name on the part. By default the persistence backend's
  optional `media` repository (next to `search?`, `identity?` on `PersistenceScope`): the SQLite
  backend keeps the bytes in a blob table of the same database, out of the message rows, written
  in the same transaction as the record, so neither can exist without the other. The consumer
  overrides it on the agent with `media: { store }`, any object implementing `MediaStore`
  (`put(bytes, info) → ref`, `get`, `delete`, `list(owner)`). A consumer wanting several places
  routes inside its own store (`put` receives the kind, size and conversation). The rest of the
  library only sees refs. A separate store cannot share the transaction: a failed `put` fails the
  prompt before sending, and `list(owner)` lets a cleanup pass find bytes left behind. A custom
  backend without `media` and no store: nothing can be kept; an explicit `keep: true` is refused
  and the default drops to metadata.
- Media is recorded on the `Agent` path only (SQLite records). The older `SessionManager` /
  `AgentSession` JSONL transcript can send parts (the ACP mapping is shared) but records the text
  plus one line per part (`[image plot.png]`), with no store.
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

**Code review against the plan (2026-10-24).**
- Name clash: `PromptPart` (`steering/contracts.ts`, public) is one original message of a
  combined prompt, and the user-record step takes `parts`. It is renamed `CombinedMessage`, with
  `PromptPart` kept as a deprecated alias; ours is `MessagePart`.
- `combinePrompts` joins the texts and pools all attachments, losing whose media is whose. Each
  original message keeps its parts, in its record and in the prompt's order.
- `PersistedContentBlock` (public) already has `image` (with inline base64 `data`) and `resource`,
  and `content_json` already stores blocks: no message table change. A `media` block is added
  (`kind`, `mode`, `ref?`, `uri?`, `name`, `mimeType`, `size`, `sha256`); inline `data` is no
  longer written, old blocks are still read. Text-only messages stay a string.
- Assistant messages are text only (`current.text += chunk.text`; `ResponseChunk` and
  `ResponseMessage` have `text` only). A chunk gains an optional part, a message a parts list;
  `text` stays the text-only view.
- Bytes that could leak: the `prompt_request` debug log writes the whole prompt (today, with
  attachments) and protocol capture at `raw` would store it; both replace `data` with its size.
  Search: `searchableJson` (SQLite) indexes every JSON value, base64 and refs included, and
  `contentText` (`backend.ts`) has another rule; they become one helper that skips bytes and refs.
  The audit log gets the record before capture (`record-capture.ts`), so bytes go to the store
  before the record is built and records hold refs only.
- `appendAssistantMessage` refuses blank text: it takes parts too. `AgentClient.prompt` is shared
  by the ACP client and the degraded `PtyClient`; the pty client refuses non-text parts.
  `AcpClient.prompt(..., attachments)` stays, attachments becoming copies.
- The `media` capture level goes in the existing choke point, `captureRuntimeRecord`.

**Structure.** `agent-session.ts` (about 5k lines) only calls; the logic lives in pure functions:

| file | holds |
|---|---|
| `media/parts.ts` | `MessagePart` types, `normalizeParts` (source, `mode` by threshold, refusals) |
| `media/acp.ts` | part ↔ ACP block both ways, the capabilities check |
| `media/content.ts` | part ↔ `PersistedContentBlock`, the one `contentText` |
| `media/store.ts` | `MediaStore`, `resolveParts` (reads paths, calls `put`) |
| `media/redact.ts` | strips `data` from logs and protocol records |
| `persistence/sqlite-media-store.ts` | the blob table (schema v16), `deleteMedia`, `list(owner)` |

Unit tests per file, no I/O (an in-memory store). Integration through the fixture agent: it
reports the prompt blocks it receives, and a new mode sends `image`, `resource_link` and
`resource` chunks.

**Implementation order** (one commit per step, each with its tests, the suite green after each).
0. Preparation, no behavior change: one `contentText`; `CombinedMessage` with the alias;
   `AgentClient.prompt` takes an object.
1. Sending: types, ACP mapping, capabilities check, redaction. Attachments go out as their real
   kind, not always `image`; combined prompts keep each message's media.
2. Storing: the `media` block, the backend `media` repository and its SQLite table, the agent
   `media: { store }` override, user records with parts, `deleteMedia`.
3. The `media` capture key, in the resolver and `captureRuntimeRecord`.
4. Receiving: agent chunks become parts, assistant records get blocks, replayed media skipped.
5. Out-of-band messages with parts.
6. The files listing and search.
7. Docs (`CONSUMER_GUIDE`, changelog) and the media step in the end-to-end smoke test.
8. Real-harness runs (need authorization): which media each harness accepts, whether Claude reads
   blobs, how sandboxes treat paths outside the workspace.

## 2026-10-24, message parts implementation (`message-parts`)

Branch starts at `b930539` (current HEAD, per the corrected request). Existing consumer edits
and untracked files are preserved and excluded from implementation commits.

### Step 0 — preparation

- Consolidated structured message text projection in `media/content.ts`; SQLite and backend
  search now share it. Renamed combined prompt originals to `CombinedMessage`, retaining the
  deprecated `PromptPart` alias. Shared client input is an object; concrete clients retain
  positional compatibility.
- Review: checked call sites and public exports, and checked the implementation diff for
  whitespace errors. No known regression. Structured SQLite search intentionally stops
  indexing image base64, matching the backend projection.
- Tests: typecheck; 35 targeted persistence/content tests; full suite **1061 pass, 0 fail**.
- Testing gaps: sandboxed child-process fixtures disconnect (baseline also failed); the full
  suite ran successfully with sandbox escalation. Real providers have not been exercised.

### Step 1 — sending

- Added public message/media part types, normalization, path resolution, kind-specific automatic
  copy thresholds, ACP mapping and capability checks. SVG goes as a file; compatibility
  attachments are MIME-aware copies with `keep: false`. PTY refuses media.
- Combined messages retain their original media and send it in message order. Provider-only
  identity/out-of-band wrappers surround the ordered parts. Debug prompt data and canonical
  raw protocol media bytes are replaced with byte counts; the wire itself stays intact.
- Review corrected provider-wrapper handling and replaced the old pooled-attachments test with
  ownership/order assertions. This intentionally changes the internal combined attachments
  shape; public positional attachment calls remain supported. No known regression.
- Tests: typecheck; normalization/mapping/redaction unit tests; fixture transport test; steering
  integration tests. Final full suite: **1066 pass, 0 fail**.
- Testing gaps: real provider acceptance, storage and output parts are later steps. Unit tests
  use small files and byte arrays; they verify threshold behavior with configured small limits,
  without allocating provider-sized media. `wire` callbacks remain deliberately unredacted.

### Step 2 — storing

- Added byte-free `media` and named `pasted` content blocks, `MediaStore`, Agent store/threshold
  configuration, reusable refs, and byte deletion by ref or conversation. SQLite schema 16
  keeps blobs outside message rows; user media and records commit in the same transaction.
  Clearing SQLite records deletes their conversation's media; the Agent clear API also cleans
  an overridden store. Soft deletion retains bytes. Legacy JSONL gets descriptive part lines.
- Review caught and fixed version-15 migration admission. Ref reuse is owner-scoped; cross-owner
  use copies bytes. Explicit `keep: true` without a store is refused. Object input now also
  permits parts alone or leading text plus parts. No known regression.
- Tests: typecheck; store policy/ref unit tests; Agent persistence/rollback/deletion integration;
  schema-15 upgrade with retained text history; custom-store failure before dispatch. Full suite:
  **1072 pass, 0 fail**. Existing migration and persistence tests also pass.
- Testing gaps/limits: a separate store cannot roll back with SQLite; `list(owner)` supports
  cleanup of orphaned writes. Directly calling an unrelated backend's record repository cannot
  clean a consumer's external store; use the Agent clear API or clean that store explicitly.
  Media-specific capture and agent output are implemented in subsequent steps.

### Step 3 — media capture

- Added `capture.media` (`none`, `metadata`, `content`, default `content`) to Agent settings and
  the existing per-conversation resolver. Part `keep`/`record` overrides apply before storage;
  `captureRuntimeRecord` independently captures text and media. A non-enumerable internal
  marker carries already-applied part overrides through that choke point and never enters JSON.
- Review: verified media can be stored with `message: none`, without weakening the checkpoint
  text requirements; media `none` does not leave default copies behind. No known regression.
- Tests: typecheck; policy validation/choke-point unit tests; Agent tests for metadata defaults,
  explicit keep, record suppression, text suppression and per-conversation disabling. Full suite:
  **1075 pass, 0 fail**.
- Testing gaps: agent-generated media follows this policy starting in step 4. Checkpoint tests
  cover existing text rules; these changes do not make checkpoints include media.

### Step 4 — receiving

- Agent image/audio/resource-link/embedded-resource chunks now become normalized response
  parts. Text views and boundaries remain compatible. Assistant snapshots/finals store refs
  and metadata, with a commit-aware weak ref cache avoiding duplicate blobs across revisions.
  Partial media survives provider failure. Replay media is skipped on load and adoption.
- Legacy success and failure transcripts retain descriptions without bytes. Embedded resource
  text is also removed from canonical raw protocol capture. Handoff transcript messages stay text.
- Review caught two less obvious paths: adoption's response extractor could import empty media
  messages, and failed legacy turns could serialize their response parts. Both are corrected.
  No known regression.
- Tests: typecheck; response ordering/boundaries; mixed-media fixture streaming, final history,
  failed turns, no duplicate copies, reload replay; legacy transcript byte checks. Full suite:
  **1082 pass, 0 fail**.
- Testing gaps: media bytes are tiny fixture payloads, not decodable pictures/audio. No renderer
  is supplied by this library; embedded text-file rendering requires reading its stored ref.

### Step 5 — out-of-band parts

- `appendAssistantMessage` accepts parts, including media-only messages, and writes a standalone
  record without an operation id. Next-turn blocks preserve part order and identify each media
  message. Existing mid-turn sequence fences, bounded text selection and retry rules remain.
- Added temporary pending-delivery envelopes in the media store: no-keep and record-suppressed
  parts remain available until successful delivery, including across SQLite restart. Envelopes
  reference kept copies rather than duplicating them; deleted copies cannot be recovered from
  a stale in-memory cache. Envelopes are not message/audit payloads and are deleted on completion.
- Added a provider-context delivery cursor so delivery does not depend on capturing user or
  assistant text. It commits with the successful turn. Raw resolved parts also get capability
  validation. Updated the end-to-end operation assertion for standalone appended messages.
- Review: checked failure/retry, restart, deletion, text-disabled capture and bounded delivery.
  Intentional compatibility change: appended messages no longer have their own operation id,
  as required by this design. No known regression beyond that documented API change.
- Tests: typecheck; 21 focused Agent/OOB tests; full suite **1085 pass, 0 fail**.
- Testing gaps/limits: custom stores must preserve `MediaInfo.pendingFor` to restore temporary
  envelopes. Without a store, pending suppressed/unkept parts are process-local. Custom backends
  wanting delivery independent of captured text implement optional `outOfBandDelivery`; SQLite
  supplies it. Cleanup of temporary objects in an external store cannot share SQLite rollback.

### Step 6 — files listing and metadata search

- Added optional backend `files.list` / `files.search`, with conversation, name, kind, MIME type
  and size filters plus pagination. SQLite reads message media metadata, folds logical-message
  revisions, and excludes private pending transport objects. Deleted/unkept copies remain
  discoverable from history; message search continues to exclude media names, refs and bytes.
- Review: verified wildcard escaping, stable ordering, cursor validation and no snapshot
  duplicates. No known regression. The existing message search accepts FTS syntax; its test
  quotes a hyphenated query accordingly, while file-name search treats it as literal text.
- Tests: typecheck; Agent integration across two conversations, five output media parts, filters,
  paging, text-search separation and deleted-byte metadata. Full suite **1086 pass, 0 fail**.
- Testing gaps/limits: metadata search uses SQLite JSON/LIKE rather than a dedicated large-scale
  metadata index. Offset pagination is intended for browsing stable history; concurrent inserts
  can move page boundaries. Custom backends may implement the optional repository.

### Step 7 — documentation and end-to-end smoke

- Documented parts, modes, thresholds, stores, refs/deletion, independent capture, files search,
  normalized response parts, pending delivery and custom-backend limitations in the consumer
  guide and changelog. Updated out-of-band operation/delivery wording to match the design.
- Added a deterministic media phase to the existing lifecycle smoke: send/receive, pasted-text
  search, media metadata search, store reads, out-of-band no-keep delivery, replay, byte deletion
  and clearing. Added directory-root tests and public support-type exports.
- Review found an earlier acceptance gap: conversation-level `additionalDirectories` was not
  wired through creation. Completed its propagation through AgentConversation/controller/client
  creation and load/resume/fork defaults, and verified new/load frames. No known regression.
- Tests: typecheck; 14 focused integration tests; full suite **1087 pass, 0 fail**; existing
  end-to-end smoke with `ACP_TEST8_ADAPTER=test` passed lifecycle, paging, checkpoints, metering,
  media and audit (231 logical/physical entries).
- Testing gaps: deterministic semantic recall is intentionally unavailable; deliberate provider
  session deletion/recovery was skipped in that smoke. Real-media/provider behavior is step 8.

### Step 8 — real-harness runs

- Added a repeatable synthetic-media/path probe and checked in small measurement reports and
  a compatibility README. Ran Claude ACP 0.85.0, Codex ACP 2.1.1 and OpenCode 1.18.34, with
  external paths both under `/tmp` and outside it, directly and through symlinks, with/without
  declared directories. Permission approvals were limited to generated test roots.
- Codex and OpenCode Go accepted image, embedded text, PDF blob and file-link inputs. Claude
  accepted image/text/link inputs but returned `UNAVAILABLE` for the blob despite advertising
  embedded context. This is the already identified adapter limitation, not a library regression;
  it cannot be repaired in this harness-agnostic library without changing the agreed semantics.
  All three advertise no audio, so audio copies were not submitted.
- OpenCode's default account failed with an expired API key. Its already configured OpenCode Go
  provider (`gpt-6-luna`) completed the probes; no account/global settings were changed.
- External reads succeeded. Codex/OpenCode modified every tested target. Claude left one
  undeclared symlink target unchanged on the first external run; a focused repeat modified it
  and preserved the symlink. Both results remain in the reports. Model completion alone is not
  treated as evidence that a file was edited. Read/write permission behavior is in the README.
- Review: inspected semantic marker checks and actual file changes, removed unrelated model
  prose from path reports, and checked probe types separately. Full suite **1087 pass, 0 fail**.
- Testing gaps: no successful real audio path (unadvertised), large/remote media, strict sandbox
  variants or model-generated image/audio output. Results are tied to the installed versions,
  accounts and permission modes; fixture tests cover receiving and persistence. No known new
  library regression was introduced by this probe-only step.

### Final self-review and automated review

- Rechecked the implementation against every decided design area and traced both Agent and
  legacy paths, success/failure serialization, external-store effects and migrations.
- **Regressions found and fixed:** step 2's leading-text convenience could duplicate text on
  legacy structured prompts (the Agent's already-resolved path was unaffected). The internal
  call now supplies its prepared parts without repeating the leading text. Step 5 deleted
  external pending envelopes before the local successful-turn transaction committed; a local
  rollback could then lose no-keep bytes needed by a retry. External cleanup now happens after
  commit, while SQLite cleanup remains transactional. Both have focused regression tests.
- Closed a planned privacy gap: historical structured FTS rows could still contain old inline
  bytes/refs. Schema-16 migration now projects search text and rebuilds the existing message FTS
  index, iterating source rows; legacy content remains readable. JSON projection skips known
  byte/ref keys and legacy resource URIs. Added source/threshold validation and recorded copy
  size from actual bytes rather than an earlier stat. These are intentional search/privacy
  corrections, not loss of stored message data.
- Exported `ClientPrompt`, removed the internal deprecated-type use, and fixed an existing
  implicit-type error found when separately checking the smoke programs (normal typecheck
  includes only `src`).
- Gates: source typecheck; separate end-to-end/probe typecheck; 50 focused tests; full suite
  **1091 pass, 0 fail, 4305 assertions**; branch implementation diff passes `git diff --check`;
  package dry run succeeds (185 files, including the media modules).
- No unresolved implementation regression found. Known external-store/custom-backend and
  real-harness limits remain recorded above. The final manual end-to-end pass follows this
  review; no broad retesting beyond these gates is needed unless it exposes a new problem.

### Final manual end-to-end validation

Run after the final automated review and corrective commit `1b9ba87`.

- Drove a one-off consumer API script against a fresh temporary SQLite Agent with **raw**
  canonical protocol and audit capture. Sent text, named paste, a relative image path, unkept
  audio/file bytes and an external file pointer; inspected outgoing block order, normalized
  responses, saved refs, message/file search and history. Verified the leading text arrived once.
- Changed the pointed-to file after sending and read its current contents through the recorded
  URI. Appended no-keep out-of-band media, closed/reopened the Agent, checked replay did not
  duplicate bytes, then delivered it on exactly the next successful turn. Temporary payloads
  disappeared. Deleted a kept copy and verified metadata remained, then deleted all conversation
  media and cleared history.
- Inspected canonical records and **91 raw audit entries**: neither the unique input image's
  base64 nor private embedded file text nor output image data leaked. Pasted text remained
  captured/searchable. All three manual workflow checkpoints passed.
- Ran the complete existing lifecycle smoke again with `ACP_TEST8_ADAPTER=test`: operation
  grouping, reopen, two-agent-message paging, checkpoints, metering, the media phase and audit
  all passed (**231 logical and physical audit entries**).
- Gaps: the deterministic fixture does not reason about image/audio contents; real image/file
  semantics are covered by step 8. Deliberate deletion of a provider session was skipped in the
  manual lifecycle smoke; recovery remains covered by the full automated suite. Real audio is
  unadvertised by the installed harnesses. The Claude blob limitation remains documented.
- No regression or additional code change was required by the manual pass. Final working-tree
  review found only the original consumer edits/untracked files; implementation work is committed.

## 2026-10-25, review of the message-parts implementation, and fixes

Reviewed the 11 commits above against the design and the code. Suite and typecheck were green;
the findings below were fixed in `7da45ff` (code) and `2008ae4` (docs).

**Bugs fixed.**
- Out-of-band media blocked the conversation: an image appended for an agent without image
  support was attached to the next turn, the capability check refused the whole prompt, delivery
  never advanced, and every later turn failed (confirmed with a scratch test, two turns in a row).
  Now delivery checks each out-of-band part against the agent: a copy it cannot take becomes a
  line `[image plot.png: not supported by this agent]`; a PTY agent gets every media part as a line.
  The user's own explicit copies are still refused. Test: `no-media` fixture mode.
- Embedded copies were sent with `file:///<name>`, a root path that does not exist. They now use
  `attachment:///<name>` (`EMBEDDED_URI_SCHEME`). Not yet re-run on real harnesses: the step 8
  probes used the old uri.
- A link from the agent without a size was recorded as 0 bytes. `size` is optional on resolved
  parts and media blocks. An explicit link to a file that cannot be read is sent without a size
  (the library does not open links); a part with no mode still needs the file. The files search
  coalesces a missing size.

**Design change, decided (design changes 5 and 6 of the review).**
- No pending envelopes in the media store. The agent's version wrote `keep: false` and
  `record: false` out-of-band bytes into the store (SQLite, or the consumer's) until delivery,
  contradicting "not kept" / "not recorded", leaving them forever if never delivered, putting
  library JSON in consumer stores, and listing the whole conversation's media per message per
  turn. Now a message is delivered from its record when the record can restore it (text captured,
  every copy kept, no unrecorded part); otherwise its parts wait in memory (`media/pending.ts`,
  per Agent). After a restart, a copy without bytes is named (`[image: not available]`) and an
  unrecorded part is gone. Missing bytes (deleted copy) are named the same way instead of failing
  the turn. `MediaInfo.pendingFor` and the `pending_for` column are removed (schema 16 is not
  released).
- The `outOfBandDelivery` cursor stays: delivery must not depend on captured text.

**Maintainability.**
- One composer, `composeProviderParts`; `composeProviderPrompt` and `providerParts` (which cut the
  composed string back apart at `<current-message>`) are removed, and so is `providerText`.
- Media capture is applied only in `persistParts`, the only place media blocks are built;
  `captureRuntimeRecord` handles message text only. The hidden Symbol marker is gone.
- Off the public types: `ClientPrompt.resolvedParts` (owned conversations send their resolved
  parts back in input form, `unresolvedParts`) and `Agent.pendingMessageParts`.
- `ResponseAccumulator.currentParts()` replaces a full `snapshot()` per chunk.
- Formatting of the media modules and integration code to the codebase's style; imports moved
  below file headers; named helpers in the lifecycle (`mediaStore`, `withStoredParts`) and the
  session (`legacyTranscriptText`, `legacyTranscriptMessages`, `promptInputText`). Long assertion
  lines in the media tests remain; the test setup and the in-memory store were restructured.
- Kept as is: `partsText` joins text parts with nothing, because text parts are segments of one
  text (separators are their own parts); `contentText` joins blocks with newlines for search.

**Noted, not changed.** The OpenCode probe ran on the configured OpenCode Go model (`gpt-6-luna`)
because the default account's key had expired, not on DeepSeek V4.1 Flash. Measurement JSONs
include absolute paths under the home directory; `smoke-tests/media/.sandbox-probes/` is left on
disk (ignored by git).

**Checks.** Typecheck clean; full suite **1093 pass, 0 fail**; end-to-end smoke on the test
adapter passed every phase, including media (scratch data directory, provider deletion skipped).

## 2026-10-25, migration guide for agents-core

`MIGRATION-0.10-to-0.12.md`: agents-core pins `0.10.2`, so the guide covers `0.11.0`, the operation
lifecycle and the requirements work. Written against agents-core's actual use (read only): its
`listRecent({ limit })` paging, the `chat-attachments` side store joined by operation id,
`projectSqliteChatRecord` (keeps only `text` blocks, so `pasted` text would disappear; unknown kinds
become activities, so `cancellation` records show up), and its `delivery: "steer"` prompts. Breaking
items found while writing it: attachments now go as their real kind (a non-image attachment to an agent
without `embeddedContext` is refused; before, everything went as `image`), and the 120/180 s stall limits
fail silent turns. Version `0.12.0` is a proposal; nothing is merged or published.

## 2026-10-25, a prompt that asks for no reply

Prompt: "the answer to p is 4, just read and understand that, do not respond anything". Throwaway
Agent per run (scratch SQLite and cwd), conversation deleted afterwards (OpenCode's session with
`opencode session delete`, it has no ACP delete).
- Fixture ending the turn with no update: `completed`, empty text, no assistant record, 20 ms.
- Fixture never answering (`firstOutputMs: 3000`): `OperationStalledError` (`no_response`) after
  3 s plus the 30 s cancel grace; records `cancellation` requested/resolved and `error`.
- Claude (default model): `completed` in 5.9 s, replied "Noted.".
- Codex (default model): `completed` in 4.2 s, empty text, no assistant message recorded.
- OpenCode (DeepSeek V4.1 Flash via `OPENCODE_CONFIG_CONTENT`): `completed` in 3.5 s, "Noted.".
Stale means the provider neither sends output nor ends the turn within the limits; a turn that ends
with no reply completes. A turn without an agent message has no assistant record, so with
`listRecent({ agentMessages })` its records go on the page of the next agent message.

## 2026-10-25, release checks

- Package: `files` now ships every changelog and the migration guide; the consumer-fixes changelog is
  marked unreleased (planned 0.12.0); the lifecycle one notes it is on `beta` at 0.11.2.
- Correction: requirement 12 (Codex steer delay) was never investigated. The 2026-10-23 "item 12"
  run was review item 12. Fixed in the TODO and the migration guide.
- Review of `7da45ff` (the fixes to the message-parts implementation): one gap fixed in `304f2dd`.
  With `capture.media: "none"` an out-of-band link was not recorded, yet the message counted as
  restorable from its record, so the link was lost at delivery; the rule now also compares recorded
  media blocks with the message's media parts. Deleting a conversation now forgets its waiting
  parts. Both tests fail without the fix. Suite: 1095 pass.
- Embedded-copy uri rerun on real harnesses: see `smoke-tests/media/README.md`. No harness rejects
  `attachment:///`. Claude still ignores PDFs; OpenCode's DeepSeek model has no PDF input (same with
  the old uri). Sessions deleted (OpenCode with `opencode session delete`).


## 2026-10-26, video

ACP has no video block (content blocks: text, image, audio, resource_link, resource). The library
treats `video/*` as a `file`: a copy is an embedded blob (needs `embeddedContext`), or a link.

Probe: a 3-second 320x240 H.264 clip made with ffmpeg (green background, white text `VIDEO7731`),
6.5 KB. Each case in a fresh throwaway session (deleted after); copy runs had no file on disk, so the
agent could not open it with its tools.

| Harness | Copy (embedded `video/mp4` blob) | Link |
|---|---|---|
| Claude (default model) | not seen: the adapter drops blobs | path only; its Read tool cannot open video; it tried ffmpeg for a frame, but our test's permission handler cancelled the command |
| Codex (default model) | read correctly (12 s, it inspected a frame) | read correctly (with tools) |
| OpenCode, DeepSeek V4.1 Flash | "this model does not support video input" | read correctly (extracted frames with tools) |

`agy` (Antigravity CLI 1.4.7, the Gemini CLI replacement) has no ACP mode, so the library cannot
drive it; in its own print mode it read the clip (green, text read as `VIDEO07731`). The `gemini`
preset points at the deprecated Gemini CLI, which is not installed; to revisit.

So video works as a link with harnesses whose tools can extract frames (and permission to run
them), and as a copy only where the harness turns the blob into something the model can use (Codex).

## 2026-10-26, candidate models through OpenCode Go

No OpenRouter key on this machine (OpenCode has only OpenCode and OpenCode Go credentials), so the
five candidates ran through OpenCode Go, model set per run with `OPENCODE_CONFIG_CONTENT`. One
throwaway session each (deleted after), three turns: read a file with a tool and return its marker,
recall it, name the color of a red PNG copy. Cost is OpenCode's reported session total after the
three turns (dominated by OpenCode's ~13k-token system prompt, mostly cached; not a real workload).

| Model | Tool | Recall | Image | Thinking reported | Session cost | vs Luna |
|---|---|---|---|---|---|---|
| gpt-6-luna | ok, 4.3 s | ok | ok | no | $0.0017 | ×1 |
| deepseek-v4.1-flash | ok, 6.0 s | ok | ok | no | $0.0040 | ×2.3 |
| glm-5.3-flash | ok, 3.8 s | ok | ok | yes | $0.0032 | ×1.9 |
| glm-5.3 | ok, 4.8 s | ok | **no**: "no image attached" (text only) | yes | $0.0296 | ×17 |
| kimi-k2.7-code | ok, 7.0 s | ok | ok | yes | $0.0202 | ×12 |

All report usage with cache counts and a cost through ACP, so metering works for each.

## 2026-10-26, video on the candidate models (OpenCode Go)

Same clip and probe as the video run above; each case in a fresh session (deleted after), copy runs
with no file on disk.

| Model | Copy | Link |
|---|---|---|
| gpt-6-luna | "does not support video input" | "cannot view" (did not try tools) |
| deepseek-v4.1-flash | "cannot read video input" | "cannot view" (the earlier run extracted frames with tools and read it: model behaviour varies) |
| glm-5.3-flash | turn **fails**: `'file part media type video/mp4' functionality not supported` | same failure |
| glm-5.3 | "does not support video input" | "cannot view" |
| kimi-k2.7-code | turn **fails**, same error | same failure |

OpenCode turns a `video/*` resource link into a file attachment too, so for models without video the
link fails the same way as a copy; the error reaches us as a failed prompt. None of the candidates
watches video. What worked anywhere was an agent extracting frames with its own tools (Codex; DeepSeek
once). Practical route: the consumer extracts frames (ffmpeg) and sends them as images, which every
candidate but GLM 5.3 reads.

## 2026-10-26, video: Codex on Luna, OpenCode on Sol, Grok

Same clip and probe; model set for the session only (`setConfig("model")` on Codex,
`OPENCODE_CONFIG_CONTENT` on OpenCode). The earlier Codex run used the configured `gpt-6.1-sol`.
- **Codex, `gpt-6-luna`.** Copy: "CANNOT_VIEW_VIDEO" after trying. Link: read correctly (green,
  `VIDEO7731`) by extracting frames with its tools. codex-acp pastes a non-image blob into the prompt
  as base64 text (`<context ... encoding="base64">`), so a copy only works if the model decodes it
  itself (Sol did, Luna did not), and a real-size video would be millions of tokens.
- **OpenCode, `opencode/gpt-6.1-sol`.** Not run: the OpenCode (Zen) API key has expired ("Create a new
  API key in OpenCode Console"); OpenCode Go has no Sol.
- **Grok** (`grok agent stdio`, Grok 1.0.70, its own `grok-4.7`). Speaks ACP; advertises image and
  embedded context. It saves an embedded copy to a file of its own
  (`/tmp/grok-test-sessions-*/attachments/`), so copy and link both reach its tools. Both turns
  extracted frames with ffprobe/ffmpeg, but its image viewing failed, so it tried pixel OCR in Python;
  both turns ended `cancelled` when a permission request was refused (Grok ends the turn on a denied
  permission). First run: every command refused by the probe (no path match). Second run: a looser
  probe filter allowed ffmpeg-related commands. That filter wrongly approved one command containing
  `sudo apt-get install tesseract-ocr`; it did nothing (sudo needs a password; nothing installed,
  apt log unchanged). Removed Grok's leftovers: `/tmp/video-frames`, `/tmp/marker-frames`,
  `/tmp/grok-test-sessions-*` (only the clip and frames) and the five session folders under
  `~/.grok/sessions/` for the throwaway working directories. Grok has no ACP `session/delete`.
- Lesson for probes: approve by exact command, never by substring.

## 2026-10-26, Grok Build preset

`ADAPTERS.grok`: `["grok", "--no-auto-update", "agent", "stdio"]`, pty `["grok"]`, display name
"Grok Build" (xAI's and the Zed ACP registry's name; not "Grok Builder CLI"). `--no-auto-update` is
xAI's advice for ACP in automated use; checked that 1.0.70 accepts it before `agent stdio`.
- Measured without a model call: protocol 1; `loadSession`, image and embedded context (no audio),
  MCP over http and sse; session list, resume and close, no delete, no fork, no
  `additionalDirectories`. Auth: `cached_token` (~/.grok/auth.json) or Grok sign-in.
- A `session/load` of an unknown id fails with code -32603, `Path not found.`,
  `data.code: "FS_NOT_FOUND"`. Not recognised before, so a lost Grok session would not have fallen
  back to checkpoint recovery. Matched exactly in `isMissingProviderSessionError` (message and
  `FS_NOT_FOUND`), with tests for it and for a different `data.code`. A missing working directory
  fails earlier, at spawn, so it cannot be mistaken for this.
- From the video run: Grok saves an embedded copy to a file of its own, and ends the turn
  (`cancelled`) when a permission request is refused.
- Not added: a metering provider mapping (`xai`). Usage reporting and model ids against models.dev
  are unverified, and a SuperGrok subscription is not billed at API prices.
- README's preset list (line 64) needs `grok`; README has the user's uncommitted edits, left to them.

## 2026-10-26, Grok Build end-to-end

Every real-harness smoke test that can take an adapter, on `ADAPTERS.grok` (grok 1.0.70, its own
`grok-4.7`), throwaway data directories. Grok added to the adapter choices of end-to-end, test8
internal inference, test9, test10 and the media probe; test13's lost-session scenario deletes a Grok
session by removing its folder (Grok has no `session/delete`).

| Test | Result |
|---|---|
| end-to-end | all PASS: turns, reopen with recall, paging (5 pages, 273 records), checkpoint, metering, media, audit (667 entries) |
| test13 lifecycle | s2, s3, s4, s5 PASS. s6 (lost session) PASS with the default 120/180 s limits; with the run's 15 s limits the checkpoint seed was cancelled (it took 14 s on the rerun). s1 not exercised: Grok runs `pwd` without asking permission |
| test4 permissions | builtin, shell, mcp PASS (standard option kinds; approved tools ran). mcp-json FAIL: Grok does not load a project `.mcp.json` in an untrusted folder (its folder-trust rule) |
| test10 events | all PASS |
| test9 identity | PASS: cross-conversation recall, new-conversation awareness |
| test8 internal inference | PASS, metered |
| test11 steering | all behaviour checks PASS (steer, combined steers, interrupt after streaming, interrupt during a tool); the two metering checks FAIL: Grok reports no usage |
| test12 adoption | all PASS, on the end-to-end run's own session |
| media probe | text file and link read; PDF blob not seen; the 16x16 image "too small" (256x256 read); declared directories failed, see below |

Found and fixed: the client sent `additionalDirectories` to agents that do not advertise them
(the default added in step 7 of message parts reaches new, load, resume and fork). ACP gates the
field on `sessionCapabilities.additionalDirectories`; Grok answered `Invalid params` and refused the
session. Now left out when unadvertised, with a warning log; tests for both cases (the media fixture
advertises it; `no-directories` does not). The declared case then passed on Grok. Suite: 1096 pass.

Grok facts: no usage reports (metering `usage_unavailable`); ends a turn when a permission is
refused; asks the client to read its own memory files (`fs/read_text_file` under
`~/.grok/memory-v2`); each process start sends JSON-RPC responses for an unknown `skills-reload`
request, which the ACP SDK logs to stderr; folder trust gates project MCP servers; it keeps
per-workspace memory of conversations.

Cleanup: the permission test approves everything, and Grok used that to read strings from its own
binary; nothing outside the throwaway folders was written (`~/.grok/config.toml` unchanged). Removed
the 52 session entries created under `~/.grok/sessions/` (back to the pre-run snapshot), the workspace
memory Grok created from the test prompts (`memory-v2/workspaces/acp-lib-8a320bb9`, created during
the runs), and the test work folders and attachment copies in `/tmp`.

