# Persistence work log

See [SPEC.md](SPEC.md) for the behavior and [PLAN.md](PLAN.md) for the work and
acceptance gates.

## Entries

- **Planning.** Consolidated the spec, implementation plan and work log in one
  folder. Branch and agent assignments are pending.

- **Assignment (coordinator haurness-l).** Implementer clad1a-n owns branch
  `aiagent/native-persistence` from base `93939c3` (stdio `bb615e0`). Reviewer
  gro1a-o reviews each named stage revision directly. Base: typecheck clean,
  44 tests pass.
- **Stage 1, contracts (implementer).** Decision
  [0013](../../decisions/0013-durable-delivery-contract.md); contracts revised in
  `src/contracts/{storage,agent,session,events,protocol,context,loop}.ts`. No
  kernel, adapter or interface code changed. Gate: `bun run typecheck` clean;
  `bun test ./test` 44 pass. Contract-level account of the three review cases:
  - *Message at the finish boundary.* Storage calls are synchronous, single-owner
    transactions, so `acceptItem` and `finishTurn(completed)` commit in one
    order. Accept first: finish sees the pending item, leaves the turn running
    and returns `finished: false`; the loop calls `takePending` and infers again,
    so the item joins this turn. Finish first: the turn is completed, the item is
    pending on a channel with no live turn, and the scheduler's post-accept
    `beginTurn` starts the next turn with it. `beginTurn` returns null while a
    turn is live, and take moves an item out of pending in the same transaction
    that links it, so it reaches exactly one turn. While suspending the same
    check applies but nothing is taken: accept first means finish returns
    `finished: false`, the turn is checkpointed with the item still pending, and
    after resume that same turn takes it before its first inference. Finish
    first means the turn is completed and the item waits for a `beginTurn` after
    resume. A turn with a final tool-free response and nothing pending completes
    and cannot be checkpointed.
  - *Crash before take.* The item is committed pending and nothing else changed.
    Reopen keeps it pending with no turn link. If the acknowledgment was lost,
    resending the same ID returns the original item. It becomes eligible when
    the host starts execution after load.
  - *Crash after take.* Take committed item, timeline entry, turn link and (for
    `beginTurn`) the running turn together. Reopen marks that turn interrupted;
    the item stays `taken` on it and is never pending again. Recorded calls
    without results are listed as uncertain and not re-executed. The channel
    begins a new turn for fresh input. A crash inside the transaction lands on
    one of the two sides.
  - *Load then live events.* `session/load` reads one snapshot at revision R and
    execution is started only after the response is written, so events for
    recovered work follow it. Events carry their commit revision: those at or
    below R are already in the view and are not sent after the response; those
    above R follow it.
- **Stage 1 review (reviewer gro1a-o), `9ca6bd4`: not approved.** Accepted the
  parallel old/new types, shared turns, immediate stop on EOF and the account
  above. Nine findings, all addressed in the next revision: suspension finish
  boundary; `confirmReceipts`/`takePending` refused unless the turn is running;
  `interruptActive` for stop during suspension; open never writes the
  compatibility key; exact signature and `auto:<n>` item IDs; `session/event`
  delivery; `transfer_limit` for oversized load views and archives; revision 2
  conformance list and the 0011 note; `participantIds` wording and ignored push
  `delivery`/`wake`. One deviation from the wording of finding 6: widening the
  existing notification union breaks `src/interfaces/client.ts` at typecheck,
  which a contract-only stage may not edit, so `session/event` is delivered
  through a `subscribeSession` member on the transport and endpoint contracts.
- **Stage 1 re-review (reviewer gro1a-o), `5514934`: not approved, one finding.**
  The eight other fixes and the `subscribeSession` deviation were accepted.
  Fixed next: `exportArchive` is `busy` for the whole `suspending` state, and
  `importArchive` rejects a `suspending` archive as `invalid_archive`.
- **Stage 1 approved (reviewer gro1a-o): `6fddbe6`.** Export is limited to an
  idle or cleanly suspended session; import rejects a `suspending` archive or
  one holding a running turn.
- **Stage 2, storage (implementer).** `src/state/storage/{engine,memory,sqlite,archive}.ts`,
  shared suite `test/conformance/storage.ts`, `test/storage-{memory,sqlite}.test.ts`.
  One engine implements the contract over a small row interface, so both
  adapters share every rule; SQLite adds the schema, the exclusive file lock
  and publish-by-hard-link for create and import. Not connected to execution.
  Gate: `bun run typecheck` clean; `bun test ./test` 86 pass, 0 fail (44
  existing, 18 conformance per adapter, 6 SQLite-only). SQLite-only checks:
  another process's live owner is refused and SIGKILL releases it; SIGKILL
  while running and while suspending leaves taken input on an interrupted
  turn with its uncertain call, untaken input pending, retries deduplicated
  and the channel able to begin turn 2; junk, foreign and future-format files
  are refused byte-for-byte unchanged; failed creates/imports leave no files;
  an injected mid-transaction failure rolls back the whole take. Deviations:
  none from the contract. Note: the SQLite tests take about 9 s because every
  commit is fsynced.
