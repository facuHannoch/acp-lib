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
