# acp-client: problems and requirements from agents-core / webapp

2026-10-13. Against acp-client **0.10.2** (agents-core pins it exactly; the
webapp still depends on 0.9.4 for the activity fold). Written from the
consumer's side: each item states the problem as observed, the evidence, and
potential solutions. The fix is up to the library.

Related: `10-13-SPEC-message-media.md`, `10-13-SPEC-call-mode.md`,
`10-5-steer-delivery-delay-codex.md`, `10-13-TODO-chat-transcript-steering.md`.

---

## 1. Records written during an operation carry no operation id

**Problem.** Only message (and metering) records carry `operation_id`. Tool
calls, permission events, thinking, activity and configuration records are
written with `operation_id = NULL`. A consumer cannot tell which turn a tool call
belongs to.

**Evidence.** In every agent DB inspected, most non-message records have a NULL
operation id (e.g. 4,801 of 5,979 in a Codex agent). Configuration records
generate an operation id (`<op>:configuration:started`) but only use it in the
record id. `agent-session.ts` builds tool records (~l.4380) without it although
the running turn is known.

**Impact.** Live, every tool call becomes its own "1 activity step" group; turns
are reconstructed only by position on reload; metering and paging by operation
are impossible.

**Potential solutions.**
- Stamp the active operation id on every record written while an operation runs
  (column and/or metadata), including configuration and permission records.
- Expose it on `ConversationRecord` (`operationId`) so consumers do not parse
  metadata.

## 2. History pages cut turns in half

**Problem.** `records.listRecent(limit)` pages by raw records. A tool call is
~3–5 records (announced/input/completed + permissions), so 50 records ≈ 10 tool
calls; pages routinely start mid-turn, without the user message that started it.

**Impact.** After reload a turn seems to lose activity, or appears without its
start; "load older" splits turns again.

**Potential solutions.**
- A page query by operation: "the last N operations of a conversation", cursor at
  an operation boundary (depends on 1; the `operation_id` index exists).
- Or a page query by logical timeline items rather than raw records.
- The consumer wants to offer a "turns per page" preference, so the unit should
  be operations/turns.

## 3. How a turn ended is not persisted

**Problem.** `endedBy` ("steer" | "interrupt") and `followedBy` exist only on the
live prompt result.

**Impact.** After reload a turn cut short by steering or Stop looks like it simply
ended; clients cannot show "Redirected" / "Stopped".

**Potential solutions.** Persist them with the turn (metering record, the turn's
last assistant message metadata, or a dedicated turn record) and return them in
history.

## 4. Re-applied settings are recorded as changes

**Problem.** Setting a configuration option to its current value still writes
`configuration` records. The Hub re-applies model/effort on every session start.

**Evidence.** One conversation holds model+effort `set` three times (sequences
7–18) with the same values.

**Impact.** Showing setting changes in the transcript would show repeats.

**Potential solutions.** Do not record a `set` that does not change the effective
value; or mark it (`unchanged: true`) so consumers can skip it.

## 5. A message's time is its last revision's time

**Problem.** A timeline item exposes `current` (last revision). Its timestamp is
when the last revision was written. Codex re-saves every message of a turn as
`completed` at turn end, in one instant.

**Evidence.** Eight messages of one Codex turn stamped `23:35:58.433`.

**Impact.** After reload every message of a turn shows the same time.

**Potential solutions.** Add `startedAt` (first revision) and `updatedAt` to
timeline items. (Consumers can read `revisions[0].timestamp`, but every consumer
would need to know that.)

## 6. Prompt attachments are not persisted

**Problem.** `prompt({ text, attachments })` sends the attachments to the
provider but saves only `content_text`. `Attachment` is `{ data, mimeType }`, no
identity. Nothing in the transcript says an image was sent.

**Impact.** Images never appear in the transcript (live or after reload). The
consumer has no way to tie stored media to the message.

**Potential solutions.**
- Accept identity and metadata per attachment (`id`, `name`, `size`, `kept`),
  and save the user message with parts (text + media references, no bytes) in
  the existing `content_json`.
