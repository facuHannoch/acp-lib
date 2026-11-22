# 0025 External notices and delivery handoff

## Problem and options

External producers need attributed inbox delivery and durable retries. Using
participant input would blur attribution and policy provenance. Reuse the inbox
with a distinct kind and a host-only method.

## Harness contract

The initialized endpoint that successfully created or opened the session owns
it. Only that endpoint admits channel/notify, including on an inspection open.
Approval and callback capabilities and the supplied source label grant no
authority. An endpoint without an open session returns invalid_state.

The envelope has exactly channel and notice. The notice has required id, text
and policyNames, plus optional source. Reject unknown fields and missing or
wrong types as invalid_params. Strings are nonblank and retain exact spelling.
Normalize the names to a sorted unique set (duplicates and reordering are
equivalent). An omitted source means host attribution and is distinct from
an explicit label. External notices have no source channel or turn.

The external signature is lowercase SHA-256 of the UTF-8 JSON serialization
of ["external_notice", channel, source-or-null, text, sortedDistinctPolicyNames].
Existing signature formulas remain unchanged. After shape and owner checks,
read the existing inbox ID before any admission or active policy check.
An identical external notice returns its recorded receipt and causes no write,
take, or wake. A different payload or kind returns item_conflict. Inspection
and suspended sessions support the same lookup. Keep check and commit fenced
by the inbox transaction so competing accepts cannot create duplicates.

For a new ID, use existing session admission codes. An absent channel is
not_found, a retired one channel_retired, and a suspended or suspending one
channel_suspended. Return invalid_policy for an unknown inherited name on
an eligible channel. Resolve the channel or default policy at acceptance
and store inherited names alongside it. The scheduler takes the notice
with ordinary inbox ordering. Make the external kind and accepted ID visible
in the timeline and render host attribution in context. Conversation pages
exclude it. Internal notice admission remains unchanged.

## Compatibility

Write SQLite format 6 and archive 5, with envelope 1 unchanged. Older readers
must refuse new versions since they cannot safely take this kind. Upgrade
formats 2–5 in the existing migration and recovery transaction, without
changing format 5 signatures. Older formats retain their existing migration
rules. Adapter import accepts archive 1–5 and
session files accept 2–5. Legacy archives cannot contain external notices.
New archives validate attribution, sorted inherited metadata and signature
before publication, and preserve pending and taken notices with their IDs.

## Deferred worker handoff contract

Persist assignment ID, destination and originating policy names before work.
A backend must independently recover or replay terminal completion by that
ID. Atomically stage the result and exact notice with one stable delivery ID,
then acknowledge the backend. A redirect committed before staging supplies the
destination; a previously staged notice keeps its payload. Union names from
taken work on both sides. On reopen, recover unstaged completions and retry
staged delivery after earlier channel changes. Suspension or an unresolved
change keeps it pending, invalid_policy blocks until explicit retry, and
missing or retired destinations fail delivery while retaining the result.
A duplicate receipt confirms delivery. The worker gates stay open pending
the actual backend recovery proof.
