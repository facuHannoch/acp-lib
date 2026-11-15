# Report: Brief B2, turns the backend starts and the conformance suite (controller interface)

Spec: `../11-11-SPEC-controller-interface.md` (beta `5e01135`; The interface, How a turn runs after the refactor, Brief B2).
Branch `controller-interface`, on top of B1 (`61d798d`). Implementer: agentclad-1. Reviewer: agentco-1, directly after each
step; the shared log (`12-11-LOG-controller-interface.md`) has the entry for each step with its decisions and gaps.

**State: steps 5 and 6 are implemented and each review finding that was a code or test defect is fixed and passed. B2 is NOT
complete:** five contract questions are open for the spec owner (below), and the tests that depend on them (message content
delivery to a backend-scheduled controller) cannot be written until they are decided. Full conformance is therefore not
claimed. The full suite is 1,316 pass / 0 fail (two runs); the A1 snapshot is byte-identical to A2's and B1's;
`agent-session.ts` is 4,634 lines (its pre-B1 size).

## Commits

| Commit | Step | Content |
| --- | --- | --- |
| `295b0e4` | 5a | turns the backend starts: a `backend_turn` queue item, `runTurn` without messages, `turn_started` when the item runs, completion after finalization, stop/clear handling; the core-only fake controller |
| `733370d` | 5a, fix | a backend turn remembers its controller and is abandoned there if a handoff replaced it; an Agent-owned backend turn is covered (review finding) |
| `c475045` | 5a, tests | presence asserted before ordering; event barriers instead of delays (review finding) |
| `977c890` | 5b | backend-scheduled `send` (queue released at acceptance, native steering into a running turn), `turn_took`, messages settle with the turn that takes them |
| `42f9b3f` | 6 | the conformance suite (the fake and the `HarnessController`), the fake-only cases, the fake extended, `CHANGELOG-controller-interface.md` |
| `5f2dfdc` | 6, fix | a turn that replays then becomes live gets its stall deadline back: the supervisor re-reads `live` each interval (review finding) |
| `2c1952e` | 6, fix | the tool deadline is floored too: no timer storm for a replayed in-flight tool (review finding) |

## Step 5a: turns the backend starts (`src/conversation-turns/backend-turns.ts`, 215 lines)

- **Queue item:** a reported `turn_started` with `sentBySession: false` becomes a `backend_turn` item (or is abandoned at
  once if the conversation is stopped). It carries its cause, the ids of the messages it took, and **the controller that
  reported it**.
- **When it runs:** the session emits `turn_started` (with the cause), runs the turn through `runTurn` without
  `messages` (no `beforePrompt`, no user record in managed or detached mode, no ACP input to `prepareTurn`, the session's own
  recording handlers; metering, supervision and persistence as for any turn; metered as operation kind `prompt`), then emits
  `turn_completed` after finalization, or abandons the turn and emits `turn_failed`.
- **Lifecycle:** a turn whose controller was replaced while it waited (a handoff queued ahead of it) is abandoned on the
  controller that reported it and never run on the new one; stopping the conversation abandons waiting turns;
  `interrupt({ clearQueue })` keeps a started backend turn (it is not a queued message). The stop check uses `stopPromise`
  (the pump rewrites `phase` for every item).
- **Tests (`backend-turns.test.ts`, 13):** idle run (events, cause, metering once, result); no user record (detached and
  managed); waits behind a running prompt; two turns in order; failing turn (abandoned, `turn_failed`, metered once, goes
  on); stop while waiting; a report after stop; `clearQueue`; a real queued handoff replacing the controller; the Agent-owned
  mode (final assistant and metering records, no user record, completion after `afterPrompt`); two fake self-tests.

## Step 5b: backend-scheduled messages and `turn_took`

- **`send`:** for a controller with `nativeSteering`, each message is handed over as a run with its message id and kind and
  **no turn id**; the session never combines steers and never cancels to steer; the queue operation ends when `send` resolves;
  a refused message rejects its promise and the queue goes on; `message_delivered` is still emitted for a message that waited.
- **Native steering:** while a backend turn runs, a `steer` message goes to the backend at once, to be folded into that turn,
  instead of waiting behind it. A `queue` message still waits; a steer sent when idle or during another operation (a handoff)
  queues normally, so exclusive operations are not raced.
- **Settlement:** a turn carries the ids of the messages it took (its cause and `turn_took`); at the end they resolve with the
  turn's finalized result (after `turn_completed`) or reject (after `turn_failed`); an id the session never sent is logged and
  not trusted; a `turn_took` for an unknown or ended turn is logged and ignored; on stop, messages still waiting are dropped as
  cancelled.
- **Tests (`backend-scheduled.test.ts`, 13):** run shape (no turn id); operation ends at acceptance; queued steers not
  combined; settlement with the backend's own turn id; `turn_took` into a running and into a waiting turn; ignored took
  (a later valid turn as the barrier, no sleeps); failing turn rejects; an unsent id not trusted; a refused message; stop drops
  waiting messages; a queue message waits behind a running turn; session-scheduled combining unchanged.

