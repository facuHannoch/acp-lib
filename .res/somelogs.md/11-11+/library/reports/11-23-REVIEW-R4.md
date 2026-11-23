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

# Part 2 — step 2 (shutdown), step 3 (`providerStart`) and the whole of R4

This part covers `2f83270..ec298c5` on `integration-r456`: `0c4d12e` (handoff targets, reconnect, Agent close), `504eaf1` (`providerStart`, `deferred`), the alpha merge `d6c3fa9` (alpha `3d96dbd`) and the gate reports. I used a clean `git archive ec298c5` (`/tmp/clad2a-r4f`, `TMPDIR` on `/dev/shm`) and didn't check out the branch. My probes were throwaway tests in that archive.

**Verdict: R4 meets its Done criteria. No blocking findings.** Three notes, none blocking.

- **Typecheck clean. Full suite: 1,614 tests, 151 files, 0 fail**, 35 snapshots; no snapshot file changed in `fe7d28c..ec298c5`, so the A1 hash is unchanged. No `lifecycle-agent` process left afterwards.
- **Size gate**, measured on the archive: `agent-session.ts` **4,564 → 4,495**, `client.ts` **1,062 → 1,046**, `controller.ts` **840 → 764**, `conversation-manager.ts` **1,013 → 1,012**. One correction to the brief: the manager's baseline at `fe7d28c` is **1,013**, not 1,081, so the gate is met by one line, not 69. The session shrank by moving its config types to `src/agent-session-config.ts` (133 lines) and the adoption record write to `src/agent/adoption/provider-attachment.ts`.
- The orchestrator and persistence changes in the range come from the alpha merge (delivery retry); I didn't re-review them here.

## Step 2: shutdown

| Check | Result |
| --- | --- |
| **Optional caller signal** (my item 6) | **Present.** `signal` is an owner-controlled runtime key (`config.ts`), and `withStartupCancellation(signal, stop, start)` wraps the three startup entry points (create, open, restore). A signal that fires before or during the start stops the session and rejects with `ConnectionCancelledError`, and a result that arrives after the abort is discarded |
| **Agent close reaches an eager start** (the ordering gap) | **Closed.** `Agent.close()` calls `manager.cancelStarts()` first; `stopAll` then cancels, stops live conversations and awaits **creations, openings and stops together**. Creation is now tracked in a `creating` set (it was in neither map before). *Mutation:* removing `cancelStarts` fails `Agent close cancels eager Provider create…` and `…reopen…` |
| **Handoff targets** | The session keeps the candidate controller in `handoffTarget` for the life of the operation and `stop()` stops it with the main controller. A cancelled handoff with spent work keeps its metering records and carries the typed cancellation as the cause; with none it rejects directly. *Mutation:* not stopping the target fails both `conversation stop cancels the same-adapter / cross-adapter handoff candidate` tests |
| **Reconnect and queued work** | A stop during a reconnect gives `ConnectionCancelledError` (it was a plain `Error`), with no fresh fallback and no provider failure record; queued prompts and settings settle with the typed error only when the stop interrupted readiness, and ordinary queue clears keep their results |
| **Typed errors escape the recovery paths** | `create`, adoption load, `open` and the recovery path rethrow `ConnectionCancelledError` before `throwCreateFailure`/`loadFailure`/`recoverAfterLoadFailure`, so a cancel is not recorded as a provider failure |

## Step 3: `providerStart`

