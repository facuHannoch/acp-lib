# Review — R6 step 1 (confirmed native input withdrawal)

This covers `a9b3ae1..81574bc` on `integration-r456`: `e7d90e6` (the R5 doc nits), `069efba` and `b13417c` (the amended brief and haurness-l's wire rules), `5602999` (the extraction), `592a2c1` (runtime, tests, docs) and `81574bc` (the report). `integration-r456-reviews` was already up to date with alpha. I read `git diff` and clean `git archive` copies (`/tmp/clad2a-r6a` for `81574bc`, `/tmp/sz-5602999` for the extraction); I didn't check out the branch. Probes and mutations ran only in the archives.

**Verdict: the withdrawal protocol is correct and well tested. One decision I disagree with (what stop and close do to submitted input), one behaviour change to state, and one mutation the tests miss. No blocking defects in the withdrawal path itself.**

- **Typecheck clean. Full suite: 1,659 pass, 0 fail, 156 files**, 35 snapshots (none changed; A1 unchanged); harness suites 367 pass; no leftover process.
- **Each of the ten new tests: 20 / 20 in isolation** (each `-t` matched one test), `withdrawal.test.ts` whole-file 20 / 20, `host.test.ts` whole-file 10 / 10.
- **Sizes:** `agent-session.ts` **4,489** (≤ 4,492), `native/host.ts` **908** (≤ 909), `native/controller.ts` 599, `client.ts` 1,046, `controller.ts` 764, `conversation-manager.ts` 1,012, `agent.ts` 563, `engine.ts` 1,034. New: `submission-withdrawal.ts` 63, `clear-operations.ts` 27; `backend-turns.ts` 326.

## (1) The extraction is a move and is its own commit

`5602999` touches two files: it replaces a 15-line block of `agent-session.ts` (the cleared-prompt drop and the per-kind rejection labels) with a call to `dropClearedOperations` in the new `clear-operations.ts`. I compared the two bodies: same order (prompts and backend items dropped first, then each non-prompt operation rejected with the same labels and the same `cancellation ?? new Error(...)`), the only difference being that the backend list is computed one expression earlier, with no effect. `agent-session.ts` goes 4,492 → 4,479 in that commit, and the **suite on that commit alone is 1,649 pass, 0 fail, 155 files**, exactly the baseline: no behaviour change and no new tests.

## (2) The withdrawal protocol

| Requirement | Result |
| --- | --- |
| Uses `channel/withdraw` with the **original channel and item id** | Yes; the controlled-client tests assert the exact `{ channel, item }` params on every request, including the retry |
| **`withdrawn` is the only confirmation of cancellation** | Yes: `withdrawAsync` is `true` only for outcome `withdrawn` (or an `item_withdrawn` event, or a reconciled `withdrawn` milestone), which then settles the prompt once with one `message_withdrawn`. *Mutation:* counting `taken` as withdrawn fails two tests |
| **`taken` follows the turn** | Yes: `false`, the submission is marked accepted, the prompt stays with its turn. My probes: a withdraw after the turn had started returned `false` and the prompt completed; 15 rounds where the take won the race (release first, then a withdraw after 0–25 ms) all returned `false` with the prompt following its turn and none cancelled |
| **`not_found` is unresolved** | Yes: after `not_found` the host waits for the push's acceptance (bounded by the request timeout) or does one reconcile read; if the item is found it withdraws again, if not it rethrows, and the async call rejects with the prompt untouched. *Mutation:* treating `not_found` as withdrawn fails a test. The withdrawal intent stays, so a late acceptance triggers the retry |
| **No extra model call** | With the original turn finished, two concurrent withdraws returned `true, true` (a repeat is idempotent), a third `false`, **one** `message_withdrawn`, and the withdrawn input made **no model call** on the channel |
| **Dispatch fence** | `beginInput` claims the local boundary; a withdrawal before the push is written settles locally and the continuation skips the input. *Mutation:* removing the fence fails four tests |

## (3) Intent persistence and the SQLite limitation

A `withdrawing` flag is written to the host's submission record (`markWithdrawing`) before the request. The push is suppressed in both places it could be replayed (`#submit` and `#replaySubmissions`; *mutations:* removing either fails the file-backed reopen test; not recording the intent fails two tests). The flag survives a harness reconnect with the memory store and an Agent reopen with the file store (test).

**What happens for a SQLite-backed Agent:** the default submission store is **memory even with SQLite persistence**, so after an Agent close nothing is left to replay or withdraw: the input stays accepted in the harness and runs. The report, the changelog and the consumer guide say this. The guide is explicit ("Default submission records are in memory even with SQLite persistence. Configure file-backed host records…"); the changelog line says only that "the built-in file store retains the intent", so add "the default store is in memory" there. A custom store without `markWithdrawing` makes `withdrawAsync` of a submitted input **throw** ("cannot record a withdrawal intent"), which is the honest failure.

## (4) The ambiguity test

It uses a controlled client with barriers (`intercept.push` / `intercept.withdrawItem`), not the stock server, and asserts only what haurness-l's rules guarantee: `not_found` for a not-yet-committed item, the late acceptance, exactly one push and two withdraw requests. The docs state it as an assumption ("Push and withdraw can be dispatched concurrently. A `not_found` reply can leave the withdrawal unresolved") and `b13417c` records haurness-l's confirmation (no per-channel ordering, no tombstones, withdrawal atomic against take for a committed item). No claim of reproducing overtaking on the stock server.

## (5) Interrupt, stop and close

- **`interrupt({ clearQueue })` keeps submitted work and clears local input**, as designed: the queued steer completed with the harness's reply ("Kept.").
- **Stop and close reject the handles they stop observing and leave accepted input with the harness.** I do not think "leave it" is right, and I measured why. With an accepted, unclaimed steered input and the conversation stopped (the handle rejects), I released the held tool and waited: **the harness ran the left-behind input in a new turn** (a second model call on turn 2, the item reached `seen`) with nothing observing it. The consumer was told the input stopped, and the harness spent on it anyway: the same hazard R6 exists to remove, now for stop and close instead of withdraw. Recommend a best-effort `channel/withdraw` for the conversation's submitted, unclaimed items on stop and close (withdrawal is atomic against take, so it can only win or lose cleanly), then reject; failing that, document the spend prominently where the stop is described, not only in the withdrawal section.
- **The handle now rejects with a plain `Error`** ("the conversation stopped observing this native input"); before, stop settled these prompts as cancelled results. That is a behaviour change for native consumers and an untyped one. Use a typed error (or reuse the cancellation result) and put it in the changelog as a change.
- A close with a withdraw already in flight resolved `true` in my probe (the withdraw won before the close); no crash or hang.

## (6) The stall-clock regression

`native supervision leaves a turn pending past the client stall limits during reopen` passes 20 / 20 and holds a replacement launch beyond tiny configured limits, then checks one reconciled settlement, as the amended brief asked; the existing host test covers reopen exhaustion.

## (7) Public surface

`PromptHandle.withdrawAsync()` and `AgentSession.withdrawAsync(id)` are new (a required member of `PromptHandle`, so any consumer type that implements the handle needs it). `TurnEvent`, which is **exported publicly**, gains `{ kind: "input_withdrawn" }`; the changelog says so. No exhaustive switch in the repo breaks (the one in `stdio-client.ts` is over harness event types). The synchronous `withdraw()` for native now cancels only unsubmitted input; for a submitted one it returns `false` where it used to cancel locally and leave the harness running it (that was the defect), which is the intended change and is documented in the guide.

## Mutations (each reverted; the three native test files, 63 tests)

| Mutation | Result |
| --- | --- |
| `taken` counted as withdrawn | fails (2) |
| `not_found` treated as withdrawn | fails |
| intent not recorded | fails (2) |
| push replay not suppressed, in `#submit` / in `#replaySubmissions` | fails (1 each) |
| dispatch fence removed | fails (4) |
| withdrawn event doesn't settle the submission | fails (2) |
| stop doesn't reject native handles | fails (2) |
| **interrupt clears submitted native inputs** (the old rule) | **passes: a test gap.** The interrupt test passes with either rule because the turn takes the steered input first; add a case where the input is still unclaimed when `clearQueue` runs |

## Notes

1. The stop and close decision above; the untyped rejection; the changelog line about the default store.
2. After `taken`, the record keeps `withdrawing: true` until its turn ends; each reopen sends one more (no-op) withdraw for it. Harmless, but clear the flag when the host learns it was taken.
3. The file-backed store is opt-in; consider making durable records the default when persistence is SQLite.