- **Stage 2 approved (reviewer gro1a-o): `f2e7873`.**
- **Stage 3, delivery and recovery (implementer).** The scheduler
  (`src/kernel/channels.ts`), loop and session assembly now run on storage; the
  memory-only `Agent`/`TurnRunner`/`HarnessSession` types and
  `shared-context.ts` are removed. The local chat adapter holds each request by
  following events to the turn that took its item. The protocol server adds
  `session/load`, `session/messages`, `session/status`, durable push
  acknowledgments and `subscribeSession`; the scripted server takes
  `--home <directory>` for SQLite sessions. Later context states unfinished
  turns and their uncertain calls. Gate: `bun run typecheck` clean;
  `bun test ./test` 104 pass, 0 fail, run four times. Real child processes,
  each killed with SIGKILL from inside immediately after a named commit
  (`test/crash.test.ts`): before take the input is pending and runs once after
  reopen; after take it stays on one interrupted turn and is not run again; a
  tool effect with no committed result is reported uncertain and the effect log
  still has one line after fresh work; a committed reply the client never
  received is returned by load; the load response precedes live events, which
  all carry later revisions; a second process is refused. A message racing
  completion is swept across 40 interleavings twice (`test/persistence.test.ts`):
  each item reaches exactly one turn, and all three outcomes occur. Deviations
  and limits: `suspend`, `resume` and `stop` exist on the session but are not
  reachable from the protocol and have no end-to-end test until Stage 4; stdin
  EOF still drains; `bun run start` still uses memory storage until Stage 6.
  Events are not durable: a killed process may not have flushed events it
  published, which is why load is the recovery path.
- **Stage 3 review (reviewer gro1a-o), `1191c4c`: not approved, two findings.**
  Fixed next. The loop now records the assistant message, publishes it, then
  confirms Seen, so a crash between the two commits leaves the reply durable
  and the receipt unadvanced (new child-process test at `appendMessage:1`).
  Message paging fails only when the first record of a request cannot fit a
  frame; a fitting page before an oversized message is returned whole.
- **Stage 3 approved (reviewer gro1a-o): `44fd9d5`.**
- **Stage 4, suspension (implementer).** `session/suspend`, `session/resume`
  and `session/stop` on the protocol server and client, lifecycle
  notifications through `subscribeSession`, and a `hold` scenario tool that a
  test can keep running. The kernel paths were written in Stage 3; this stage
  exposes and tests them. Gate: `bun run typecheck` clean; `bun test ./test`
  115 pass, 0 fail, run six times. `test/suspension.test.ts`, on both
  transports unless noted: two channels with running tools suspend only after
  the tools finish, each checkpoints without inferring, and the hold log shows
  each tool once; after reopen nothing runs or is published for 150 ms and
  pushes are refused until resume; on resume the pending message joins its
  channel's resumed turn (one `turn_took`, one turn), no tool call repeats and
  fresh work runs. A checkpoint under another system prompt loads but fails
  resume as `incompatible` with the load view byte-identical before and after.
  Stop during a running tool answers at once, reports the turn interrupted
  with its uncertain call, keeps pending input, and a late release changes
  nothing. In-process: stop during suspension resolves the suspend as
  `stopped` and interrupts the checkpointed turn; suspension during inference
  completes a tool-free answer and checkpoints a tool-requesting one; a notice
  accepted during suspension starts no inference until resume. Stdio only: a
  child killed after a checkpoint commit and before suspension commits reopens
  as running with that turn interrupted. One correction during the stage: the
  loop no longer publishes a failed tool event for a turn that stop already
  ended. Stdin EOF still drains, as agreed with the reviewer.
- **Stage 4 approved (reviewer gro1a-o): `5c61d7b`.** Archive bytes decided by
  the reviewer for Stage 5: one UTF-8 JSON document of the SessionArchive with
  nothing in front of it; length and SHA-256 are those of the file bytes.
