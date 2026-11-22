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
and operation IDs. Store the destination and originating policy-name set
with it. Commit the binding before sending the ACP prompt. An identical
reservation can recover that binding. A conflicting reservation writes
nothing. Redispatch is never a recovery action for an existing binding.

Recover by assignment ID through the production index and read the
authoritative final worker conversation record by worker and operation.
A streamed chunk or draft cannot serve as a result. Check supported backend
recovery when no reliable final record exists. If neither source establishes
a reliable outcome after an abandoned dispatch, stage an uncertainty outcome
that identifies the assignment and worker and preserves original provenance.
Run this resolution only for abandoned work, once the original owner can
no longer finalize it. Live operations continue under their current owner.

In one Agent database transaction record the resolved result or uncertainty
and the exact pending notice. Enforce at most one terminal outcome and notice
intent per assignment. Repeated resolution returns the committed outcome.
Rollback leaves neither record. Allocate one stable delivery ID at staging
and retain it with the payload across reconnect and explicit retry.
A redirect committed before staging supplies the destination. A redirect
committed afterward leaves the staged payload intact. Preserve the original
policy names and identify the worker as source. The durable result remains
inspectable after any delivery outcome.

Flush notices through the owning host after earlier channel changes.
Suspension and unresolved changes leave notices pending. Resume and change
confirmation schedule eligible retries. Invalid policy blocks until explicit
retry. Missing or retired destinations fail delivery. A receipt, including
a duplicate receipt, confirms delivery. Retry a lost acknowledgement with
the same ID and exact payload.

The fixture-local transcript scan from the feasibility proof is unsuitable
for production lookup. A second option, provider replay, depends on
provider-specific guarantees and is not required when the final Agent record
is available. The harness wire and archive formats are unchanged. Agent
schema numbering and implementation ownership are coordinated with the
R1–R3 and orchestrator workstreams before runtime changes.

Exercise both sides of final-record commit in real SIGKILL/replacement tests
using the production index. Observe the binding on disk at ACP prompt
receipt, prove that the post-final crash left no staged result or notice,
and recover the exact result and original provenance twice. For the
pre-final crash, confirm one uncertainty notice, stable retry ID, and no
redispatch. Exercise rollback, both redirect commit orders, a crash after
redirect, recovery after staging, and acknowledgement loss. Deterministic
ACP peers cover the saved-record boundary offline. Live-provider
finalization and recovery semantics remain unverified.