## Step 6: the fake controller, the conformance suite, the changelog

- **The fake** (`fake-controller.ts`, core-only: no optional member): session- or backend-scheduled; `startTurn` for a turn on
  its own with output held until `prompt()`; scripts (chunks, hold, fail, signals, `ended` replay, `goLive`); `foldInto`
  (`turn_took`); an acceptance gate and a refusal; late output; options at construction.
- **Shared cases (`conformance.ts`, run by `conformance.test.ts` on the fake and on the real `HarnessController` with the
  lifecycle fixture, each in an Agent-owned conversation; 9 cases each):** a prompt (cause not missed, metering and records
  written, completion after the final assistant record, metering and `afterPrompt`); a queued prompt; withdraw; interrupt with
  `clearQueue`; interrupt of the running turn; force stop of the backend; stale detection; a turn that never reaches the
  provider (`turn_failed`, rejection, `abandonTurn` when reported); slow finalization.
- **`HarnessController` only:** a run without a turn id is an error (a synchronous throw, as since A2); a handoff's generated
  summary is an internal prompt (its own operation, metered, no turn events).
- **Fake only (`fake-only.test.ts`, 9):** the attachment barrier (a permission signalled the instant `prompt()` is called keeps a
  30 ms-stall-limit turn alive; also for a held turn; the same silence without it stalls); a replayed (not live) turn is not
  stalled, a live one is; replay → live → silent stalls and the queue is not stuck; per-turn signals/cancel and `forceStop`;
  late output after a forced stop is not recorded on the next turn; options before start.
- **Covered elsewhere, not repeated:** a backend-started turn while a prompt runs, its failure, stop and controller replacement
  while it waits, and `turn_took` (the 5a/5b files above).
- **Changelog:** `CHANGELOG-controller-interface.md`: renames and aliases, `cause`, `harnessConnection`,
  `conversationCapabilities`, the new types and `UnsupportedError`, the `connection` type, the backend-scheduled behaviour,
  and the open spec gaps.

### Source change in step 6: replayed turns and the stall check

The spec says the stall check doesn't apply while a prepared turn's `live` is false (replaying held output) and applies from the
point it is live. The supervisor did not read `live`. It now has an `isReplaying` option, **read each time a stall deadline is
reached**: while replaying there is no stall and the timer re-arms for another full interval (silence, and the oldest in-flight
tool's start, are counted from that check); once it is no longer replaying the normal deadline applies; a never-replaying
provider keeps today's exact deadline. Two review findings shaped it (a one-time sampling lost the deadline for a turn that
becomes live; the tool deadline also needed flooring). **The interface has no notification for `live` changing**, so the check is
interval-granular: a turn that becomes live is stalled no later than its limit after the change, and possibly up to one limit
earlier than the exact point. This applies only when an applicable stall limit is enabled and no permission exemption applies:
a disabled limit (`false`) or a pending permission has no deadline at all, and the replay check changes neither. Escalated below.

## Gate

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean; test files (including `test/conversation-controller/`) clean under the temporary tsconfig; `git diff --check` clean |
| full suite `bun test`, two runs on the head before this report | **1,316 pass, 0 fail; 125 files**, exit 0; 103.7 s and 105.3 s |
| focused (`test/conversation-turns`, `test/conversation-controller`, `test/operation-supervisor.test.ts`) | 226 pass per run (see the unidentified failure below) |
| A1 snapshot | byte-identical (SHA-256 `47686d4ca0451cf8…`) |
| test count | 1,257 at the end of B1 → 1,316 (+59) |
| line counts | `agent-session.ts` 4,634 → 4,634 (its pre-B1 size; limit < 5,022); `controller.ts` 840 (unchanged in B2); new `backend-turns.ts` 215, `guards.ts` 79; `supervisor.ts` 222 |
| `src/` changed since B1 | 9 files, +323/−59 |

Mutation checks were run for every step (shared log): the user record for backend turns, the clear and stop handling, the
replacement check, the native steering, the id tracking, the settled result, the abandon on failure, the replay and tool-deadline
handling, and the fake's signals each fail their targeted tests.

## Final checks (after the step reviews)

- **Full check on the head:** typecheck clean (and the temp test tsconfig); `git diff --check 09b7258 HEAD` clean; full suite x3
  (before the auto-review fixes) 1,316 pass / 0 fail each (105.9 s, 108.0 s, 105.6 s), each run's output kept; snapshot
  byte-identical to A2's.
