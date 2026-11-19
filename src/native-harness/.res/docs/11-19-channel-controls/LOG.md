# Channel controls log

Branch `aiagent/native-channel-controls`. Base: persistence closure `3a236ac`
(approved behavior `9d9de35`). Spec and plan cherry-picked from `326ab17` as
`640ece1`. Implementer: this branch; reviewer: gro1a-o; coordinator: haurness-l.

## Stage 1: contract and decision

Decision `0014-channel-controls-contract.md`; type-only edits to
`src/contracts/{storage,agent,session,events,protocol}.ts`. No implementation.

Gate: the contracts compile alone (`tsc --strict` over `src/contracts/*.ts`).
`bun run typecheck` for the whole package fails only in the files that implement
or consume the changed contracts, as AGENTS.md expects of a contract-first
change: `state/storage/{engine,archive}.ts`, `kernel/channels.ts`, `index.ts`,
`interfaces/protocol/load.ts`, and tests that read event fields or build
`StoredChannel`. Stages 2 to 4 clear them; each stage gate returns to a green
typecheck.

### Contract-level traces (storage transactions are totally ordered)

| Race | Commit order A first | Commit order B first |
| --- | --- | --- |
| Suspend vs take | `takePending` first: items join the running turn; `beginChannelSuspend` then sets `suspending`; the turn checkpoints with them. | `beginChannelSuspend` first: `takePending`/`beginTurn` fail `channel_suspended`, items stay pending; the turn checkpoints or completes (completion refused while pending, so it checkpoints). |
| Interrupt vs result commit | `appendMessage` first: result recorded, then interrupt ends the turn; only calls still unanswered are uncertain. | `interruptTurn` first: turn interrupted, `appendMessage`/`confirmReceipts` refused `invalid_state`; the call is uncertain and never replayed. |
| Interrupt vs checkpoint (channel `suspending`) | `checkpointTurn` first: channel `suspended` with checkpoint; interrupt returns `interrupted: false`, checkpoint intact. | `interruptTurn` first: turn interrupted, channel `suspended` without checkpoint, pending kept; `checkpointTurn` fails `invalid_state`. |
| Withdraw vs take | `withdrawItem` first: `withdrawn`, never taken, a retry via `acceptItem` returns it withdrawn. | take first: `withdrawItem` returns `taken` with turn ID, item stays on the timeline. |
| Delete vs send | `acceptItem` first: item pending, `deleteChannel` fails `channel_busy`. | `deleteChannel` first: `retired`; `acceptItem` fails `channel_retired`. |
| Session resume around a suspended channel | `resume()` skips turns of `suspended` channels and does not check their key. Channel stays suspended, checkpoint intact. | `resumeChannel` while session suspended: clears channel suspension only; checkpoint stays under the session suspension; the later `resume()` continues it. |

Other compositions: a crash before channel suspension commits leaves `suspending`
(returned to `open` on open) with the running turn interrupted and pending
items kept; a crash during session suspension interrupts checkpoints of non-
`suspended` channels only, so an earlier committed channel checkpoint survives;
checkpoint survival is derived (session `suspended` or channel `suspended`), so
no owner marker has to be kept consistent.

### Compatibility (written before implementation)

Format 2 databases open and are upgraded in the recovery transaction; archive
version 1 imports; existing channels are `open` with no individual suspension;
session-wide suspension and its checkpoints resume as before. See decision 0014.

### Stage 1 review round 1 (gro1a-o, `1f90c97` not approved)

Fixed in the next commit: withdraw covers notices; snapshot items include withdrawn
items; retired channels' turns are rejected on import and never resumed
(`resume()`, `resumeChannel`); wire export and stop comments match storage; omitted
interrupt reason is `"interrupted by request"`. The red full typecheck is accepted
until Stage 4's gate.
