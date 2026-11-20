# acp-client integration protocol

Date: 2026-11-20.
Status: proposed for review.

Companion to the [integration spec](SPEC.md). Use the typed public
`HarnessClient` over stdio. This document defines the acp-client integration
profile and the additions it needs on top of the reviewed model-execution
stack. The
[original protocol](../../../../../../.res/somelogs.md/11-11+/11-12-SPEC-harness-protocol.md)
already specifies applying pending channel changes at open. Preserve that
ordering with the current channel controls.

## Open and apply pending changes

Attach event handlers before `initialize`. Check that the server supports
durable sessions, channel controls, and the approval flow. Use
`session/load` first and `session/create` on a confirmed `not_found`. Load
uses the current rules for resolving inline, file, and saved config.

Extend create and load with an optional batch of coalesced channel changes.
The names below are proposed for the contract gate.

```ts
type PendingChannelChange = {
  channel: string
  changeId: string
  displayName?: string | null
  policy?: string | null
  lifecycle?: "open" | "suspended" | "retired"
}

type ChannelChangeResult = {
  channel: string
  changeId: string
  outcome: "applied" | "blocked"
  reason?: "channel_busy" | "channel_retired" | "incompatible"
}
```

`changeId` identifies the host's version of the change. Missing fields leave
existing values alone. Null clears a name or policy. The first batch supports
creation, name and policy edits, explicit suspension and resume, and retirement.
`open` clears an individual suspension, with execution still subject to the
session's lifecycle. New channels can be provisioned by the batch. A retired ID
cannot be reopened. A repeated retirement of that same ID is already applied.

Reject the whole batch before applying any channel changes if an entry is
malformed, a channel appears twice, or a policy name is unknown. For a valid
batch, resolve each channel change atomically with its channel state:

- Apply successful changes before making recovered work eligible. Return the
  result for each change in the open response.
- If retirement is blocked by pending input or a checkpoint, durably suspend
  that channel and return `blocked` with `channel_busy`. Preserve its pending
  input and checkpoint. Continue opening the rest of the session.
- A request to reopen a retired ID returns `blocked` with `channel_retired`
  and leaves the ID retired. A resume against an incompatible checkpoint
  returns `blocked` with `incompatible` and leaves the checkpoint suspended.
  Independent channel changes can still apply.
- An open or load response does not resume a suspended session. Apply ordinary
  checkpoint compatibility checks before resuming an individual channel.
- A changed policy applies to future acceptance. Previously accepted inputs
  keep their resolved policies.

The load view includes the resulting channel state and is sent before events
from recovered work. The before-execution guarantee covers the batch sent
with open. Later edits go through the live channel API.

acp-client clears a local pending change only after receiving an applied result
with the matching `changeId`. Pending deletion stays pending until confirmed.
On the same open connection, a repeated load returns a fresh recovery view
with the recorded startup results, without applying the batch again. A
different batch on an already-open connection is rejected. Use the live
channel API for newer changes.

On a new connection, send only the newest pending desired state per channel.
An already-applied change can be applied to the same effect, including a delete
that finds its ID already retired. A blocked change can be re-evaluated after
its obstacle is resolved. This assumes one managing host per session. The
protocol does not retain a durable ledger of startup commands or arbitrate
conflicting intents from independent hosts.

## Input, turn, and approval mapping

| Wire operation or event | Host interpretation |
| --- | --- |
| `channel/push` | Save the stable input ID and exact payload on the host before sending. Success acknowledges durable receipt. Recover an ambiguous submission by reconciliation or retry with the same ID and payload. |
| `turn_started`, `turn_took` | Associate the listed input IDs with the turn. A message folded into a running turn settles with that turn. |
| `items_receipt` | Update Delivered or Seen for the named inputs. Take and model receipts represent different milestones. |
| `message_completed` | Upsert the committed reply by message ID. Resolve a reference through `session/message/read`. Fold live deltas into the same message ID when streaming. |
| `approval_requested`, `approval/respond` | Route a specific call to the consumer and answer once. Without an approval handler, leave the call unapproved and resolve promptly. Keep late answers closed. |
| `channel/withdraw` | Settle a waiting prompt as withdrawn when confirmed. If already taken, keep its association with the reported turn. |
| `channel/interrupt`, `turn_ended` | Interrupt the named turn only. Settle its associated prompts from the terminal event or recovered outcome. |

Use the existing `final` and `stream` subscriptions. Host-side queueing
controls when acp-client submits an input. The harness has one take behavior.
The profile has no agent-wide or channel context reset operation. Opening a new
channel preserves the session identity and timeline.

## Recovery view

Use the current revisioned `session/load` view for the first small scripted
integration. Reconcile channel states, turns, inputs, and committed messages
by stable IDs. Buffer events arriving after the load response while applying
the view, then apply them in delivery order. Several events can share a
revision. A revision identifies the snapshot boundary rather than one event.

Before long-running mock sessions depend on reopen, add a bounded recovery view.
The open response supplies a revision and initial pages or cursors for channel,
turn, input, and message records. Read further pages against the same view so
later updates cannot alter its contents halfway through reconciliation. Use
opaque cursors and bound each page by encoded bytes. An oversized reply uses a
message reference and the existing bounded text reads. The contract gate
defines cursor lifetime, cleanup, and how to recover when a view expires.

If the process dies after committing a reply but before publishing it, reopen
finds the reply by its original ID. If a turn was interrupted, acp-client
settles the inputs it took with that outcome. An untaken accepted input is
still pending. Preserve reported uncertain tool outcomes. Reopen never
replays an interrupted tool call or restores an old approval grant.

## Contract checks

- Reopen with a suspension made while stopped. Verify no recovered turn
  starts on that channel and another channel can run.
- Reopen with a delete blocked by pending work. Verify the target is suspended,
  its work is intact, and the host leaves the change pending.
- Simulate a newer local edit while an earlier change is in flight. Verify the
  earlier acknowledgment cannot clear the newer edit, and that fresh host
  input waits for the live edit to apply.
- Reject an invalid batch without changing any channels. Confirm other
  channels can open when a valid batch contains a state conflict.
- Lose a push response after durable acceptance. Reconcile or retry using
  the host's saved submission and verify that only one input exists.
- Lose the open response after the batch commits. Verify a repeated load
  on the same connection reports the original results without reapplying
  changes. Reconnect and verify that retrying desired state is safe.
- Recover a missed committed reply and pending and interrupted inputs. Before
  the long-running mock gate, exercise a recovery view larger than one frame
  while live events continue beyond its revision.
