# Consumer fixes (from the 2026-10-13 agents-core requirements)

- **Item times.** `ConversationTimelineItem` has `startedAt` (first revision) and `updatedAt`
  (latest). Presentation items have `startedAt` next to `timestamp`, both live
  (`presentation_recorded`) and from `TranscriptReader.readPresentationPage`. Show `startedAt`:
  a message's latest revision can share one instant with the rest of its turn.
- **`message_completed` event** on conversations: an assistant message will receive no more
  text (`turnId`, `messageId` = the records' `logicalMessageId`, `providerMessageId?`, `status`).
  Emitted when the next message starts and at the turn's end, once per message.
- **No-op settings are not recorded.** `setConfig` with the value the option already has (and,
  with a transcript, that is already the explicit restoration target) sends, records and emits
  nothing.
- **Prompt capabilities are persisted.** Agent provider session records carry
  `promptCapabilities` (`image`, `audio`, `embeddedContext`). SQLite agent schema 15 adds the
  column; version 14 databases migrate in place.
