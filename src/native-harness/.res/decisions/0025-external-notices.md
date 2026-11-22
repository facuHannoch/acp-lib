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

Apply checks in this order: request shape, owning endpoint, read-only
duplicate or conflict lookup, session admission, channel admission,
policy validation, then commit. Duplicate lookup precedes the inspection
write fence. Identical accepted notices return their receipt in every
lifecycle that still permits inspection. A new ID in an incompatible
inspection open returns incompatible. A new external notice while the
session is suspending or suspended returns not_running. Internal notices
retain their existing exception during session suspension drain.
An absent channel returns not_found, a retired channel channel_retired,
and a suspended or suspending channel channel_suspended.

For an eligible destination, unknown or reserved internal inherited names,
including __legacy_allow, return invalid_policy. Resolve the channel or
default policy and store it with the inherited names. The scheduler takes
the notice in ordinary inbox order. Expose the external kind and accepted
ID in the timeline and render host attribution in context. Conversation
pages exclude external notices.

## Compatibility

Write SQLite format 6 and archive 5, with envelope 1 unchanged. Older readers
must refuse new versions since they cannot safely take this kind. Add
nullable external_source columns to items and timeline entries. Persist
the normalized submitted policy set using the item's existing inherited
policy metadata. Both tables' kind domain includes external_notice.
Upgrade formats 2–5 in the existing migration and recovery transaction.
Add the columns and update kind constraints where present, preserving
format 5 signatures byte for byte. Older formats retain their existing
migration rules. Adapter import accepts archives 1–5 and session files
accept archives 2–5. Legacy archives cannot contain external notices.
New archives validate attribution, sorted inherited metadata and signature
before publication, and preserve pending and taken notices with their IDs.

## Durable ACP worker handoff

The orchestrator owns assignment identity, destination and worker rules.
Use the Agent database for the assignment binding and delivery records.
Keep a unique indexed binding from assignment ID to the worker conversation
and submitted message ID. The submitted message ID is stable before ACP
dispatch. The worker operation ID is attached at finalization and may be
shared by several messages folded into one turn. Store the destination and originating policy-name set
with it. Commit the binding before sending the ACP prompt. An identical
reservation can recover that binding. A conflicting reservation writes
nothing. Redispatch is never a recovery action for an existing binding.

Recover by assignment ID through the production index and read the
authoritative final worker conversation record by worker and operation.
In the same transaction that commits completed worker records, match
bindings by worker conversation and every message ID in the turn causes,
then attach the final operation and record pointers to each matching binding.
Message IDs are unique within a worker conversation. A second assignment
claiming the same worker/message pair conflicts. Operation IDs may be
shared. At terminal commit, compute the union of the originating and
contributing policy names of all bindings named by the causal message
IDs. Store the union as contributing policy on every affected binding,
preserving its original provenance. Each assignment gets its own outcome
and notice. A successful folded turn supplies the full shared result to
each binding, with its own destination and the shared policy restrictions.

A terminal failure or interruption observed by the current owner stages a
`failed` or `interrupted` outcome, respectively, with the terminal reason
and one stable notice per affected assignment. Explicit cancellation is
interrupted. The notice identifies the assignment and worker, reports the
known kind and reason, and warns that partial external effects may have
occurred. The outcome keeps the evidence flag for whether tools were
dispatched or dispatch history cannot rule them out.

Persist only bounded, non-secret reasons. Map typed terminal signals to
fixed public reason strings of at most 128 UTF-8 bytes. Use a generic
reason when no safe detail is available. Never copy arbitrary provider
error or stop text into the stored reason or notice. For example, a
recognized stall can report "worker stalled", while an unclassified
failure reports "worker failed". A cancellation without a recognized
reason reports "worker interrupted", including on native. A successful
completion is represented by the existing `result` kind. This outcome
and notice commit in the transaction that persists terminal lifecycle
records. Reserve uncertainty for abandoned work without reliable
terminal evidence. Use causal message
IDs to find the bindings and compute the same shared policy union. Failure
attaches no final record pointer. If that transaction never commits, the
replacement owner resolves each abandoned binding independently.
A streamed chunk or draft cannot serve as a result. A backend may expose
a recovery hook for an operation without a reliable final record. The
first ACP implementation has no such hook and uses the uncertainty path.

