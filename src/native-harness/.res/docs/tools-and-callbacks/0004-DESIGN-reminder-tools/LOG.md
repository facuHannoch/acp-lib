# Reminder tools implementation log

## R-H1

The canonical wire and commit decision is 0031 at
`34969fd99e865794495813837880142fc2b22e1e`, approved by Clad on the
`723d438` design handoff. R8 consumes that wire contract. The subsequent
coordination notes in 0031 pin expiry provenance, frozen intent receipts,
blocked-create correction, and the session identity fence.

## R-H2

The harness owns a single timer per live session. SQLite activates reminder
tables and format 7 only with the first committed reminder row or receipt.
An untouched format-6 session still exports archive 5. Format-7 sessions
export archive 6. The wake range uses a partial index over runnable deadlines.
Channel lifecycle commits update that projection in the same transaction.
Held reminders do not contribute a wake, and an expired held occurrence is
resolved without a notice when eligibility returns.

The real-stdio tests use the scripted model and an injected wall instant.
They exercise a cold open with a delayed intent and an unchanged replay
receipt, process death on both sides of the atomic occurrence commit,
checked agent scheduling, approval, and the idle-stop fence. Storage tests
cover format activation, grace provenance after archive import, cursor
invalidation and a 100-row due batch with a remaining deadline.

Receipts are retained for the session lifetime and exported. Storage grows
with durable host changes, including blocked changes. An identical replay
adds no receipt. Listing cursors intentionally invalidate on any row change
and return invalid_cursor so callers can start a fresh listing. Resuming a
channel can recheck its policy-blocked rows.

The root conversation controller ignores reminder events without a turn ID.
The acp-client supervisor, R8 consumer integration, and recurrence have
separate gates.