| Check | Result |
| --- | --- |
| **Create and reopen with `on_first_use` start nothing** | **Yes.** My probe: `create`, `list`, `get`, `stop`, a reopen and a `delete` of a never-started conversation produced **0 provider processes and 0 wire calls**; the reopen returned `deferred` |
| **The first operation starts; concurrent first uses share one start** | **Yes.** Probe: two prompts (one queued), a `setConfig` and a third prompt issued together: all four fulfilled, **one `initialize` and one `session/new`**. A settings write alone also starts it (their test) |
| **Stop during first use** | **Yes.** I hung `initialize` and `session/new` and called `conversation.stop()` and, separately, `Agent.close()` during the first prompt: the prompt rejected with `ConnectionCancelledError`, the child was **dead** in all four cases, and the phase was `stopped` |
| **Agent close during eager create or reopen** | The create rejects with `ConnectionCancelledError`, the child is dead (hung `initialize` and hung `session/new`), and a later `create` is refused |
| **Leaks and late installs, randomized** | 40 rounds of `Agent.close()` at a random 0–120 ms delay against `create` and `create`+`prompt`, alternating lazy and eager: **0 leftover processes** |
| **Missing provider session on first use: a recorded reload, not a silent fresh session** | **Yes.** With the provider reporting every session missing, the eager open and the first use on a deferred open behave the same: `ProviderSessionError`, no `session/new` call, no session-id change, and the same error record in the transcript. With checkpointing on, their recovery test now runs both ways: on first use the same progress stages (`load_failed … seeding … completed`) appear, a second provider session row is written with the recovery checkpoint id, and the `conversation_recovery` action is recorded |
| **Managed path unchanged** | `deferProviderStart` takes effect only for an Agent-owned session with `persistence: false`, a normal-mode ACP adapter and `deferProviderStart` set by the manager; standalone and session-manager startup never receives it, adoption (`!summary.adopted`) stays eager, native channels and degraded mode ignore the option (their native test: 0 launches). `providerStart` is validated at `Agent.open` and for the per-conversation runtime (a bad value throws `TypeError`; I saw no conversation row or process created) |
| **`deferred` is a public type addition** | Added to `OpenOwnedAgentConversationResult.providerSession`; `ProviderStart` exported from `index.ts` and `agent.ts`. The changelog entry is in `CHANGELOG-controller-interface.md` (lines 5–11: `ConnectionCancelledError`, the signal, `providerStart`, `deferred`). I found **no exhaustive switch** over `providerSession` in `src` or `test`; the remaining `loaded`/`new`/`recovered` assertions are for eager callers |
| **Handle behaviour before first use** | `connection.isConnected` is false, config and command views are empty, `model` is null, `capabilities` throws `NotConnectedError`; a recorded internal session id stays visible |
| **Mutation** | Making `defersProvider` always false fails six tests (`provider-start` ×5 and `stop reaches deferred first use while initialize is pending`) |

## Notes (none blocking)

1. **Lazy conversations lose the connection-kept-for-authentication behaviour.** `requireStartupSession` makes a failed `session/new` stop the client and throw, so a conversation that opens lazily against a provider that needs login can only fail its first prompt; it never holds a connected client waiting for `authenticate`. The flag is set from the construction-time value, so for these conversations it appears to stay on after the first use too (read from the code, not probed): later restarts of a lazy conversation would not keep an unauthenticated connection either. Say so in the changelog, or clear the flag with `deferredProviderStart`.
2. **The result of a first-use recovery is not in the open result.** `open` has already returned `deferred`, so the recovery outcome (`recovery`, the checkpoint id) is visible only through the `onRecoveryProgress`-style progress, the `provider_reconnected` event and the stored records. That follows from the design; mention it in the changelog.
3. **My fe7d28c manager size was misquoted in the brief** (see above); the gate itself is met.

**Whole of R4, against my eight additions and the grounding report:** every item holds (step 1 table above, with the shutdown items from step 2). The Agent-close ordering gap is closed and mutation-checked; the PTY start remains out of scope as stated.

# Part 3 — the first-use recovery test is timing-dependent (core-p's gate failure)

core-p's gate failed `test/checkpointing/recovery.test.ts` > "creates and seeds a new provider session when the recorded one is missing (first use)" at line 140. **My review missed it**: my full run passed, and I had run the new tests once, not repeatedly. I reproduced it in the same clean archive of `ec298c5` (`TMPDIR` on `/dev/shm`).

**Reproduction.**

| Runs | Failures |
| --- | --- |
| The whole file, 20 isolated runs | **2 of 20**, both the first-use test |
| The eager variant (`-t "on open"`), 20 isolated runs | **0 of 20** |
| The first-use variant (`-t "first use"`), 20 isolated runs | **7 of 20** |

**Cause: (a), a test race, not a recovery bug.** I instrumented the test (in the archive only) to print the checkpoint it expected and the one recovery used. On the failing runs:

- the test's `checkpoint` is the one it read early, `covered: 4`;
- the one recovery used is the **newest** checkpoint, `covered: 9`, which equals the conversation's `latestSequence`, and it was also the latest checkpoint at the end of the run.

The test calls `checkpointing.request()` just before closing the first agent, so a newer checkpoint is queued across shutdown, and the reopened agent builds it from the transcript while it starts up. **Eager open** recovers at once, usually before that checkpoint lands, so it picks the older one and the assertion `recoveryCheckpointId == checkpoint.checkpointId` holds. **First-use** recovery runs later, after the open and the first prompt are issued, so it often finds the newer checkpoint and uses it. Recovery picking "the latest checkpoint at the time of recovery" is the same rule in both modes, and the newer checkpoint (covering the whole transcript) is a valid, arguably better, choice. The data are consistent: two provider-session rows, the recovery action recorded, and a checkpoint that covers every record.

