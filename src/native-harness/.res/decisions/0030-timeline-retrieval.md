# 0030 — Timeline retrieval contract

## Problem

Bounded inference needs a way to recover attributed conversation messages without
loading a session snapshot. Both storage adapters and both native entry points
must agree on results, admission, and the lifetime of retrieval exchanges.

## Options

SQLite's native tokenizer and relevance ranking are convenient but differ from
JavaScript on Unicode and produce adapter-specific ordering. Full timeline scans
would avoid index synchronization but make SQLite retrieval history-sized. A
shared application tokenizer with a conservative derived index gives a common
contract and bounded verification; ranking work in the index is still potentially
history-sized.

## Choice

### Admission and scope

Reserve `search_timeline` and `read_message` even when disabled. Register local
handlers with definitions, strict argument validation and availability through
one checked native dispatch path. Check current offer, availability, and arguments
before policy/approval or execution. An invalid, unavailable, or unoffered call
produces one paired rejection without approval or execution; denial and abort
never start a handler. Existing host callbacks, result reader, debug and notice
behavior retain their contracts. Caller identity and channel come from the turn,
never model arguments; the optional channel only narrows shared session scope.

Eligible text is exactly the operator conversation projection: committed
participant messages and assistant replies with nonempty text, with the operator's
participant attribution prefix removed. Exclude notices, tool results and
textless assistant calls. Share the projection and its ID encoder, preserving
channel, sender and available timestamp; do not fabricate a timestamp where the
source lacks one. Direct reads and neighbors apply the same eligibility and
visibility checks as search.

### Search semantics and bounds

A word is a maximal run of Unicode Letter, Mark or Number code points. Normalize
text to NFC before tokenizing. Normalize each token to NFC again after Unicode
`toLowerCase()` for case-insensitive comparison; case-sensitive comparison uses
the NFC token without case conversion. Diacritics are significant, punctuation
and whitespace separate words, and matches are whole tokens. Keywords require
all query tokens; phrase requires consecutive tokens in order. Duplicates are
significant for phrase and redundant for keyword matching. These rules are not
locale-sensitive and do not promise full Unicode case folding. Validate fixtures
for composed/decomposed accents, non-Latin letters, case, punctuation and empty
or punctuation-only queries.

Arguments: query at most 1024 UTF-8 bytes and 32 tokens, each normalized token
at most 256 UTF-8 bytes; `match` is `keywords` (default) or `phrase`, and
`case_sensitive` defaults false. Reject unknown fields and wrong types. Limit
channel and ID strings to the existing input limits. Return at most 20 hits,
each with an excerpt of at most 512 UTF-8 bytes around the first qualifying match,
cut only on Unicode scalar boundaries. The complete JSON result is limited to
32 KiB; stop before exceeding it and set `partial` if a hit is omitted.

Generate candidate entries containing all distinct lowercased query tokens, in
descending sequence order. Verify no more than 1000 candidates, including those
that fail exact-case or phrase verification; probe one extra to establish whether
work remains. Rank verified matches by the number of occurrences of the first
query token (descending), capped at 255, then sequence descending. This score and
ordering are identical across adapters. `partial` is true when candidates remain
unverified or response bytes omit a qualifying hit; otherwise false. Thus a
partial result is the best of the verified candidates, not a global top-k.
Result count alone does not imply partial: continue verification up to the cap
so ranking is meaningful. A common token can still require substantial index
matching/sorting before candidate verification; measure this separately.

SQLite FTS5 indexes each normalized lowercase token as `x` followed by the
hexadecimal UTF-8 bytes, separated by spaces, using the ASCII tokenizer. Query
with internally constructed, parameterized AND terms; never expose FTS syntax.
This reversible encoding prevents FTS Unicode tokenization or diacritic folding
from dropping a candidate. Verify phrase and casing against original projected
text. Memory uses the identical candidate predicate, ordering, cap and scoring.

### Point reads and windows

Resolve `item:<id>`, stored model message IDs and canonical decimal sequence
fallback by indexed point lookup, then confirm the encoded ID, session, eligibility
and visibility. Unknown, malformed, inaccessible and ineligible IDs are not found.
Do not scan entries or take a snapshot to resolve IDs. On first read freeze the
committed timeline revision, resolve the target, and select up to `before` and
`after` eligible messages in the same channel at or below that revision, each
count 0–20. Return them in ascending sequence with the target identified.

A versioned opaque cursor binds the session, target ID and sequence, channel,
revision, requested counts, fixed selected window endpoints and next sequence and
UTF-8 byte offset. Validate all fields and the requested target/window on each
page, recheck visibility and target identity, and reject malformed or mismatched
cursors. Appends cannot change the frozen window. Pages contain at most 20 message
fragments and 32 KiB of JSON; split long text only on scalar boundaries, advancing
the offset without dropping or repeating bytes. An individually unrepresentable
identity returns a bounded transfer error rather than a non-advancing cursor.
A continuation is the explicit indication of an incomplete read.

### Index lifecycle and projection

The timeline remains canonical. Add a versioned derived SQLite index and point
lookup indexes under the exclusive owner transaction; backfill existing files,
update index rows in the same transaction as timeline writes, and rebuild on
archive import. Mark dirty via triggers for writes from older compatible writers;
on open, atomically rebuild a missing, dirty or incompatible projection before
reads, leaving canonical data intact on failure. Archive only canonical records;
IDs and index contents are reconstructed. Keep existing format compatibility and
ensure interrupted rebuilds retry. FTS5 availability was checked on Bun 1.3.14;
the supported minimum Bun environment must also be exercised in CI before release.

Keep retrieval calls and results paired in the active turn and canonical trace.
Before historical candidate and byte budgeting, remove completed retrieval calls
and their matching results together. For mixed assistant entries retain text,
provider state where valid, and unrelated calls/results; do not drop whole
messages merely because one call is retrieval. Do not create dangling calls or
results, including after cancellation. Operator inspection retains original
records. Current visibility is checked for every retrieval page.

## Compatibility and verification

No existing operator IDs or archive data change. Tool names become reserved;
explicit enablement and policy determine offers. No cross-channel privacy is
introduced. Conformance covers both adapters with matching, ranking, caps and
Unicode; point reads, frozen window paging, reopen, migration and archive;
checked dispatch, cancellation and mixed historical exchanges; and a 10,000-entry
SQLite fixture asserting no snapshot or intervening-message scan for ID lookup.
A real-stdio scripted phase must prove search, read and attributed reply through
the production tool path. The contract is subject to independent approval before
runtime implementation.