Use the exclusive Agent SQLite owner lock for the lifetime of the writer.
A second writer fails to open while that lock is held and cannot recover
or stage delivery. After acquiring ownership on open, classify unfinished
bindings read from the prior owner as abandoned before accepting new
dispatches. Only those bindings are eligible for uncertainty resolution.
There is no lease timeout, and current-owner operations are ineligible.

Final-record commits and uncertainty staging must serialize through the
same Agent database. The uncertainty transaction rechecks for a reliable
final record under its write transaction, through the binding’s causal
worker/message ID even when no operation ID is attached yet. An earlier final record selects
the exact result. If uncertainty commits first, a later final record may
remain inspectable in the worker transcript but cannot change the staged
outcome or notice. Enforce uniqueness of the terminal outcome by assignment
ID and verify both transaction orders.

In one Agent database transaction record the resolved result or uncertainty
and the exact pending notice. Enforce at most one terminal outcome and notice
intent per assignment. Repeated resolution returns the committed outcome.
Rollback leaves neither record. Allocate one stable delivery ID at staging
and retain it with the payload across reconnect and explicit retry.
A redirect committed before staging supplies the destination. A redirect
committed afterward leaves the staged payload intact. Keep the original
policy names in the binding. As work is taken across a redirect, update the
binding with the union of the policy names contributing on both sides.
A redirect alone adds no contributor. Staging freezes the union, including
the original names, and identifies the worker as source. The durable result remains
inspectable after any delivery outcome.

Result, failure, interruption and uncertainty notices start in `pending`. Flush them through
the owning host after earlier channel changes. Suspension, an unresolved
change, or a lost acknowledgement leaves the notice pending. Open, resume
and change confirmation schedule eligible pending retries with the original
ID and exact payload. A receipt or duplicate receipt moves pending to
`delivered`. Invalid policy moves it to `blocked_policy`, which returns to
pending only on explicit retry. A missing or retired destination moves it
to `failed_destination`. Delivered and failed_destination are terminal.
A connection loss cannot reopen either terminal state.

The fixture-local transcript scan from the feasibility proof is unsuitable
for production lookup. A second option, provider replay, depends on
provider-specific guarantees and is not required when the final Agent record
is available. The harness wire and archive formats are unchanged. Agent
schema numbering and implementation ownership are coordinated with the
R1–R3 and orchestrator workstreams before runtime changes.

Repository conformance verifies unique assignment and worker/message
keys. The process-death tests observe the exact beforeDispatch message
binding on disk at ACP prompt receipt. Verify that folded messages with
different assignment IDs each resolve to the shared completed operation
through their own binding, with separate results and provenance. Verify
that both assignments receive separate uncertainty notices if the final
record never commits.

Exercise both sides of final-record commit in real SIGKILL/replacement tests
using the production index. Observe the binding on disk at ACP prompt
receipt, prove that the post-final crash left no staged result or notice,
and recover the exact result and original provenance twice. For the
pre-final crash, confirm one uncertainty notice, stable retry ID, and no
redispatch. Exercise rollback, both redirect commit orders, a crash after
redirect, recovery after staging, and acknowledgement loss. Deterministic
ACP peers cover the saved-record boundary offline. Live-provider
finalization and recovery semantics remain unverified.

Before runtime implementation, add typed Agent persistence records and
repository operations for reservation, indexed lookup, outcome and delivery.
Pin the transaction and ownership semantics in shared repository conformance,
including idempotence, conflicts, rollback, finalization order, immutable
notice payload and retry transitions. Run the ownership and process-death
cases on SQLite. Coordinate the type placement and schema with Core.

Conformance covers folded success and failure, including guest and owner
assignments with both policies on the owner notice, separate immutable
notice IDs, and exclusion of bindings outside the operation's causes.

Conformance verifies a live provider failure with its reason, a targeted
interruption with its reason, and pre-finalization crash uncertainty. Each
produces exactly one immutable outcome and notice on repeated staging.

Conformance verifies recognized safe reasons, fallback for absent or
untrusted details, and absence of provider-supplied secrets and oversized
reason text in both the outcome and notice. A known interrupted outcome
keeps the same delivery ID and reason on repeated staging.

## Gate 3 amendment

An assignment may span a steer chain. The lifecycle records an observed
steered cancellation as awaiting continuation, without staging a notice.
This is distinct from explicit interruption. Under the writer lock,
`continueAssignment` checks the current predecessor, claims the successor
worker/message key, and durably moves the active binding before successor
dispatch. The same committed triple is idempotent. A different successor,
an already claimed message, or a terminal predecessor is a conflict.
Keep predecessor keys as superseded for uniqueness and retries. Late
terminal records for superseded messages remain inspectable and cannot
settle the assignment. Linkage is an authorization fence, not evidence
that the successor actually ran.