- **Auto-review** of the whole B1+B2 source diff (`09b7258..HEAD`, the code-review skill, medium): nine findings, each checked
  against the code. Four small hardening fixes made (the supervisor's replay floor used `0` as "never skipped"; `markSent` asserted
  a possibly-gone entry; a requeued backend turn did not wake the pump; double casts in the clear handling). Two were false
  positives (an owned backend turn's `afterPrompt`, shown working by the Agent-owned test; stop settlement, which always resolves
  waiting messages). Three are by design or already recorded (a steer handed straight to the backend skips `message_pending`; a
  controller without `currentMode` is not degraded; the unbounded wait). After the fixes: focused x3 226/0 and full x2
  1,316/0, outputs kept. agentco-1 noted the hardening commit had no targeted tests; four were then added (a replay check landing
  exactly at clock zero; `settleClearedBackendTurns` requeue/abandon; a requeue waking the pump; `markSent` on a gone entry), each
  shown to fail with its fix reverted: tests 1,316 → 1,320, focused 230 pass x3 and full x2 1,320/0, outputs kept.
- **Manual end-to-end test** (offline fixtures only; no live harness): a script on the public API with the lifecycle fixture
  agent: the `AgentController` alias is the `HarnessController`; a prompt completes with `cause { kind: "messages" }`;
  `harnessConnection()`, `conversationCapabilities` and the raw ACP `capabilities` read correctly; a handoff with a generated summary
  replaces the controller through the factory and emits no turn events for the summary; a prompt after the handoff works; an
  interrupt of a running tool turn ends `cancelled` with `endedBy: interrupt`; then, with the controller swapped for the core-only
  fake, a turn the backend starts on its own (an `items` cause) runs end to end (`turn_started`, `turn_completed`, its result, metered
  once), `harnessConnection()` is `null`, raw `capabilities` throws `UnsupportedError`, and the `bridge` guard throws
  `UnsupportedError`; `stop` and `agent.close()` finish. The CLI entry loads and the public exports include `HarnessController`,
  `AgentController` and `UnsupportedError`. **Not covered by the manual test:** content delivery to a backend-scheduled controller
  (no payload contract yet), a live provider, the managed and detached modes.

## Open questions for the spec owner (each has an error file in the common errors folder)

1. **`TurnRun` carries no message content** (`errors/11-15-spec-turnrun-no-message-payload.md`): `send` hands over only ids and a
   kind, so a backend-scheduled controller cannot obtain what the user wrote; the spec says `send` pushes each message to the
   harness. Not invented. **An end-to-end content test is pending this decision, so message delivery is not claimed complete.**
2. **An accepted message the backend never takes waits until stop** (`errors/11-15-spec-accepted-message-never-taken.md`): no
   bound, against "nothing waits forever". No timer invented.
3. **`turn_took` with a mixed-kind cause** (`errors/11-15-spec-turn-took-mixed-cause.md`): one `TurnCause` cannot hold both
   messages and items; implemented as "first kind wins, ids tracked separately".
4. **A prepared turn's `live` has no change notification** (`errors/11-15-spec-live-transition-no-notification.md`): interim
   interval-granular check above.
5. **`cancelGraceMs: number | undefined`** (`errors/11-15-spec-cancelgracems-optional.md`, from B1): the code and the interface
   follow the getter, the spec text says `number`.

## Other findings recorded (not fixed)

- `errors/11-15-flaky-ignored-cancel-timing.md`: `ignored cancel is bounded…` failed once in one full run (a `< 1000 ms` bound
  got 1,692 ms); 0 failures in 25 isolated runs.
- `errors/11-15-unidentified-focused-run-failure.md`: one of three consecutive focused runs printed 225 / 1 fail and **the
  failing test was not captured** (my loop printed only counts); 25 further runs and two full runs were green. A real,
  unresolved testing limitation; the gate loops now keep each run's output.
- The managed checkpoint failure (`internalSessionActivatedAt must not be after updatedAt`) did not occur in any B2 run; it
  remains the owner-accepted limitation (todo `5baff2d`).

## Deviations and decisions

- **B2 is split into 5a, 5b and 6 steps with review after each** (the brief lists steps 5 and 6).
- **Native steering bypasses the queue only for `steer` messages and only while a backend turn runs.**
- **Backend turns are metered as operation kind `prompt`** (the spec names none).
- **`HarnessController.send` still throws synchronously** for a run without a turn id (unchanged since A2); the conformance case
  asserts that.
- **The fake stays restartable after `forceStop`** (a core-only controller has no `reconnect` to bring it back).
- **A turn's held output on controller replacement** is released when its queue item runs (right after the handoff), not at the
  instant of replacement.
- **The Agent-owned mode is the one the conformance suite runs in** (as the brief says); managed and detached are covered for
  backend turns by the 5a tests only.

## Limits

- The conformance suite does not cover usage content per backend (the fake reports none) or the managed and detached modes.
- No real second backend exists, so every backend-scheduled path runs on the fake.
- Late output after a forced stop is observed through the next turn's result and records, not at the handler level.
- Content delivery, the unbounded wait, the mixed cause and the exact `live` transition are decisions, not tests, until the spec
  owner answers (above).
