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

# Part 2 — the shutdown re-check (`81574bc..dde1ab6`)

`212e462` (code) and `dde1ab6` (report). Clean archive of `dde1ab6`: typecheck clean, **1,664 pass, 0 fail, 156 files** (the report's number). All nine new or strengthened tests **20 / 20** in isolation, `withdrawal.test.ts` whole-file 20 / 20, `host.test.ts` 10 / 10.

**Verdict: the shutdown now withdraws before it detaches and the measurement that failed before is clean. One behaviour change is broader than the changelog says (below, important).**

My measurement, re-run over a real stdio harness (an accepted, unclaimed steered input while a tool is held):

| Probe | Result |
| --- | --- |
| **Stop** | took 19 ms; the handle rejected with `NativeInputStoppedError` carrying the right `messageId`; the model ledger stayed at **one call** after the held tool was released and 1.5 s passed; the left-behind item reads **`withdrawn`**. **No extra turn** (before: a second, unobserved turn) |
| **Close** (then reopen and read the ledger) | the same: one call, item `withdrawn`, typed rejection |
| **Stop racing a withdraw** (10 rounds, 0–20 ms random delay) | never hung, never an extra turn, at most one `message_withdrawn`; every handle ended `cancelled` (the withdraw won, so the stop had nothing to reject) |
| **Close with a pending (delayed 300 ms) withdraw** | close took 324 ms, the withdraw resolved `true`, the handle rejected typed |
| **A host that never answers, six unclaimed items** | stop took **1,015 ms** (one shared grace, not six), all six handles rejected typed; the tests also cover a down host and a take winning |
| **`taken`** | spend can still happen; the changelog and the guide both say "Inputs can still incur spend if take has won or the host is unavailable or silent" where stop and close are described |

Also confirmed: `NativeInputStoppedError` is a value export from `index.ts`; the changelog names it as replacing the cancelled result; the default submission store being memory is now in the changelog; the `taken` flag clears (`markAccepted(id, true)`), which closes my earlier note. **The ninth mutation (interrupt clearing submitted inputs) now fails** `native interrupt retains an accepted input that has not been taken`.

**Important: the typed rejection is not limited to unclaimed inputs.** `stop` rejects **every** tracked native handle, including a prompt whose turn is already running. I compared with the commit before R6 (`a9b3ae1`) using the same probe (a stop while a turn streams): then `prompt()` **resolved** `{ status: "cancelled" }` with its partial text; now it **rejects** with `NativeInputStoppedError` and the partial text is not available to the caller (the persisted records are identical in both, the partial reply marked failed). The changelog sentence ("Tracked native handles reject … instead of returning a cancelled result") reads as being about the withdrawn inputs. For the common case of stopping a conversation mid-turn this is a visible API change. Reject only the handles whose input was never taken, and keep the cancelled result for a prompt whose turn is running; or, if the rejection is intended for all, say so in the changelog and the guide as a breaking change.

Minor: for native, stop now waits up to the one-second grace before it interrupts the active turn, so a silent host lets the running turn keep spending for up to a second.

# Part 3 — receipt forwarding (`dde1ab6..55d97ab`)

`76cd233` and `55d97ab`. Both new tests **20 / 20** in isolation, `controller.test.ts` and `receipts.test.ts` whole-file 20 / 20. The earlier full suite at this step is subsumed by the final run below.

**Verdict: correct and scoped. No findings.** What reaches a consumer: a live `{ kind: "items_receipt", turnId, itemIds, milestone }` on the conversation subscription (`delivered` or `seen`), for the harness's committed advances, using the session turn id; held turns are included; nothing is written to history. Monotonic state is `advanceItemReceipts` (a repeated id or an older milestone is skipped and never moves it back); it also backs `receiptOf`.

My probes (real stdio, two conversations on one harness session, interleaved steered items, then single-conversation cases):

- **Two conversations, three interleaved steers each:** each saw only its own ids, **no cross-contamination, 0 duplicates, monotonic per item**, each in its own turn.
- **Out-of-order and duplicate receipts:** the controller test sends repeated ids, `seen` before a late `delivered`, a reconnect and a reconcile; the event list is exactly the advances, no duplicate after reconnect, `receiptOf` ends `seen`.
- **A receipt for another channel** can't reach a controller (events are routed by channel; an event for a turn the controller doesn't know is dropped with a warning).
- **Before the conversation attaches:** an operator push to the channel produced `delivered` and `seen` for it once, no duplicates after the conversation then prompted.
- **After stop:** zero receipt events (`!this.stopPromise` guard), even after releasing the held tool.
- **Turn settlement and history:** the early `return` after the receipt bookkeeping skips the turn sink, which never handled `items_receipt` (it has no case for it), so prompt settlement, `message_delivered` and the transcript are unchanged; the full suite and the snapshots are unchanged.
- **Docs and switches:** `ItemsReceipt` is exported and joins `TurnEvent` and `AgentSessionEvent`; the changelog says to update exhaustive switches; the guide describes it as live-only. A search of `src` and `test` finds no other exhaustive switch over these unions, and typecheck is clean.

