# Review — orchestrator brief O5a (stop, drop, idle stop)

This review covers `fc6a922..c092af6` on `orchestrator`:

- `71b63d8`: the O4 follow-up, reviewed separately;
- `a6ec0af`: step 1, stop and drop, with deleted or missing conversations tombstoned;
- `731f939`: step 2, idle stop;
- `c092af6`: the report.

I read them through `git diff`/`git show` and a clean `git archive c092af6` (`/tmp/clad2a-o5a`); I didn't check out the
branch. I wrote my own probes (`test/zz-probe/o5a*.test.ts` in that archive).

**Verdict: O5a meets its brief. No blocking findings.**

- **Full suite on the archive:** typecheck clean, **1,546 pass, 0 fail, 143 files**, 35 snapshots; the characterization
  hash is still `fbc6ec2c…`.
- **I tried to break each race you named.** None produced an error, a leaked timer, a stray event or a stuck worker
  (table below).
- Three small notes, one of them a missing changelog entry.

## Against the brief

### `stop`

Unchanged from O2 and still correct: `interrupt({ clearQueue: true })`, allowed for the giver or with redirect authority,
refused otherwise, and it waits for all tracked prompt completions. The tests cover a same-giver stop, a refusal for
another giver, and a stop through the consumer API.

### `drop`

- **It goes through the manager with provider cleanup.** `conversations.delete(id, { providerSession: "best-effort" })`, then
  the row is marked dropped and the slot released. `agent.workers.delete` now returns the manager's
  `DeleteConversationResult`, so provider cleanup is reported and never promised.
- **My probe of the outcomes:**

  | Adapter | `providerDeleted` |
  | --- | --- |
  | the lifecycle fixture (supports `session/delete`) | `true` |
  | the echo fixture (no delete) | `"unsupported"` |

  In both cases the worker and conversation are gone locally.
- **`worker_dropped` is emitted exactly once per worker.** `markDropped` emits only when the repository's `drop` actually changed
  the row, and the emit runs in a `finally`, so even a failing release still reports it.

### A directly deleted conversation is tombstoned (my O1 note 2: closed)

`requireWorker` and `summaries` now reconcile: a missing or deleted conversation marks the row dropped, releases any cached slot,
and emits one `worker_dropped`. `send` no longer needs its own pre-check, and `open` reconciles before it counts a quota. **My probe**
(limit 2, three workers, `w1` evicted):

- `w1`'s conversation deleted directly, then `send` to it: it fails with "worker conversation is unavailable" and `w1` is
  tombstoned, **with `w2` and `w3` left live and idle** (nothing evicted);
- `w3` (live) deleted directly, then `check`: the same, and `list` now shows only `w2`;
- exactly one `worker_dropped` per zombie.

### Idle stop

- **Config.** `workers.idleStopMs` defaults to 600,000 ms, `false` turns it off, and it's validated at `Agent.open`: an integer
  from 0 to 2,147,483,647, or `false`.
- **The timer is armed only when the worker is really idle**: after the last tracked prompt settles, with no work, no pending
  completion and the conversation idle. `unref`'d, so it never keeps the process alive.
- **It's cancellable, and its callback is serialized and re-checked.** It runs inside the pool's single queue. When it runs
  it re-checks that this timer is still the slot's current one, that the pool is open, that the slot is still the one
  attached, and that it isn't busy. `send`, eviction, `drop` and `Agent` close all cancel it. `worker_stopped` carries
  reason `idle`, and the next send reloads the same conversation.

## The races you named

| What I tried | Result |
| --- | --- |
| **Idle reliability:** 12 cycles of idle stop then a reloading send, `idleStopMs: 120` | 12 of 12 stopped, 12 reloads, 0 send errors |
| **A send racing the timer:** `idleStopMs: 30`, sends at random 12–50 ms gaps for 3 s (13 sends) | all succeeded (12 `sent`, 1 `steered`), 0 `worker_failed`, 10 idle stops, 14 replies, no warnings |
| **A worker that just became busy:** a long job sent about 50 ms before a 250 ms timer would fire | the worker stayed `busy`, 0 idle stops while busy; after release: `worker_idle`, then one `worker_stopped:idle` |
| **Drop during the timer** | `deleted (provider: true)`, no stray `worker_stopped:idle` afterwards |
| **The timer after a drop** | nothing fired in the following 500 ms |
| **Two drops** (sequential and concurrent) | one succeeds, the other fails with "unknown active worker"; one `worker_dropped` |
| **Drop of an offline (evicted) worker** | succeeds with provider cleanup reported, and the other worker stays idle and live |
| **Stop racing a finishing turn:** 25 stops at delays 0–72 ms around completion | no errors, final state `idle`, one `worker_stopped:requested` (only when it really interrupted), 0 failures |
| **Timers after `Agent` close** | `idleStopMs: 150`, `close()` straight away: 0 events and 0 warnings in the next 600 ms |

I also checked why `isBusy` can safely gate the idle event: `settleIdleIfDrained` settles the conversation's public state in the
same synchronous run that resolves the last prompt, so the completion callback sees it idle (a code comment says so). My
12-cycle test confirms it isn't racy in practice.

## Boundaries

`agent-session.ts` is untouched (4,564 lines), as are `src/native`, `src/persistence` and the manager. `orchestrator/` makes no
call to `stage`, `transitionDelivery`, `reserve` or a flush. The largest orchestrator file is `orchestrator.ts` at 251 lines,
and `pool.ts` is 123.

## Notes (none blocking)

1. **No changelog entry for O5a.** Three public changes: `agent.workers.delete` now returns a `DeleteConversationResult`
   (it was `Promise<void>`), `workers.idleStopMs` is new, and `worker_stopped` can carry the reason `idle`. Add a line before
   release.
2. **`drop` of a zombie errors the first time.** If a worker's conversation was deleted directly and `drop` is the first call to
   notice, it tombstones the row but then throws "worker conversation is unavailable" (a second `drop` says "unknown active
   worker"). A drop is a cleanup, so it would be friendlier if it succeeded. The worker is gone either way.
3. **`worker_stopped: requested` can be reported for a turn that finished on its own.** A stop that sees the worker busy and then
   waits for the interrupt reports `requested` even if the turn completed first. Harmless, and the O5a spec asks only for the
   reason.
- **Baseline:** 1,546 tests, up from 1,540.
