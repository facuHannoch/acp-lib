# Durable delivery, lifecycle and load contract (storage revision 2)

## Problem and options

Revision 1 (0012) saves one queued turn per input, cannot deduplicate, loses
notices and has no suspension. `Agent.send` resolves with the reply, so
acceptance and completion are one promise. Options: (a) keep one turn per input
and add a separate notice table; (b) keep send-awaits-reply and add an ack
callback; (c) one durable inbox for messages and notices, turns created at take.

## Choice

(c). `contracts/storage.ts` is rewritten as format 2; nothing implemented it.

- **Acceptance.** `acceptItem` commits a pending item (Received). `send`/`notify`
  on the new `SessionAgent` return a synchronous `SendResult` after that commit.
  Same ID and payload returns the original in every lifecycle state; a different
  payload is `item_conflict`.
- **Take and correlation.** `beginTurn`/`takePending` move pending items into the
  timeline and link them to the turn in one transaction. `turn_started`/`turn_took`
  list the item IDs; `message_completed` and `turn_ended` report the outcome
  separately. Several IDs may share a turn. No public wait-for-reply helper. The
  local chat adapter follows these events privately to hold its HTTP request
  until the turn that took its item ends.
- **Finish.** `finishTurn(completed)` checks the pending inbox in its own
  transaction and returns `finished: false` if items arrived first.
- **Failure.** Failed and interrupted turns are terminal; the channel stays
  usable. Calls without a recorded result become `uncertainCallIds` and are never
  re-executed. `appendMessage` on an ended turn is refused, fencing late results.
- **Lifecycle.** `beginSuspend`, `checkpointTurn`, `completeSuspend`, `resume`.
  Only committed `suspended` preserves checkpoints across reopen; any other
  reopen interrupts unfinished turns. A compatibility-key mismatch no longer
  fails open; it fails `resume` of a checkpoint without changing it.
- **Load.** `session/load` returns one view at a storage revision. Events carry
  `revision`. Events included in the view precede the response or are dropped;
  pending input becomes eligible only after the response is written.
- **Receipts.** `confirmReceipts` records Delivered/Seen for the items of the
  turn whose model call resolved; `items_receipt` follows the commit.
- **Stop.** `Model` and `ExecuteTool` accept an optional abort signal. Stdin EOF
  becomes stop (interrupt now), replacing 0011's five-second drain when wired.
- **Archive.** `exportArchive`/`importArchive` use a logical `SessionArchive`
  (version 1, independent of the storage format). Wire transfer: 512 KiB chunks,
  256 MiB maximum, one transfer per connection, temporary file removed on close,
  import, 60 s idle or connection end.
- **Wire names.** `session/{load,messages,status,suspend,resume,stop,export,import}`,
  `transfer/{open,write,read,close}`, notification `session/event`. Error codes:
  `DurableErrorCode` in `contracts/protocol.ts`.

## Compatibility and verification

Additive for running code: the memory `Agent`, `TurnRunner` and `HarnessSession`
remain until Stage 3 replaces them with `SessionAgent`, `TurnExecutor` and
`PersistentSession`. Capabilities still report memory acceptance. A new turn now
takes every pending item on its channel, so queued messages can share one reply.
Item signatures cover joined text, not part boundaries. Load pages messages
only; turns and items must fit one frame. Verified by typecheck only; no storage
behavior is claimed before the adapters pass conformance.
