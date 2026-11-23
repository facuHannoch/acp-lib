# Timeline retrieval

Date: 2026-11-22

Status: Proposed for M2. Shared visibility applies across native channels in v1.

## Purpose

Let the agent retrieve older conversation messages on demand as the context
builder starts limiting what goes into each inference. The timeline remains the
source of the original messages. How much recent history to include automatically
is a bounded-context design decision.

## Search the timeline

`search_timeline({ query, channel?, match?, case_sensitive? })` returns a bounded
list of hits. Each hit carries a stable `message_id`, the original channel,
sender, timestamp, and a short excerpt around the matching text. Sort by
relevance, then by descending timeline sequence for ties. Include `partial`
when a work limit prevents the search from establishing its result. The hits
then describe the best qualifying matches checked so far. An empty partial
result leaves open whether more candidates would match.

- `query` is a non-empty string with at least one searchable word. Default
  `match` is `keywords`. Every query word must occur as a whole token in the
  same message, in any order. With `match: "phrase"`, the words must appear
  consecutively and in order. Phrase matching is based on tokens.
- Matching is case-insensitive by default. With `case_sensitive: true`, check
  the original text for the requested token casing. `TODO` then matches `TODO`
  and skips `todo` and `TODOS`. Check casing and visibility before applying the
  result limit. Generate excerpts around qualifying matches.
- Omitting `channel` searches the shared scope. Supplying it narrows the search
  to that channel. Use the existing conversation-message eligibility rule for
  search, direct reads, and neighbor windows. Eligible entries are committed
  participant messages and assistant replies with text. Internal and external
  notices, raw tool results, and empty tool-only replies are outside v1 retrieval.

Translate the tool query into a parameterized search expression with application
defined keyword and phrase semantics. Keep raw FTS query syntax internal.

## Read a message

`read_message({ message_id, before?, after?, cursor? })` resolves the reference
within the current session. Return the original attributed message in full
when it fits and offer a continuation for larger text. Share the existing
operator message ID encoder. Participant entries with item IDs use `item:<id>`,
model replies use their stored ID, and other eligible entries use the sequence
fallback. Resolve each supported form with a point lookup. The ID stays stable
across reopen and session-file export and import.

`before` and `after` are optional counts of neighboring conversation messages
in the same channel. Both default to zero. Return the window in timeline order
with the target identified. Enforce both a message count and an output byte
limit. Freeze the window at the first read's timeline revision. The cursor
binds the target and window to that revision and carries the next position and
any offset within a split message. Check current visibility on every page.

For example, the agent searches for `launch Friday`, opens a matching message
with `before: 2, after: 3`, and reads the exchange to see whether the date was
agreed or only proposed. The retrieved text enters the active turn as a normal
paired tool result. Preserve the retrieval exchange in the stored tool trace.
Render it only in the active turn, keeping the call and result paired. Omit
the retrieval exchange from later shared context. The agent can retrieve the
source messages again when needed.

## Storage and execution

Expose retrieval through the storage read interface and compose the tools through
the existing tool registry and permission gate. Implement SQLite search with an
FTS5 index keyed by timeline sequence. Index committed text in the same transaction
as the source entry. The index is a derived projection that can be rebuilt on
upgrade or import from the timeline. Use the index to narrow candidates and check
the original text when case sensitivity is requested. Start with one index and
cap candidate verification. The cap bounds original-text checks. SQLite may
still do substantial matching and ranking work, so measure that separately on
common terms. Revisit a case-aware index if measurements justify it.
[SQLite FTS5](https://sqlite.org/fts5.html)

Use a point lookup and the existing channel-and-sequence range reads for the
message and its neighbors. Keep FTS syntax and index details inside the SQLite
adapter. The in-memory adapter uses the same token and phrase rules, scope, and
bound semantics. Define candidate, result, input, and window limits with the
implementation plan and record adjustable defaults in [Business rules](../../BUSINESS_RULES.md).

## Visibility now and in v1

Reuse timeline `channelId` and `from` for origin channel and sender attribution.
Keep any existing source attribution intact. M2 preserves shared visibility
across channels within the session. The harness supplies the actual calling
channel and any trusted participant identity available to the turn. The model's
channel argument only narrows the search.

Keep origin metadata and caller context available to search, direct reads, and
[live context construction](../../bounded-context/0001-DESIGN/SPEC.md). V1
offers no cross-channel privacy guarantee. Future visibility policy can build
on that boundary and account for derived material, including summaries and
earlier retrieval results.

## Acceptance

1. Exercise keyword and phrase matching, punctuation, Unicode, `todo` versus
   `TODO`, channel filters, result ranking and limits, and an empty result on
   both adapters. Verify the partial flag when common lowercase hits consume
   the candidate budget before later exact-case hits are checked.
2. Open a hit by ID and read a bounded window without selecting messages from
   other channels. Verify large messages can be read through continuations,
   and appending messages between pages leaves the original window stable.
3. Recover an older decision and a later correction from another channel when
   both are outside the live context. Verify that the results retain attribution.
4. Verify indexed SQLite search and bounded message reads on a long timeline.
   Check transactional index updates and rebuild from imported timeline data.
5. Retrieve a message from another native channel. Verify the result keeps
   the original attribution and the saved retrieval exchange is omitted from
   later shared context.