# Part 4 — the real-process stream gate (`55d97ab..2e1869f`)

`ee78c68` (one test file, two cases) and `2e1869f` (the report). Nothing under `src/` changed.

- **Determinism:** the test intercepts the real child's event stream and **holds the first `message_completed` frame and everything after it behind a barrier**, so the assertions run while the completion is provably not delivered. Stream mode: the consumer's chunk callbacks have received `"Working"` (and wire text deltas were seen) before the barrier is released; default `final`: **zero provisional wire deltas** and no chunks. Both then finish with the same full result (`"Working\n\nFinished."`, message ids equal to the first chunk's id) and the transcript holds **one** authoritative final record per reply (revisions that share a logical id are the activity snapshots, filtered by their `:snapshot:` suffix and checked to introduce no extra reply).
- **Run counts:** **50 / 50** isolated runs of each of the two tests, and the file whole **20 / 20**.
- **Varied timing (mine):** 6 rounds each of stream and final with random chunk delays (0–40 ms) and a random hold (0–80 ms) before release: stream's provisional text was `"Working"` (a prefix of the final), final's was `""`; the final text and the two final records were identical every time, nothing recorded twice.
- **A strict prefix:** I could not test it end to end. The scenario format requires the scripted chunks to concatenate to the content, so the scripted real child can't produce a provisional text shorter than the final (my attempt at one was rejected by the harness). Suffix completion therefore stays covered only by the controller unit tests, as the brief intended; say so in the report.
- **Stop mid-stream** (completion held, stream mode): the prompt settled (no hang), the consumer had `"Working"`, and the records were the activity snapshot plus one final marked `failed`, **the same as before R6**; the prompt now rejects with `NativeInputStoppedError` instead of resolving cancelled (the Part 2 finding).
- **Interrupt mutation:** now fails, as above. **Stall clock:** the regression passes 20 / 20.

# Final: the whole of R6 (`a9b3ae1..2e1869f`)

**Clean archive of `2e1869f` (`TMPDIR` on `/dev/shm`): typecheck clean, 1,668 pass, 0 fail, 158 files (the report's number), 35 snapshots unchanged, A1 unchanged, harness suites 367 pass, no leftover process.**

| Protected file | Measured |
| --- | ---: |
| `agent-session.ts` | **4,491** |
| `native/host.ts` | **909** |
| `native/controller.ts` | **599** |
| `client.ts` / `controller.ts` / `conversation-manager.ts` / `agent.ts` / `metering/engine.ts` | 1,046 / 764 / 1,012 / 563 / 1,034 (unchanged) |

**Done criteria, item by item**

| Item | Verdict |
| --- | --- |
| **Withdraw through the harness** | **Closed**: confirmed `withdrawAsync` (with `taken`, `not_found`, intent persistence, fenced dispatch) and the bounded shutdown withdrawal; the unobserved-turn hazard I measured is gone |
| **Stall clock paused while the host reopens** | **Explicitly dropped as a step** (already correct by construction: backend supervision disables the limits even when configured); a regression test proves it |
| **`items_receipt` beyond `receiptOf`** | **Closed**: live, per-conversation, monotonic, no history |
| **Real-process `stream` text** | **Closed**: deterministic barrier, 50 / 50 |
| **Docs for every public change** | `NativeInputStoppedError`, `withdrawAsync`, `TurnEvent` `input_withdrawn`, `ItemsReceipt`, the custom records' `markWithdrawing` and `markAccepted(id, true)`: all in the changelog and the guide |

**Verdict: R6 is complete and I recommend building the pre-alpha with it, with one required decision first.** The decision is the Part 2 finding: stop now **rejects** a running native prompt where it used to resolve `cancelled` with its partial text. Either narrow the rejection to inputs that were never taken, or document it as a breaking change. Everything else I found is minor (the one-second grace before the interrupt, the opt-in file-backed records for withdrawal across a reopen, and the unit-only coverage of suffix completion).
