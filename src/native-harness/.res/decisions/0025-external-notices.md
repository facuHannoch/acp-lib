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

A terminal failure or interruption under the current owner stages an
uncertainty outcome and stable notice per affected assignment in the
same transaction that records the terminal operation. Use causal message
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

Both result and uncertainty notices start in `pending`. Flush them through
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