- **Stage 5, portability (implementer).** `session/export`, `session/import`
  and `transfer/{open,write,read,close}` on the server
  (`src/interfaces/protocol/transfers.ts`), `exportTo`, `importFrom`,
  `exportArchive` and `importArchive` on the client. `validateArchive` now also
  rejects a duplicate `acceptedSeq`, with a shared conformance case. Gate:
  `bun run typecheck` clean; `bun test ./test` 123 pass, 0 fail, run three
  times. `test/portability.test.ts`, on both transports unless noted: a
  suspended session with a checkpoint and five 300 KB pending messages exports
  as a 1.5 MB archive (more than one frame), imports into a fresh home, loads
  identically to the source, keeps deduplication, and after resume the pending
  input joins turn 1 while the hold log still shows the tool once; a second
  import is `already_exists`; a path import under a new session ID keeps the
  inner IDs. Truncated, non-JSON, non-UTF-8, edited, `suspending`,
  duplicate-`acceptedSeq` and wrong-version archives, a missing or junk path,
  an incomplete upload and a wrong hash are each refused with the destination
  directory listing unchanged and the session still `not_found`. Transfer
  rules: second open, offset gap, oversize chunk, overrun, repeat offset and
  size over the limit are `transfer_limit` and write nothing. Export is `busy`
  with active or pending work and for the whole `suspending` state, and an
  existing export path is `already_exists` with the file untouched.
  In-process only (small injected limits): an over-limit export leaves no
  file; an idle transfer and one open at connection end are removed. Stdio
  only: a transfer file left by a killed process is removed when the next
  process starts. Transfer files are named with the owning PID and only files
  of dead processes are cleaned at startup, because two servers can share a home.
- **Stage 5 review (reviewer gro1a-o), `35912c3`: not approved, two findings.**
  Fixed next, with `test/transfers.test.ts`: a transfer whose temp file cannot
  be created or appended to is closed instead of holding the connection's one
  slot or leaving a half-written offset; a download returns only the bytes
  read and reports the end only at the announced length; startup cleanup
  removes a transfer file only when its process does not exist (ESRCH), not
  when it cannot be signalled (EPERM).
- **Stage 5 re-review (reviewer gro1a-o), `9068698`: not approved, one finding.**
  Fixed next: `exportArchive` fails `invalid_archive` when a read returns no
  bytes without reaching the end (or more bytes than announced) instead of
  repeating the offset, and closing a transfer frees its slot before removing
  its file.
- **Stage 5 approved (reviewer gro1a-o): `291abf8`.**
- **Stage 6, development integration (implementer).** Stdin EOF is now stop,
  as decision 0013 records, in its own commit (`7a355ea`) with a real-process
  test. `src/interfaces/cli/development.ts` is the development session that
  `bun run start` runs: `--db <file>` with `--create`, `--resume`, and
  `--script <file>` for offline runs; `bun run status|suspend|resume` control
  the running agent over its Unix socket only. The inspector reads storage at
  attach and after every commit: lifecycle and storage in the header, and per
  channel the active or checkpointed turn, pending input, and an unresolved
  failed or interrupted turn with its uncertain calls. The local chat adapter
  now answers a request whose turn is checkpointed by suspension instead of
  holding it open (found when a server could not shut down in a test).
  Gate: `bun run typecheck` clean; `bun test ./test` 134 pass, 0 fail, run
  three times. Restored timeline before a new message:
  `test/development.test.ts` reopens a SQLite session and compares the
  inspector's entries, rendered base, channel messages and served `/state`
  with the first process before anything is sent. End-to-end scenarios,
  public client to real child processes (`test/e2e.test.ts`): clean relocation
  (two channels, input accepted mid-tool, suspend, export, stop source, import
  into a fresh home, load equals the source view, resume; the input reaches
  one turn and the hold log shows each tool once) and crash recovery (five
  process lifetimes killed after accept, after a tool effect, after a reply
  commit and after take; load reports the pending item, the uncertain call,
  the missed reply and the interrupted turns; one effect line at the end).
