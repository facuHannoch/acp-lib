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
  lines now carry it as messages already did. A tool call still running when its turn ends is
  recorded `failed` in that turn; an update for it in a later turn is recorded under the later
  turn. Records outside an operation have none. `records.list(id, { operationId })` filters by it.
  SQLite agent schema 15 recovers it on older records from their record ids.
- **Cancellations are recorded.** A new record kind, `cancellation` (SQLite and JSONL), with
  `requested` (reason: `steer`, `interrupt`, `stalled`, `stop`, `abort`) and `resolved`
  (outcome: `acknowledged`, `forced`, `too_late`, `failed`) revisions under the cancelled
  operation's id. After a reload a turn can still be shown as stopped or redirected. Stopping a
  conversation mid-turn records reason `stop`. SQLite schema 15
  rebuilds `conversation_records` to admit the kind. Audit capture key `cancellation`
  (default `metadata`); JSONL audit logs write it too (`t: "cancellation"`).
- **Timeline items are scoped by operation.** `reconcileConversationTimeline` keys tool call,
  permission, thinking and activity items by the record's `operationId`, so two turns that reuse a
  provider id stay two items. Items whose records carried `operationId` in their metadata keep their
  ids; the others (tool calls, for example) get new ids, so a consumer that stored timeline item ids
  sees them change once.
- **Transcript writes are serialized.** A JSONL transcript and its audit log run their writes one at
  a time. Before, a cancellation record written while an internal prompt finished could claim the
  same sequence as the prompt's reply and leave the transcript refusing every later write.
- **History pages by agent messages.** `records.listRecent(id, { agentMessages: N })` returns N
  agent messages per page with the activity that led to each, cut right after an agent message,
  with every record on the page where its item began. `fold: true` returns timeline items,
  `detail: "summary"` leaves out tool calls' input and output (`records.get` returns them), and
  `limit` caps the page (`truncated`). Without these options `listRecent` is unchanged.
