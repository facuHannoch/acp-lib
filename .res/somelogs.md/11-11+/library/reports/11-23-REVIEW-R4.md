# Review — R4 step 1 (cancellable ACP connection)

This review covers `fe7d28c..2f83270` on `integration-r456`: `83e6d3d` (attempt registry and cancellable connect), `2b49b7c` (session close race moved into the transport) and `2f83270` (the report). `integration-r456-reviews` was already up to date with alpha. I read `git diff` and a clean `git archive 2f83270` (`/tmp/clad2a-r4s`; `TMPDIR` on `/dev/shm`); I didn't check out the branch. Probes and mutations were run only in that archive.

**Verdict: step 1 meets the grounding brief. No blocking findings.** I tried to produce a late install and a leaked process and could not. Five notes, none blocking.

- **Typecheck clean. Full suite: 1,600 tests, 150 files.** The first full run had **one failure**, `a stalled handoff target uses its own adapter cancellation grace` (`test/operation-lifecycle.test.ts:503`, a timing test with a 30 ms grace and a `< 1000 ms` bound). It passed alone 3 times, 30 times in parallel under load on both `2f83270` and alpha `fe7d28c`, and the **second full run was 1,600 pass, 0 fail**. I count it as load flakiness, not a regression, but the test is on the handoff-cancellation path, so keep an eye on it (note 5).
- **35 snapshots pass; no snapshot file was touched** in the range, so the A1 characterization hash is unchanged.
- **No leftover `lifecycle-agent` process** after the suite from the archive.
- **Sizes** (the gate): `controller.ts` **840 → 762**, `client.ts` **1,062 → 1,046**, `agent-session.ts` **4,564 → 4,564** (untouched), `conversation-manager.ts` 1,013 (untouched). The attempt registry is a new module, `src/connection-attempt.ts` (59 lines), with the controller's startup in `src/controller-connection.ts` (118) and the client-handler resolution moved to `src/acp-client-handlers.ts`. The gate is met with room.

## Against my eight additions

| # | Item | Result |
| --- | --- | --- |
| 1 | `bringUp` auth-preserving catch bypassed on cancel | **Yes.** The catch rethrows (after `client.stop()`) for `ConnectionCancelledError` and `ProcessCrashError`, and checks `attempt.signal.throwIfAborted()` first. A genuine `session/new` failure on a connected transport still keeps the client for authentication (test `…retains the initialized client for authentication`). *Mutation:* removing the cancelled and crash branches fails the crash test, but the cancel case is **doubly guarded** (the abort check after the catch also throws), so the explicit branch is redundant for cancel; harmless |
| 2 | `onCrash` guarded by attempt identity | **Yes.** `onCrash` and `onDisconnect` both return unless `this.transport === transport`, and `stop()` now notifies disconnect itself since the guard would otherwise swallow it. The transport is assigned before `start()` so a crash during start is still handled. *Mutation:* removing the guard fails `a delayed crash callback cannot clear the replacement transport and session` |
| 3 | A late `launcher.prepare` result disposed | **Yes.** `initialize` disposes the prepared launch if the signal aborted, before and after the race, and never spawns. *Mutation:* removing the dispose fails the launcher test |
| 4 | Post-await check before every install | **Yes.** `start`, `startFresh`, `reconnect` and `setMode` all install through `installConnection`, whose first line is `attempt.signal.throwIfAborted()`. *Mutation:* removing it fails `stop from acquired progress prevents installing the late startup result`. Handoff targets go through `targetController.startFresh()` (`agent-session.ts` is unchanged), so they get the same guard, but there is **no handoff-level test of a target cancelled mid-connect**; that belongs with step 2 (Agent-close and conversation stop) |
| 5 | Second start while one is in flight | **Equivalent:** the same key returns the same promise (`controller.start()` is `toBe` the first); the second caller's `onProgress` is **not** called (note 1). **Superseding:** an incompatible key cancels the active attempt, waits for its teardown, then starts; the first caller's promise rejects with `ConnectionCancelledError`. Tested for `start` then `startFresh`. *Mutation:* removing the same-key branch fails two tests |
| 6 | Optional caller signal kept | **Not added in step 1.** The diff has no `signal` parameter on the factory or the open path, and the report doesn't mention it. It was proposed for Agent close, which is step 2; confirm it is carried there |
| 7 | Child pids reaped | **Yes**, and I asserted it myself (below). The fixture reports its pid when it receives the hung request; the suite asserts the pid is dead after `stop()`, including a SIGTERM-resistant child |
| 8 | Typed error | **Yes.** `ConnectionCancelledError extends Error`, `code = "connection_cancelled"`, in `src/errors.ts`, exported from `src/index.ts`; **not** a subclass of `ProcessCrashError` |

PTY is out of scope as stated: `bringUp` checks the abort after the PTY launch returns and stops that client, so a PTY that returns after cancellation cannot install. A PTY launch that never returns is still unreachable by `stop()`, which the report states.

## What I tried

All in a throwaway test in the archive (removed afterwards).

- **Late install / leaked process, randomized.** 60 rounds: two different operations from `start`, `startFresh`, `reconnect("nope")` and `setMode` raced against each other, then `stop()` after a random 0–60 ms delay. After each: `isConnected` and `currentSessionId` were never set (**0 late installs in 60**), and after settling there were **0 `lifecycle-agent` processes** left.
- **Never-answering fixtures** (existing hooks): the suite's own table covers `initialize` (start), `session/new` (startFresh, with a SIGTERM-resistant child) and `session/load` (reconnect), each asserting `stop()` returns, the call rejects with `ConnectionCancelledError`, the pid is dead and the controller is disconnected. `setMode` (degraded → normal, hung `session/new`) keeps the controller in the degraded mode.
- **External death during the handshake:** I SIGKILLed the child while `initialize` hung; the start rejected with **`ProcessCrashError`** (not `ConnectionCancelledError`), so crash and cancel stay distinct.
- **Delayed crash after a newer attempt:** the existing test covers it and fails without the guard (above).

## Notes (none blocking)

1. **A second equivalent `start(onProgress)` silently loses its observer.** In my probe the first caller saw `initialized` and `internal_session_acquired`; the second saw nothing. The report states that equivalent commands share the first observer, so it is by design, but callers that persist the internal session id from progress (the Agent opening path) must not be the *second* caller. Say so in a comment or merge observers.
2. **A superseding `start()` can tear down a good live connection.** With a live connection and a `startFresh()` in flight at `session/new`, a `start()` (an incompatible key) cancelled the fresh attempt, whose cleanup is `stopCurrent()`, then started a **new** process and session (probe: the session id changed, `resumed: false`). Normally `start()` on a connected controller returns the existing session. It is a corner case, but the cleanup for a `startFresh` on an existing connection stops the connection that was healthy before the attempt. Consider cancelling only the new-session request, or document it.
3. **The cancel-bypass in `bringUp`'s catch is redundant** with the abort check that follows (see item 1). Keep it; it documents intent.
4. **`stop()` now emits a disconnect notification when a transport existed** (needed because of the identity guard). Previous listeners got it from the connection abort. Worth the one-line note in the changelog that stop-time disconnect notification now comes from `stop()` itself.
5. **The handoff-grace test is timing-sensitive** (30 ms grace, `< 1000 ms`), and it failed once in 1,600 under full-suite load. It passed in 30 loaded runs on both `fe7d28c` and `2f83270`, so I don't tie it to this change. If it shows up again, look at its bound first.

**Not covered here (step 2, cod2a):** Agent close and conversation stop reaching an eager start, handoff-target cancellation cause, the caller signal, and `providerStart`.