**Fix for the test (cod2a):** for the first-use variant, don't compare with the early checkpoint's id. Assert that the recovery checkpoint id is one of the stored checkpoints and that its `coveredSequence` is at least the early one's; or wait for the queued checkpoint to complete before closing the first agent (so there is only one candidate); or drop the `request()` for that variant. The eager variant needs no change. Also consider asserting `recoveredThroughSequence` for the first-use variant, which it currently skips.

**Process lesson (mine):** run each *new* test of a commit about 20 times in isolation, and the touched test files repeatedly, as well as the full suite. A test that depends on a background task racing the code under test passes on a quiet full run and fails under other timing. I'll do this from now on.

# Part 4 — the R4 follow-up (`ec298c5..cb6f959`)

`491cf66` (code and tests) and `cb6f959` (report). I used a clean `git archive cb6f959` (`/tmp/clad2a-r4g`, `TMPDIR` on `/dev/shm`) and didn't check out the branch.

**Verdict: every note is addressed and the changed tests are stable in isolation. One new finding: a test from step 1 now fails occasionally when its whole file runs, which was not the case before this follow-up.**

## My notes

| Note | Result |
| --- | --- |
| **A second equivalent start loses its observer** | **Fixed.** `ConnectionAttempt` now keeps the progress it has reported and a set of observers; a joining caller gets the earlier stages replayed, then the rest live. A throwing observer is caught and logged per observer. Test `an equivalent start replays prior progress…`: the joiner is attached from inside the first caller's `initialized` event and sees exactly the same two stages (`initialized`, `internal_session_acquired`), and `second` is the same promise as `first`. An observer joining a cancelled attempt gets nothing further |
| **A superseding start tears down a healthy live connection** | **Documented as intentional**, with a regression: `superseding a fresh session on the live transport stops it before reconnecting` (hung `session/new` on a live connection, then `start()`): the old child is dead, there were exactly two launches, the replacement loads the **original recorded session** (`resumed: true`) and the conversation prompts. This is in the test and the report, but **not in the changelog**, which only says a superseding attempt rejects with `ConnectionCancelledError`; add a line there |
| **Lazy conversations and authentication** | **Documented.** The changelog now says a failed session creation on first use closes the connection and reports the provider error, and to use eager startup when the connection must stay available for authentication. (I had also asked whether the flag stays on after first use; the report doesn't say. The documented behaviour is the safe reading.) |
| **First-use recovery outcome only visible later** | **Documented** in the changelog (recovery progress, `provider_reconnected`, persisted records) and **tested**: the first-use variant now subscribes before the prompt and asserts one `provider_reconnected` with `via: "recovered"` |
| **Handoff-grace test margins** | **Widened.** Source grace 2,000 → **8,000 ms**, target grace stays 30 ms, bound `< 1000` → **`< 4000` ms** on `performance.now()`, test timeout 15 s. It still discriminates: a target that wrongly used the source's grace would take ≥ 8 s |
| **Recovery test race (core-p's gate)** | **Fixed in the test only.** The first-use variant now takes the checkpoint id from the recovery's own `completed` progress event and checks the stored checkpoint belongs to the conversation, covers at least the early checkpoint's sequence, and that the provider attachment records `previousInternalSessionId` and `recoveredThroughSequence` equal to the latest sequence. The eager variant keeps its exact assertion. No source change |
| Changelog line | Present (`CHANGELOG-controller-interface.md`) |

## Every new or changed test, 20 isolated runs each

| Test (file) | Failures |
| --- | --- |
| `recovery.test.ts` > "… (first use)" (`-t`) | **0 / 20** |
| `recovery.test.ts` > "… (on open)" (`-t`) | **0 / 20** |
| `recovery.test.ts`, the whole file | **0 / 20** |
| `acp-connect-cancellation.test.ts` > "an equivalent start replays…" | **0 / 20** |
| `acp-connect-cancellation.test.ts` > "superseding a fresh session…" | **0 / 20** |
| `operation-lifecycle.test.ts` > "a stalled handoff target…" | **0 / 20** |

## New finding: a step 1 test is flaky in a whole-file run

I also ran the whole `acp-connect-cancellation.test.ts` file 20 times: **1 failure in 20** (`stop cancels ACP setMode and reaps its process`), then **2 in 30** on a second batch. The failure is the same each time (test line 47): `await rejected` is `undefined` where a `ConnectionCancelledError` is expected, after about 1.7 s.

| Version, same method | Whole-file failures |
| --- | --- |
| `2f83270` (step 1) | **0 / 30** |
| `ec298c5` (steps 2–3) | **0 / 30** |
| `cb6f959` (this follow-up) | **3 / 50** |

The `setMode` test alone passed 40 / 40 on `cb6f959` and on `2f83270`. With the rejection printed and the `-t "stop cancels ACP"` cases run in six parallel loops (72 runs) I could not reproduce it, so the trigger seems to depend on the earlier tests in the file. The only source files changed between `ec298c5` and `cb6f959` are `connection-attempt.ts`, `controller-connection.ts` and `controller.ts` (the observer and progress change), so I suspect that change: `setMode` now routes through the same attempt with its `ConnectionAttempt<ControllerStartEvent>`, and a stop that arrives at the right moment settles the promise with `undefined` instead of rejecting. I did not find the exact cause. **Ask cod2a to look at it** before the gate counts it as green; `controller.setMode`'s settle path under `stop()` is where I would start. It is the kind of flake a single clean full run hides (core-p's 1,616 run was green).

# Part 5 — the setMode flake fix (`cb6f959..c2ba881`)

`d752262` (code and one test) and `c2ba881` (report). I used a clean `git archive c2ba881` (`/tmp/clad2a-r4h`, `TMPDIR` on `/dev/shm`).

**Verdict: the fix is correct and holds. Reproduced 0 failures in 50 whole-file runs and 20/20 in isolation for every test in the file. One caveat on the diagnosis: I could not see the "undefined reason" happen, so the cause of the original flake is still not demonstrated, though the fix removes the dependence on it.**

## The reproduction

| Run | Result |
| --- | --- |
| `test/acp-connect-cancellation.test.ts`, whole file, **50 runs** | **0 / 50** failed (it was 3 / 50 on `cb6f959`) |
| Each of the file's 21 tests, 20 isolated runs each (`-t`, each confirmed to match one test) | **0 / 20 for all 21** |

## The diagnosis against the code

The change adds a `cancellation` field to `ConnectionAttempt`: `cancel()` stores one `ConnectionCancelledError` and aborts the signal with it, and every guard that used `signal.throwIfAborted()` now calls `throwIfCancelled()`, which throws the stored error. `ConnectionAttempts.run` also wraps the attempt's result: on success **and on any rejection** it first calls `throwIfCancelled()`, so a cancelled attempt's public outcome is always the stored typed error, whatever the leaf rejected with.

- **Does the fix keep the typed error for every path?** Yes: `start`, `startFresh`, `reconnect` and `setMode` (and with them the handoff targets, which call `startFresh`) all go through `connections.run`, so the settlement conversion applies to all of them, and `AcpClient.connect` goes through its own `ConnectionAttempts` and gets the same wrapper. The remaining `signal.throwIfAborted()` calls in `client.ts` (lines 313–396) sit inside that wrapped scope.
- **Mutation:** removing the rejection-side conversion fails the new test `a cancelled attempt rejects with its own error when the leaf rejects without one`. The test uses a leaf that rejects with `undefined` and checks the outcome is `ConnectionCancelledError`.
- **Is the reason really lost?** I could not show it. In Bun 1.3.14, `abort(new ConnectionCancelledError())` followed by `signal.throwIfAborted()` throws the same typed error (probe), and 84 random-delay stops (below) never produced an `undefined`. The report says the outer signal's reason and `throwIfAborted`'s value were `undefined` in the failing runs; that may be a Bun timing behaviour I can't trigger, or the leaf may have rejected with `undefined` some other way. The fix doesn't need the answer, but the new test only covers a *synthetic* leaf that rejects with `undefined`, not the original cause. If it reappears elsewhere, that is the thing to chase.

## Trying to defeat it

A throwaway test in the archive: 12 rounds over seven paths (`start`, `startFresh`, `reconnect`, `setMode` from degraded, and `start`/`start`/`reconnect` against a fixture that never answers `initialize`, `session/new` and `session/load`), each with `stop()` at a random 0–90 ms delay. **84 of 84 rejected, every one with `ConnectionCancelledError` (none `undefined` or another error), none resolved late, no controller connected after its rejection, and 0 leftover child processes.**

## The changelog line

Present in `CHANGELOG-controller-interface.md`: "Superseding a fresh-session start on an existing ACP connection intentionally closes that connection before starting its replacement. The cancelled session creation cannot finish on the old connection." That closes my earlier note.
