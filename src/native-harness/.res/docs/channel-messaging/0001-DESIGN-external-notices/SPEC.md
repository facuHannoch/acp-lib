# External channel notices

Date: 2026-11-21.
Status: design reviewed. See [PLAN.md](PLAN.md) for implementation gates and
the worker recovery prerequisite.

## Goal and ownership

Let a consumer send a notice into an existing channel through `channel/notify`.
The harness stores it as an `external_notice` in the channel's existing durable
inbox. A worker finishing an assignment is the first use case. The orchestrator
owns the assignment, result, and delivery destination. The harness owns notice
admission, attribution, turn scheduling, and execution.

This is the first slice of channel messaging. Reuse the existing inbox and
lifecycle in [channel controls](../../11-19-channel-controls/SPEC.md) and the
open and history operations in [operator controls](../../operator-controls/0001-DESIGN/SPEC.md).
For worker delivery, use the provenance from the
[callback policy amendment](../../tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md).
Topics, participant targeting, urgent delivery, and participant-facing messages
are separate work.

## Public request

`channel/notify` takes a target channel and a notice with a stable ID, text,
an optional source label, and inherited `policyNames`.

```json
{
  "channel": "alice",
  "notice": {
    "id": "worker-result-42",
    "text": "The dashboard check passed.",
    "source": "worker-7",
    "policyNames": ["guest"]
  }
}
```

The session's owning host connection can submit this operation. The optional
source label is host-supplied attribution. Source data conveys no permission
and identifies no harness source turn. A notice without a source is attributed
to the host. Participant messages use `channel/push`. Harness-originated
notices use the existing `notify_channel` path.

Return the existing class of inbox receipt after acceptance commits. A receipt
confirms that the harness owns the notice. The channel's events report taking,
execution, and any eventual reply.

## Policy

Resolve the destination channel's policy, or the session default if the channel
has none. Validate the notice's inherited `policyNames` against the active
session configuration and record them on the accepted item. An explicit empty
list carries no additional named restrictions. The receiving turn evaluates
the destination and inherited policies together with the policies from its
other taken inputs, using the existing composition rules.

For a worker result, acp-client preserves the names from the assignment's
originating callback and sends them with the notice. The orchestrator also
retains the assignment's resolved worker rules for permission requests made
by that worker. Those rules remain in the orchestrator. An unknown policy
name returns `invalid_policy` before acceptance and leaves the notice with
the consumer. Names resolve against the active definitions on delivery.
Historical policy snapshots and cross-session provenance are deferred.

## Admission and reconnect

A new external notice requires an existing, open channel in a session that
admits work. It can steer a running turn at its next inference boundary or
wake an idle channel when nobody is attached. During session or channel
suspension, including the drain, refuse new external notices. Return distinct
outcomes for missing and retired channels. Existing rules for internal notices
from a running harness turn still apply.

Use the existing durable inbox deduplication. After checking the request shape
and owning host, look up the ID and compare the payload through a read-only
path before checking admission and active policy for new work. Return the
recorded receipt for an identical accepted notice, including during suspension
or when the session is open for inspection only. An unknown ID goes through
normal admission. Use the notice kind, destination, attribution, text, and
inherited policy names when checking for conflicts. Reusing an ID for a
different item returns `item_conflict`. Connection IDs and host software
versions do not participate in deduplication. Treat policy names as a set.

Reuse acp-client's startup and reconnect flow for delivery:

1. Open the agent with its active configuration and apply pending channel
   changes before attempting saved notice delivery.
2. Deliver saved notices through `channel/notify` in the existing per-channel
   host sequencing. Keep each notice separately and preserve its ID and payload
   until acceptance is confirmed. Apply any earlier unresolved channel change
   before delivering that channel's notices.
3. Flush pending notices on open. A notice waiting on suspension or an earlier
   channel change stays pending. A successful channel or session resume or
   confirmation of the earlier change schedules another attempt through the
   same host queue when the channel is eligible. Retry lost acknowledgments
   with the same ID and payload. `invalid_policy` marks delivery blocked and
   requires an explicit retry after a configuration fix. A retired or missing
   destination records delivery failure. Blocked and failed delivery leave the
   worker result available through the orchestrator.

