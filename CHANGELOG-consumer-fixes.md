# Consumer fixes (from the 2026-10-13 agents-core requirements)

- **Message boundaries.** A new tool call now ends the assistant message before it, also when the
  agent sends no message ids (before, message → tool → message was one message). Tool updates
  do not split. Applies to the live `result.messages` and to stored messages.
- **Message completion is stored when it happens.** Agent-owned conversations record a message
  `completed` when the next message or a tool call begins, with that time, instead of completing
  every message of the turn at its end with one shared timestamp. Only the turn's last message
  takes the turn's outcome; messages that ended before a failure or cancel stay `completed`.
- **Item times.** `ConversationTimelineItem` has `startedAt` (first revision) and `updatedAt`
  (latest). Presentation items have `startedAt` and `updatedAt`; their `timestamp` is now a
  deprecated alias of `updatedAt`.
- **No-op settings are not recorded.** `setConfig` with the value the option already has (and,
  with a transcript, that is already the explicit restoration target) sends, records and emits
  nothing.
- **Every record carries its operation.** Records have a typed `operationId`: the library
  operation that wrote them (turn, internal inference or recap, setting change, mode change,
  handoff, appended out-of-band message). Tool calls, permissions, thinking, activity, configuration, mode changes and protocol
  lines now carry it as messages already did; a tool call keeps the operation that announced it.
  Records outside an operation have none. `records.list(id, { operationId })` filters by it.
  SQLite agent schema 15 recovers it on older records from their record ids.
- **Cancellations are recorded.** A new record kind, `cancellation` (SQLite and JSONL), with
  `requested` (reason: `steer`, `interrupt`, `stalled`, `stop`, `abort`) and `resolved`
  (outcome: `acknowledged`, `forced`, `too_late`, `failed`) revisions under the cancelled
  operation's id. After a reload a turn can still be shown as stopped or redirected. Stopping a
  conversation mid-turn now reports reason `stop` instead of `interrupt`. SQLite schema 15
  rebuilds `conversation_records` to admit the kind. Audit capture key `cancellation`
  (default `metadata`).
