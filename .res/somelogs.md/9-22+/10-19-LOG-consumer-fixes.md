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