Already accepted harness work may become eligible at session open. Saved
notices join through normal inbox steering when delivered.

## Durable worker handoff

For persisted Agents, a completed worker result must survive an acp-client
crash before the harness accepts its notice. Before work starts, persist the
stable assignment identity and delivery provenance needed to recover the
completion, including the destination and originating policy names. Use a
worker backend that retains completion until acknowledgment or can recover
the result by assignment ID. Verify that capability for the first backend.

In one Agent database transaction, record the worker result and stage its
pending notice with a stable delivery ID, destination, and exact payload.
Confirm staging to the worker backend only after the transaction commits.
On restart, recover completed assignments that have not been staged, and
retry notices already staged. A repeated completion resolves to the same
result and notice ID.

When a redirect takes effect, persist the assignment's destination and policy
provenance together. Staging reads that assignment state in the same
transaction that freezes the notice payload. A redirect committed before
staging determines the new destination. If staging commits first, that notice
keeps its original destination. When a worker turn includes work from both
sides of a redirect, carry the policy names from both sides so their
restrictions still apply. Retries use the staged payload unchanged.

acp-client retains the delivery record until the harness acknowledges
acceptance. A duplicate receipt counts as acceptance. If the destination is
blocked or delivery fails, record the outcome, stop automatic retries, and
retain the result for inspection.
This guarantee covers recovery and inbox acceptance. Turn execution and the
agent's reply follow the existing lifecycle and recovery rules. See the
[orchestrator delivery flow](../../../../../../.res/somelogs.md/11-11+/library/11-11-SPEC-orchestrator.md#flow-3-the-way-back).

## Context and observation

Render the notice as attributed external input in the existing context builder.
Expose it as a distinct event in the agent timeline with its channel, accepted
identity, and source attribution. Correlate it with the turn through the
existing receipt and take events. Conversation pages continue to count
participant and assistant messages. The agent's resulting reply is available
through ordinary message delivery and recovery.

Persist the notice through the existing inbox and archive paths. Preserve its
ID, source, and policy metadata across export and import. Extend the signature
for external notices while preserving existing item signatures. The contract
review determines the storage and archive version changes needed for the new
record shape.

## Acceptance

1. Over real stdio, send a notice with worker attribution to an idle channel
   while nobody is attached. Verify durable acceptance, one notice-driven
   turn, attributed model input, and an agent reply recoverable on reattach.
2. Deliver a second notice during a held turn and verify it is taken at the
   next inference boundary, preserving channel and source attribution.
3. Deliver a worker result from a `guest` assignment to an `owner` channel.
   Verify both policies contribute to the receiving turn and guest restrictions
   still affect tool decisions. Check that unknown policy names are refused.
4. Lose the acceptance response and retry the same notice across reopen.
   Verify one inbox item and one take. Retry with a changed payload and verify
   a conflict. Check duplicate receipt lookup during suspension and during a
   read-only open with an incompatible execution configuration. Verify a new
   ID remains subject to admission.
5. Save notices while the harness is offline, restart acp-client, then reopen
   the harness with a pending policy edit or suspension. Verify channel changes
   take effect before new notice delivery and distinct notices are retained
   until accepted. Resume the channel on the same connection and verify its
   pending notices deliver. Verify confirmation of an earlier channel change
   also unblocks a pending notice. Verify a retired target leaves its result
   available through worker status.
6. Verify the external notice appears in the agent timeline and does not
   consume the conversation page's message count.
7. Crash acp-client after the worker finishes but before staging, after the
   staging transaction commits but before sending, and after harness acceptance
   but before acknowledgment. Verify the result is recoverable at each boundary
   and a deliverable notice has exactly one accepted inbox item. In the last
   case, retry must start no additional turn, even if the original turn was
   interrupted. Reply recovery is exercised separately in case 1.
8. Export and import a pending notice and an already taken notice. Verify
   attribution and policy metadata survive and retries return duplicate
   receipts without taking either notice twice.
9. Exercise both commit orders for redirect and staging. Crash after a redirect
   commits and before staging. Verify recovered completion uses the committed
   destination and retains restrictions from any work taken before the redirect.
