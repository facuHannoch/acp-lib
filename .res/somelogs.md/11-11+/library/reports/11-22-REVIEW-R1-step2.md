# Review — R1 step 2: host channel intents over the repository

This review covers implementation `56c1b3a` and report `a902ccf` on `native-integration-r` (diff
`e55afcf..a902ccf`). I read them through `git diff`/`git show` and clean `git archive` copies; I didn't check out
the branch.

**Verdict: no blocking findings.**

- The extraction is a move with one store per mode.
- Both ordering barriers are correct, and the tests really race them.
- Decisions (b) and (d) are implemented as decided.
- Rejections are propagated.
- **Step 2 doesn't slow the native suite.** On the 85 tests shared with `e55afcf`, the sum of per-test minimum
  times is 55.9 s before and 54.4 s after. The disk-backed full-run timeouts come from the machine, not this
  change.

## (1) A move with one writer

- `#enqueue`, `#flushChange`, `#applyLive` and the open-acknowledgement loop moved from `host.ts` into
  `channel-changes.ts` (`NativeChannelChanges`). `host.ts` goes from 984 to 887 lines.
- `#applyLive` is the same line for line. It now gets the client through `client()` *inside* the `try`, where
  before it called `#client()` just before it. So "not running" during a live flush now returns `{ state: "pending" }`
  through the existing `HarnessUnavailableError` branch instead of throwing. That's consistent with the documented
  "stays pending" contract, and an improvement.
- `#flushChange` is the same loop, now asynchronous.
- `enqueue` changed from `previous.then(work, work)` to `previous.then(work)`. That's equivalent, because the stored
  tail is always `next.catch(() => undefined)` and so never rejects.
- **One store per mode:**
  - With `capabilities.channels`, `NativeChannelChanges` gets the repository, and `host.records` is
    `submissionRecords(records)`. That wrapper keeps the submission methods and makes the four channel methods
    throw "use pendingChannelChanges()". A configured `harness.records`, memory or file, supplies submissions only.
  - Without the capability, `channelStore(records)` wraps the synchronous records in an asynchronous adapter, and
    `host.records` is unchanged.
- Nothing else writes channel intents. `Agent` passes `persistence.channels` only when the capability is set, and
  throws if the capability is set but no repository is provided.

## (2) Ordering barriers: correct, and really raced

- **Edit order registered before any await.** In `change()`, when running, it calls `this.enqueue(channel, …)`
  synchronously, in the same call that started the write. The queued job awaits the write and then flushes. A
  `push` made after `changeChannel` returns is therefore queued behind it.
  - *Test* "a live edit reserves its position before its durable write resolves": the repository's `desire` is held
    on a barrier, a push is issued while it's held, and then the barrier is released. The test asserts that
    `suspendChannel` reaches the harness before `push`, and that the push rejects with `channel_suspended`. Without
    the synchronous enqueue, the push would win.
- **Startup cutoff atomic against concurrent commits.** `#scan` records `#revision`, waits for all in-flight
  writes, reads, and rescans if `#revision` moved. `change()` increments `#revision` and registers its write
  synchronously, before any await. `afterOpen` calls `ready()` (connection set, submissions replayed, `running`)
  *inside* the final scan's callback, with no await between the stable read and the transition. So a change either
  lands in the batch, gets enqueued by the final scan before submissions, or sees `running` and enqueues itself.
  The deadline covers the scan.
  - *Test* "an edit committed during the post-open scan is delivered before a newer push": it holds the *second*
    `pendingChanges` read (the post-open scan) after its stale snapshot, and checks that `state === "starting"`.
    Then it commits a suspension (`pending`), pushes, and releases. It asserts that the suspension went out before
    the push, and that nothing is left pending. Without the revision check, the stale snapshot would miss the edit
    and the push would run first.