If the successor will not run, the current owner explicitly closes the
awaiting continuation with a known failure or interruption and stages its
notice atomically. If the owner dies before an authoritative terminal
record, the next owner can settle the abandoned assignment as uncertain.
Neither recovery nor an idempotent continuation sends the prompt again.
Test both commit orders against predecessor finalization, a crash after
steer cancellation and before linkage, and a crash after linkage before
the successor's terminal commit. An assignment emits one terminal notice.
Original provenance survives a move. Policies attributed to taken work
survive the chain; terminal folded work unions the active causal policies
and staging freezes the applicable union.

Use typed native and ACP destinations. Native flush reads only native
destinations and respects earlier unresolved channel changes. ACP
delivery shares staging and compare-and-set transitions. It marks
delivered only on durable acceptance at the destination keyed by the
stable delivery ID, with idempotent retries; an unconfirmed append leaves
the notice pending. Until that receipt and deduplication path exists,
ACP delivery remains pending. Persist the worker handle before dispatch
as immutable attribution; staging and every retry use the same source,
ID, destination, text and policy set.

Discovery is read-only and indexed. Pages are oldest first using an
exclusive cursor over immutable increasing reservation sequence, scoped to
the destination kind and discovery state. Default 50, maximum 100. The
unstaged filter includes finalized but unstaged work and abandoned
bindings that the current owner may settle. It excludes unfinished work
owned by the current process, including awaiting continuation. Pending
means pending only; blocked_policy requires explicit retry. Concurrent
changes can make earlier rows eligible after a cursor has passed them,
so each new drain starts at the beginning. Latest outcome per worker is
the last staged outcome by greatest reservation sequence, with assignment
ID retained in the result. This supports restoring the worker view and
does not replace exact lookup by assignment ID.

Project only the last completed assistant message in the final operation,
by committed timeline sequence. Preserve its text exactly. A missing
message or an empty/whitespace-only text projection is a known failure
with the public reason "worker produced no saved result". Do not fall
back to intermediate output. A crash without reliable terminal evidence
remains uncertain.

Keep the existing harness wire contract. Prefer a typed, indexed additive
Agent migration for continuations, eligibility and provenance over
encoding searchable fields inside unrelated text columns. Core owns
schema 19. Allocate any new migration with Core, after the orchestrator
schema, before implementation. Legacy rows default to native destinations.
Legacy source falls back to the persisted worker conversation ID where
no handle was recorded. Existing staged results and notices retain their
original bytes and IDs, including their original text projection.

Gate 3 native delivery applies the existing delivery state transitions.
Schedule pending scans on open after channel changes, on eligible resume,
and after confirmation of an earlier change. Lost acknowledgement keeps
the same notice pending with the same ID and bytes. An invalid policy
moves it to blocked_policy until explicit retry. A missing or retired
destination moves it to failed_destination. Match confirmation to the
attempted delivery ID so a stale response cannot settle unrelated work.

If an Agent schema migration is needed, use version 20 after O1's version
19 lands. Exercise it on an actual alpha `3fd2db2` database through
schema 19, retaining legacy rows and pending payloads. Reopen a second
time to verify idempotence.

Combined successor prompts call continueAssignment in beforeDispatch
message order. The orchestrator reads the active predecessor from
readBinding. After m0→m1→m2, m1 is superseded even if both m1 and m2
appear in the final causes. Only m2 settles the assignment and one notice
results. The orchestrator calls closeContinuation if it knows an awaiting
successor will never dispatch and no terminal lifecycle callback will
settle it. Examples include a refused send before beforeDispatch or a
worker stopped while awaiting continuation. Once linked, promptFailed
for the active successor settles it; closing the stale predecessor
cannot overwrite it. Owner death leaves unfinished work for the
replacement to settle as uncertain.

The stable ID remains worker-result:<assignmentId> and can be derived
before staging. Delivery requires the committed staged payload. The
orchestrator owns the ACP idempotent append keyed by that ID. Its
worker_reply is the projected final text; missing or blank projection
maps to worker_failed with "worker produced no saved result".

Core allocated schema 20 after O1's schema 19. Implementation waits for
the reviewed O1 base before changing SQLite schema.