- **Manual development exercise (implementer, 2026-11-19).** Two real
  `bun run start` processes on one database, driven from a terminal with
  `--script test/fixtures/development-scenario.json` and no provider key;
  messages sent with curl to the agent's Unix socket, inspector read through
  its `/state` endpoint on `127.0.0.1`. Observed:
  1. `start --db dev.sqlite --create` printed the storage path and inspector URL.
  2. Bob on channel2 got "Hello Bob."; Alice on channel1 asked to tell Bob and
     got "Bob's channel has been notified."; channel2 answered the notice.
     Inspector: lifecycle running, execution idle, 8 timeline entries,
     channel2 participants `bob` and `channel:channel1`.
  3. Alice started a dashboard step (8 s tool). `status` showed channel1 turn 4
     running. `suspend` returned after 7 s with lifecycle suspended and turn 4
     suspended; the held chat request was answered with the suspension notice.
     Inspector: lifecycle suspended, channel1 turn suspended, 11 entries, the
     last one the dashboard tool result.
  4. SIGINT; exit code 0.
  5. `start --db dev.sqlite` (no `--resume`) printed "Session is suspended and
     paused". Before any message the inspector showed the same revision (29),
     11 entries, both channels with their messages, channel1 turn suspended,
     the shared base containing the notice text, and zero inference requests
     in this process. The page itself was served.
  6. A message to channel2 was refused ("Session is suspended; new work is not
     admitted") and the revision did not change.
  7. `resume` returned lifecycle running. channel1 finished with "One
     dashboard step is finished." after one inference; `dashboard_work` appears
     once, in the first process's log only. A new message on channel2 was
     answered.
  8. SIGINT; exit code 0. `--create` on the existing file failed with
     `already_exists`.
  Limits of this exercise: the inspector was checked through its JSON state
  and by fetching the page, not by looking at it in a browser; no run used a
  live provider; the terminal chat client and the LAN web chat were not used
  (their adapters are covered by automated tests).

## Closure and retrospective

**Accepted behavior revision: `9d9de35417ea43d79387dd272dbc1576ac766868` on
`aiagent/native-persistence`** (base `93939c3`; parents `7a355ea`, then
`291abf8`). The closure commit that records this changes only this file.

**Review outcome.** Independent reviewer gro1a-o approved every stage:

| Stage | Approved | Review rounds |
| --- | --- | --- |
| 1 contracts | `6fddbe6` | 3 (nine findings, then export/import preconditions) |
| 2 storage | `f2e7873` | 1 |
| 3 delivery and recovery | `44fd9d5` | 2 (receipt ordering, message paging) |
| 4 suspension | `5c61d7b` | 1 |
| 5 portability | `291abf8` | 3 (transfer failure paths, stalled download) |
| 6 development integration | `9d9de35` | 1 |

At Stage 6 the reviewer re-ran the gate, not the implementer's claim:
`bun run typecheck` clean; `bun test ./test` 134 pass, 0 fail, 2020 `expect()`
calls, 21 files, 31.95 s; checked against SPEC criteria 1 to 14 and both named
end-to-end scenarios.

**Verification.** All automated checks run offline with scripted models and
controlled tools, no provider key. Process-level checks use real children
(`serve --stdio --home`) killed with SIGKILL at exact commit boundaries.
`test/e2e.test.ts` runs the spec's clean relocation and crash recovery
scenarios through the public client. The manual inspector exercise is recorded
above under "Manual development exercise".

**Known limits and follow-ups.**
- The manual exercise read the inspector through its JSON state and a page
  fetch, not in a browser; no run used a live provider; the terminal chat and
  LAN web chat were exercised only by automated tests.
- Events are not durable and there is no output replay. After a crash, load is
  the recovery path for committed replies the client missed.
- A model or tool call in flight at a crash has an uncertain outcome. It is
  reported, never retried, and never reconciled automatically.
- Ctrl+C and SIGTERM on `bun run start` are stop, not suspend: running turns
  are recorded interrupted. Suspension is explicit.
- The simulated dashboard job is process state and restarts with each process.
- `session/load` returns turns and items unpaged and fails `transfer_limit`
  when they exceed one 1 MiB frame; only messages are paged. Archives are
  capped at 256 MiB.
- One local owner per session file; no PostgreSQL or multi-server scheduling.
  Archive import makes a copy, so a host relocating a session must stop the
  source before resuming the destination.
- Item signatures cover joined message text, not part boundaries. Participant
  roles and access rules remain outside persistence.
- Not in scope and unchanged: historical inspector request snapshots, advanced
  recall and compaction, policy enforcement, consumer-owned workers.

**Retrospective.**
- *What helped.* Deciding the contract first (0013) and getting it reviewed
  alone meant Stages 2 to 6 never reopened a contract question. One storage
  engine over a small row interface kept the memory and SQLite adapters
  identical, so one conformance suite found real bugs once. Tests that kill a
  real process after a named commit made the three crash windows concrete
  instead of argued. A reviewer who re-ran the gate and probed failure paths
  (late receipts, stop during suspension, a stalled download) caught defects
  tests I wrote around the happy path had missed.
- *Where work stalled or was redone.* Stage 1 took three rounds because the
  suspension and export rules were stated in prose before they were decidable;
  the finish-boundary rule changed the loop, the port and two storage methods.
  Stage 3 recorded Seen before the reply, a window the reviewer found. Stage 5
  took three rounds on error paths in the transfer file: each fix opened the
  next hole (an exact read, then a loop on an empty read), because failure
  handling was added without a test per failure. Two tests raced suspend
  against releasing a tool and failed once in six runs; repeated full-suite
  runs found it, not a single green run.
- *Next cycle.* Write the failure-path test list from the contract before
  implementing each stage, including "what ends or frees this resource when
  the operation throws". Run the full suite repeatedly before submitting any
  process-level stage. State ordering guarantees (reply before receipt, commit
  before event) as testable assertions in the decision record. Ask for the
  reviewer's reading of ambiguous contract text before building on it, as was
  done for the archive bytes.
