# 0020: Channel changes applied at session open

## Problem

A host edits, suspends or deletes channels while the harness is stopped. Those
changes must take effect before work recovered by the next open can run.
The live channel API (0014) only exists after open, when recovered work may
already be eligible. See the
[acp-client integration protocol](../docs/acp-client-integration/0001-DESIGN/PROTOCOL.md).

## Options

(a) Have the host open, then call the live channel API, and delay `start` with a
separate "ready" request. (b) Carry one coalesced batch on `session/create` and
`session/load` and apply it before the session starts. (c) A new storage
transaction for the whole batch, or (d) compose the existing per-channel
storage transitions before start.

## Choice

(b) with (d). `session/create` and `session/load` accept an optional
`channelChanges: PendingChannelChange[]` and return `channelChanges:
ChannelChangeResult[]`, one result per entry in request order. The field is
present in a result only when a batch was sent or recorded. A server advertises
the feature as `capabilities.startupChannelChanges: true`.

- **Entry.** `{ channel, changeId, displayName?, policy?, lifecycle? }`. A
  missing field leaves the value alone; `null` clears a name or policy.
  `lifecycle` is `open`, `suspended` or `retired`. `changeId` is opaque to the
  harness and echoed back; the host uses it to match its own version.
- **Validation.** The whole batch is rejected with `invalid_params` (or
  `invalid_policy` for an unknown policy name), before any channel changes and
  before the session is started, when an entry is malformed, has an unknown
  field, repeats a channel, or names a policy the open's configuration lacks.
- **Application.** Each entry reuses the 0014 transitions through
  `PersistentSession.channels`; no storage contract changes. An unknown channel
  is created. The lifecycle step is decided first and the name and policy are
  written only if it is not blocked, so a blocked entry changes nothing except
  as stated below. Entries are independent: one blocked entry never stops the
  others or the open.
- **Outcomes.** `applied`, or `blocked` with a reason:
  `channel_busy` — retirement found pending input or a running or checkpointed
  turn; the channel is durably suspended instead and its work kept.
  `channel_retired` — the ID is retired and the entry asks for anything but
  retirement (a repeated retirement is `applied`).
  `incompatible` — resuming would continue a checkpoint or policy reference the
  current configuration cannot run; the channel stays suspended.
- **Ordering.** The batch is applied after recovery and before `start`. The
  load view is read after the batch, so it shows the resulting channel state,
  and events from recovered or resumed work follow the response as in 0013.
  Resumes are applied last and synchronously with the view, because resuming a
  checkpoint makes that turn run. An open never resumes a suspended session.
- **Retry.** The endpoint records the batch and its results. A repeated
  `session/load` on the same connection with the same batch, or with none,
  returns a fresh view and the recorded results without applying anything. A
  different batch on an open connection fails `invalid_state`; later changes use
  the live channel API. On a new connection the host resends its newest desired
  state: every transition is idempotent, so an already-applied entry applies to
  the same effect and a blocked entry is re-evaluated. No durable ledger of
  change IDs is kept, which assumes one managing host per session.
- **Atomicity.** An entry is several storage transactions, not one. Nothing can
  interleave because the session has not started and the endpoint admits no
  other request for the session until the open is answered. A crash mid-batch
  leaves a prefix applied; the host has no confirmation and resends.

## Compatibility

Additive and optional on the wire. Old hosts send no batch and see no new
field. A host must check the capability before relying on the ordering
guarantee: an older server rejects the unknown `channelChanges` field with
`invalid_params`. No storage format or archive change.