- Return those parts in history / timeline items.
- Keep byte storage out of the library (consumer-owned); the library stores
  references only. Optionally a pluggable media store later.

## 7. Prompt text and stored content are the same string

**Problem.** The consumer needs to send the provider more than it stores: large
pasted text (stored as a `text_attachment` part, sent inline), and a call-mode
wrapper (sent, never stored). With `prompt({ text })` the stored text is exactly
the provider text, so the consumer must either store duplicates or lose content.

**Potential solutions.**
- `prompt({ parts })`: the library derives both the provider input (text parts
  and pasted text concatenated, content blocks for media) and the stored message
  (parts) from one input.
- A provider-only prefix/suffix option on `prompt()` (the library already does
  this internally for the identity preamble and the out-of-band block).

## 8. Out-of-band assistant messages are always replayed, text only

**Problem.** `appendAssistantMessage({ text })` records an assistant message the
provider did not produce, and composes it into the provider's next prompt ("messages
you sent through another channel"). There is no way to (a) attach media, or (b)
record a message the agent itself sent during its turn without replaying it.

**Use case.** The agent's `share` tool (Hub MCP) should become an assistant
message with an image/file in the transcript. Replaying it tells the agent what
it already did.

**Potential solutions.** `appendAssistantMessage({ parts, replay?: boolean })`;
when appended during a turn, give it that turn's operation id and its sequence
place (with 1).

## 9. Agent capabilities are not persisted (to check)

**Problem.** `session.capabilities.promptCapabilities` (`image`, `audio`,
`embeddedContext`) is available on a live session. Unclear whether it is stored
with session metadata; the consumer needs it to refuse unsupported media and to
show "Accepted media" without a live session.

**Potential solutions.** Persist the agent's announced capabilities with the
provider session record and expose them on the conversation/session read API.

## 10. Search ignores non-text content

**Problem.** Message search indexes `search_text` from text only.

**Potential solutions.** Index part names and pasted text when parts exist (6).

## 11. Thinking is rarely persisted for Claude agents (investigate)

**Problem.** Claude-harness agent DBs hold almost no thinking records (0 in all
inspected but one, which has 1); Codex DBs hold many. Thinking seen live
disappears on reload.

**To determine.** Whether the Claude harness does not send thought chunks over
ACP at the efforts used, or the library receives and does not persist them.
Compare a live Claude turn's frames with what is saved.

## 12. Steer handover delayed minutes on Codex (investigate; maybe core)

**Problem.** Two steer messages to a Codex agent were reserved by the Hub at once
but handed to `prompt()` ~5 minutes later; the library then delivered them
correctly. Claude agents did not show this.

**To determine.** Which await between reservation and `prompt()` blocked: core's
session activation / runtime admission, or the library reporting a busy Codex
session as disconnected / not current (forcing a retire-and-reopen that waits for
the turn). Details: `10-5-steer-delivery-delay-codex.md`.

## 13. Live message completion is not signalled

**Problem.** Consumers get chunks and, at the end, the whole reply; a message's
own completion (`status: completed` in the record) is only visible by reading
persisted records. Clients keep a caret on the last message until turn end.

**Potential solutions.** Expose message status on presentation items (consumer
side can do this from records), or emit a `message_completed` event live.

---

## Summary

| # | Area | Kind |
|---|---|---|
| 1 | operation id on all records | fix |
| 2 | page by operations | feature (needs 1) |
| 3 | persist turn end | feature |
| 4 | no-op setting records | fix |
| 5 | item start time | small feature |
| 6 | attachments persisted as parts | feature |
| 7 | parts input / provider-only text | feature |
| 8 | out-of-band with parts, no replay | feature |
| 9 | persist agent capabilities | check / feature |
| 10 | search over parts | small feature |
| 11 | Claude thinking | investigate |
| 12 | Codex handover delay | investigate (maybe core) |
| 13 | live message completion | small feature |

Consumer-side follow-ups after a release: bump agents-core; read record
operation ids; page by turns; show turn end and setting changes; media parts;
`share` as messages; call-mode wrapper.
