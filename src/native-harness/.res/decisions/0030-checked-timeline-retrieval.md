# 0030 — Checked timeline retrieval

Base `7fde4937da21b7df5c6d7902f885e393fa6113a0`. Scope is G1a.

## Registration and projection

Reserve both retrieval names even when disabled. Register local handlers through
the checked native offer path. Check availability, the current inference offer
and strict arguments before opening any approval. Preserve gate precedence and
one paired rejection. A deny, rejection or cancellation never reads storage.
Development chat, scenario assembly and stdio share this registration.

Keep canonical calls and results. Later historical inference drops retrieval
calls and their paired results before budgeting. Keep assistant text and other
calls in mixed entries. Drop an assistant record only if it becomes empty.
Active inference and inspection keep the complete pairs. Recognize retrieval
by the reserved names, looking up result ownership by call ID within its turn.

## Search

Use operator conversation eligibility and attribution. Only committed participant
text and assistant replies with text qualify. A requested channel narrows the
same-session shared scope. The harness supplies trusted caller context.

Tokenize maximal Unicode letter, mark or decimal-digit runs, ignoring runs
with no letter or digit. NFC-normalize each token. Default comparison uses
locale-independent JavaScript lowercase followed by NFC; sensitive comparison
uses NFC without case conversion. Accents remain significant. Punctuation
separates tokens. Fixtures cover composed and decomposed accents, punctuation,
non-Latin words, and TODO versus todo and TODOS.

Use FTS5 with ASCII tokenization and a fixed ASCII encoding of each normalized
lowercase token digest. Build parameterized conjunctions of encoded whole words,
including for phrase queries. That conservative prefilter admits hash collisions
and casing differences, which original-text verification rejects. Memory uses
the same folded prefilter. Select candidates by descending sequence, then verify
scope, case and all query words, or the consecutive phrase. Within the verified
set order by decreasing count of qualifying phrase occurrences for phrase mode
or occurrences of distinct query tokens for keyword mode, then descending
sequence. Excerpt around the first qualifying match, with original spelling.

Defaults and hard limits are 512 query UTF-8 bytes, 16 query tokens, 256
candidate messages, 2 MiB total original text verification, 20 hits, 512
UTF-8 bytes per excerpt, and 32 KiB serialized result. Count or text verification
exhaustion produces partial, including an oversized candidate that cannot be
verified. Verify the same descending candidate prefix on both adapters. Return
whole hits that fit, with partial if packing truncates the selected hits.
SQLite FTS matching and descending selection can process more postings than
the verification cap. Measure common-term cost separately.

## Point read and windows

Use operator IDs: item ID through its item-to-entry point lookup, stored model
ID through an indexed reverse reply-ID lookup, and canonical decimal sequence
through the timeline primary key. Check the resolved entry encodes exactly the
requested ID and meets conversation eligibility. Resolve neighbors through
eligible channel/sequence ranges. Defaults are zero neighbors, up to 10 each.
Every page has a 32 KiB serialized result limit. Split text only at Unicode
scalar boundaries, preserving exact text with byte offsets. Keep the target
identified by ID and sequence on each page.

The first read fixes the revision and the ordered bounded window. A continuation
binds session, target, channel, neighbor counts, revision, next window sequence
and text byte offset. Validate types, session, ID, eligibility, current
visibility, window membership, revision and byte boundary every time. Reject
conflicting arguments. Cursors confer no authority. Appends after the frozen
revision do not appear in the window.

## Storage choice and compatibility

Reuse focused operator eligibility instead of scanning snapshots or introducing
a separate canonical transcript. Keep SQLite format and archives unchanged.
Maintain the FTS and reverse projection transactionally from eligible source
entries. Rebuild a missing or dirty projection on owner open and after import,
preserving old writer compatibility with dirty tracking. Fail closed on dirty
reads, and deduplicate on rebuild. The timeline remains authoritative. Bun's
SQLite successfully ran an in-memory FTS5 ASCII-tokenizer MATCH probe on this
worktree. Run indexed point and range checks on the 10,000-entry fixture before
claiming boundedness.