- The stale live acknowledgement case (an old RPC result doesn't clear a newer durable edit) has its own SQLite test.

## (3) The decisions

- **(b)** `fileHasPendingChannelChanges` (a `WeakMap` set only by `createFileHostRecords`) leads to a single
  `native_file_channel_changes_ignored` warning per host, logged in the constructor. The file's channel half is
  never read, and is left in the file. The limitation is added to the spec's Limitations. That's as decided.
- **(d)**
  - `src/native/errors.ts`: `HarnessUnavailableError` gets a `readonly code` with six values, each set at its
    throw site. `not_running` comes from `#client()`, and the class is re-exported from `host.ts`, so imports are
    unchanged.
  - `suspendChannel`/`resumeChannel` became `async`, so an offline call *rejects* instead of throwing
    synchronously. That's better for callers.
  - The test "stopped operator suspend and resume reject with not_running and preserve a pending retirement"
    covers both halves.
  - One minor thing: the constructor defaults the code to `"failed"` when none is given. Every throw inside the
    host passes one explicitly, so the default only affects external callers who construct the error themselves.
    Acceptable.

## (4) Rejections are propagated

`change()` returns the queued job's promise when running, and `await write` when not running. Either way a failing
`desire` rejects the caller.

- The test "a failed durable live edit rejects its caller and releases the next push" checks the rejection and that
  the queue keeps moving.
- The checkpoint test checks that the delete caller (`conversation-manager.ts:636`, `await changeChannel`)
  propagates it and leaves the conversation in place.
- Creation (L887) also `await`s, so it propagates too.

## (5) Timing: is it the machine or step 2?

**What step 2 adds to the write queue:**

- a native start now does two committed reads (`startupBatch` and the post-open scan), each through `enqueueWrite`,
  plus one `confirmChange` write per applied change;
- a live change does a write, a read and a confirm.

The reads only serialize. They don't open a transaction or fsync. Each one waits for whatever writes are already
queued, so on a slow disk a native open can pay a little extra queue latency. Nothing holds the queue across an
await: each operation is a single synchronous SQLite call inside its slot.

**The measurement.** I ran `bun test test/native` on clean archives of `e55afcf` and `a902ccf`, alternating, twice
each with the JUnit reporter, all on the same disk-backed `/tmp`. The machine was shared, with a load average of
4.5–6.9.

| | `e55afcf` (90 tests) | `a902ccf` (102 tests) |
| --- | --- | --- |
| Wall time, runs 1 / 2 | 72.6 s / 75.8 s | 73.4 s / 81.7 s |
| Sum over the 85 common tests, runs 1 / 2 | 61.7 s / 62.9 s | 57.8 s / 65.5 s |
| **Sum of per-test minimums, 85 common tests** | **55.9 s** | **54.4 s** |

The biggest differences per test, comparing minimums, are below ±250 ms in either direction. The slowdowns include
"settlement… reconcile page" at +202 ms, and the speedups include "operator stdio notify" at −245 ms. That's noise.
The 12 new tests account for the extra wall time. All 4 runs were green.

An earlier pair of plain runs (64.8/87.4 s against 113.9/97.0 s) varied more *within* a commit than *between* the
two, which also points to the machine.

**Conclusion: it's the machine.**

- The three disk-backed failures were in code step 2 doesn't touch: a managed ACP error-record seed, the harness's
  own `session/create` RPC on its own storage, and audit-runtime deadlines.
- The report notes I/O pressure during them.
- The same commit passed 1,442 in 94 s with the archive and `TMPDIR` in RAM.
- The native suite shows no regression.

For the gate, I'd accept the RAM-backed green run. The harness timing tests don't depend on fsync semantics.
Alternatively, rerun the disk-backed suite when the machine isn't shared with other agents' runs. I'd also note in
the gate file that full disk-backed runs on this machine currently land around 300 s, against 94 s in RAM.

## Not run by me

I didn't run the typecheck or the full suite. cod2a's runs stand.
