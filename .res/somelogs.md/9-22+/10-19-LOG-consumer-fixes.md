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
