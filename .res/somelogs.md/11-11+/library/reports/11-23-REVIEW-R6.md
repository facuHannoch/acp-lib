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

# Part 5 — the stop narrowing (`2e1869f..ac09144`) and a correction to my own claim

`ac33f2d` (fix, tests, docs) and `ac09144` (report). Clean archive of `ac09144`: typecheck clean, **1,670 pass, 0 fail, 159 files** (the report's number), 35 snapshots unchanged, A1 unchanged, harness suites 367 pass, no leftover process. Sizes: `agent-session.ts` 4,491, `native/host.ts` 909, `native/controller.ts` 599, the others unchanged. All six new or strengthened cases **20 / 20** in isolation; `stop-partial.test.ts` and `withdrawal.test.ts` whole-file 20 / 20.

## The discrepancy: I was wrong, cod2a was right

In Part 1 I wrote that on `a9b3ae1` stop "resolved `cancelled` with its partial text". **That was wrong.** My probe printed only the status; I never printed the text. I re-ran one probe, printing the status, the text, the messages and the metering record, on all three commits, in two shapes (the turn held in a tool after a completed partial message; and `stream` mode with the completion frame held):

| Commit | Stop or close, turn held in a tool | `stream`, completion held |
| --- | --- | --- |
| **`a9b3ae1`** (before R6) | `status=cancelled`, **`text=""`**, no messages, **no metering record** | the same, empty |
| **`2e1869f`** | **rejects** `NativeInputStoppedError` | rejects `NativeInputStoppedError` |
| **`ac09144`** | `status=cancelled`, **`text="Partial reply."`**, one message, **a `cancelled` metering record** | rejects `AgentSessionOperationError` ("the conversation stopped"), see below |

The persisted assistant record was `Partial reply.` in all three (status `completed` after a tool, `failed` mid-stream), so history did not change.

So the corrected behaviour is **not** the same as the old one: for a prompt whose message had completed before the stop, the caller now gets the **partial reply** where it used to get an empty text, and a metering record exists for the stopped turn where there was none. Both are improvements, but they are changes, and the changelog's wording ("keeps its cancelled result and any partial reply") reads as "unchanged". **Say it as a change** ("now returns the partial reply that earlier returned empty text, and records metering for the stopped turn").

Two more facts from the same comparison:

- **Mid-message stop (a realistic one, no barrier; a streamed message whose second chunk arrives 4 s later, stopped at 0.7 s):** `ac09144` returns `cancelled` with `text=""`, **identical to `a9b3ae1`** (the partial text is not in the result, though the consumer's chunk callback had already received `"Partial "`); `2e1869f` rejected. So partial text comes back only for messages that had completed.
- **Stop racing a `message_completed` still in flight** (my barrier shape, stream mode): `ac09144` rejects with `AgentSessionOperationError: the conversation stopped`, where `a9b3ae1` returned `cancelled`. It is a narrow race (the completion arrives after the stop began), the persisted record is the same, but it is neither the old result nor the intended one; consider settling that case as `cancelled` as well.

## The requested cases (on `ac09144`)

| Case | Result |
| --- | --- |
| **Mixed: a running prompt plus an unclaimed steered input, stop and close** | running prompt `cancelled` with `"Partial reply."`; the unclaimed input rejected `NativeInputStoppedError` (typed); **one model call** (no extra turn); the unclaimed item reads `withdrawn`. Same for close (checked after a reopen) |
| **A take-winning race** (30 rounds, stop first or the tool released first, with 0–25 ms offsets) | `{ running cancelled, unclaimed typed }` 15 times (stop first, withdrawn, no call on another turn), `{ completed, completed }` 14 times (the turn took the input first, so it completed with the turn), `{ completed, typed }` once (the withdrawal won just before the turn finished); **never stuck, never both, never a model call on another turn** |
| **A pre-submission prompt** (held in `beforeDispatch`) | still `cancelled` locally on stop (`text=""`), not typed |
| **The typed error only for never-taken inputs** | yes: in every case the running (taken) prompt never rejected typed; only submitted, unclaimed inputs did |

## The changelog and the guide

They now say that only submitted inputs that were never taken reject with `NativeInputStoppedError`, that a taken prompt keeps its cancelled result, that the grace is "up to one second", and that spend is possible if take wins or the host is unavailable. Missing: the **text/metering change** above and the **mid-message and in-flight-completion** behaviours (empty text; the rare rejection).

## Mutations (each reverted; the three native test files, 49 tests)

| Mutation | Result |
| --- | --- |
| taken prompts rejected on stop (the exemption for the active turn removed) | fails four tests |
| a local (pre-submission) prompt rejected typed | fails |
| **the `taken` answer during the grace not noted (`noteTaken`)** | **passes: a test gap.** Add a case where the withdraw answers `taken` during the shutdown grace and check the prompt keeps the turn's result |

## Verdict

The narrowing does what was decided and the previous failure (a running prompt rejecting) is gone. Required before release: correct the changelog as above (the partial reply and the metering record are changes from `a9b3ae1`). Recommended: settle the stop-racing-`message_completed` case as `cancelled`, and add the `noteTaken` test.

# Part 6 — the last stop follow-up (`ac09144..fde102b`)

`92a02d2` (runtime, tests, docs) and `fde102b` (report). Clean archive of `fde102b`: typecheck clean, **1,671 pass, 0 fail, 159 files**, 35 snapshots unchanged, A1 unchanged, harness suites 367 pass, no leftover process. Sizes: `agent-session.ts` 4,491, `native/host.ts` 909, `native/controller.ts` 599, the others unchanged. The three new cases (stop with a completion in flight, the take-evidence case, and the strengthened stop-partial case) **20 / 20** in isolation (the take-evidence test replaced the old `take wins` case under a new name, so it counts once), and the three touched files whole-file **20 / 20**.

## The side-by-side probe, all three commits (status, text, messages, metering)

| Case | `a9b3ae1` | `ac09144` | `fde102b` |
| --- | --- | --- | --- |
| **(1) Stop (and close) mid-turn after a completed message** | `cancelled`, text `""`, no messages, **no metering** | `cancelled`, `"Partial reply."`, one message, metering `cancelled` | **the same as `ac09144`** |
| **(2) Stop with the completion frame held** | `cancelled`, `""`, no metering; assistant record `failed "Partial reply."` | **rejects** `AgentSessionOperationError` ("the conversation stopped"); record `failed "Partial reply."` | `cancelled`, **`""`**, metering `cancelled`; **no assistant record** |
| **(3) A streamed message stopped halfway** | `cancelled`, `""`; the chunk callback had `"Partial "`; only an `in_progress` snapshot persisted | identical | **identical, including the persisted snapshot** |
| **(4) Mixed (running + an unclaimed steered input), stop and close** | both `cancelled` `""` (no withdrawal; the input ended `seen`) | running `cancelled "Partial reply."`; unclaimed typed rejection; item `withdrawn`; no call on another turn | **identical to `ac09144`** |
| **(5) Take-wins race, 30 rounds** | `{cancelled, cancelled}` 22, `{completed, completed}` 8 | `{cancelled, typed}` 15, `{completed, completed}` 15 | `{cancelled, typed}` 15, `{completed, completed}` 13, `{completed, typed}` 2; **never stuck, no call on another turn** |

Case (2) is the fix: stop with the completion still in flight now resolves `cancelled` with empty text, the same status and text as `a9b3ae1`. Case (1) is the intended improvement; case (3) is unchanged.

## The changelog, against what I measured

It now says: only never-taken submitted inputs reject `NativeInputStoppedError`; a stopped turn with a completed reply returns that partial text and a `cancelled` metering record, where the caller used to get empty text and no metering record; stopping during the first streamed message still returns `cancelled` with empty text while its completion is outstanding; spend is possible if take won or the host is unavailable or silent. That is **true for (1), (3), (4) and (5)**. Two precisions: in case (2) the metering record is also new (the changelog gives that only for a completed reply), and the guide's "first message" wording is narrower than the behaviour (it applies to whichever message is still streaming, with the earlier completed messages returned).

## One new difference: a reply the harness committed is no longer persisted in case (2)

In case (2), `a9b3ae1` and `ac09144` persisted the reply (`failed "Partial reply."`) because the late completion reached the recording handlers after the stop. `fde102b` drops a completion that arrives after the turn settled (`if (settled) return`), so **nothing is persisted**, although the harness committed the message and the consumer's chunk callback saw its first part. History for that race is shorter than before. It is a narrow race (stop during a completion's flight), and I did not test whether a later reconciliation restores the reply from the harness; please decide whether dropping it is intended, and say so in the changelog.

## Mutations (each reverted; the four native test files, 53 tests)

| Mutation | Result |
| --- | --- |
| `noteTaken` dropped (the `taken` answer during the grace) | **fails** `native shutdown keeps partial text when the withdrawal answer is the only take evidence` (was a survivor) |
| stop rejects instead of resolving `cancelled` | fails the in-flight-completion test |
| taken prompts rejected on stop (the active-turn exemption removed) | fails four tests |
| **the late-completion guard (`if (settled) return`) removed** | **passes: a test gap**, and it is exactly what controls the record loss above |

## Verdict

The three items were done and the in-flight-completion case, the `noteTaken` test and the changelog are correct. **R6 is approved** (the whole of it, with Parts 1 to 5), subject to the one decision above (the unpersisted late completion in case (2): intended or not, and in the changelog either way) and one small test to add for the late-completion guard. Neither blocks building the pre-alpha.

# Part 7 — the stopped-reply recovery (`fde102b..97b44e3`)

`1b1472d` (fix, tests, docs) and `97b44e3` (report). Clean archive of `97b44e3`: typecheck clean, **1,672 pass, 0 fail, 159 files** (the report's number), 35 snapshots unchanged, A1 unchanged, harness suites 367 pass, no leftover process. Sizes: `agent-session.ts` 4,491, `native/host.ts` 909, `native/controller.ts` 599, the others unchanged (`recovery.ts` 93, `recording.ts` 235). Both new tests **20 / 20** in isolation and the two touched files whole-file **20 / 20**.

**Verdict: the fix does what it says for the case it targets, and the cancelled caller result is unchanged. Approve. Three small test gaps and one narrower case that is still not restored at stop.**

## What the fix does (read from the code)

When a stop settles a prompt as cancelled, the run now asks the controller to **recover the stopped turn's committed replies for persistence only**: one `channel/reconcile` for the exact harness turn id (paging, with a "turn unknown" error), reading each reply not already seen by provider id, all within **one five-second deadline**, then persists them with their message ids without changing what the caller received. If the read fails, the draft that was streamed is kept as an incomplete reply.

## My probes (real stdio; a barrier holds the real `message_completed` frame)

| Probe | Result |
| --- | --- |
| **Stop with the completion held** | the caller gets `cancelled` with **empty text** (unchanged); stop took 17 ms; **one** final record, `completed "Partial reply."`, provider id `model:1`, written at the stop |
| **Reopen the conversation in the same Agent, twice** (frame still held) | the record is identical each time, no second one |
| **The held live completion delivered late** | still one record (the late guard) |
| **Close the Agent, then open a new Agent, twice** | the same single record both times |
| **A silent host** (the reconcile never answers) | stop completes in **5,009 ms**, so the deadline is bounded; the caller is `cancelled`; the draft is persisted as an incomplete (`cancelled`) reply; the Agent close that follows took 16 ms |
| **A stop with nothing committed** (a tool held before any message) | caller `cancelled`, empty; **no record** written |
| **Two conversations on one harness session, both stopped with completions held** | Alpha got its own reply with its own id; **Bravo's reply is not attributed to Alpha** (no cross-attribution). See the narrower case below |

## A narrower case that is still not restored at stop

In the two-conversation probe, Bravo's turn events were also still in flight at the stop, so the controller had never seen its turn (the input was taken, shown only by the withdrawal answer). Bravo's reply was committed by the harness (its model call succeeded) but is **not persisted at stop**, **not restored by a same-Agent reopen**, and is restored only when a **new Agent opens** (as `cancelled "Bravo reply."`, id `model:2`). That is a narrower window than the fix covers (no prepared turn exists to recover through), but it is a real gap, so either extend the recovery to inputs that only have take evidence from the withdrawal, or document it.

## Mutations (each reverted; the five native test files, 75 tests)

| Mutation | Result |
| --- | --- |
| the late-completion guard (`if (settled) return`) removed | **fails** two tests (it survived before) |
| the exact-turn filter dropped (reconcile the whole channel) | fails |
| recovered replies not persisted | fails |
| **the five-second deadline dropped** | **passes: a test gap** (add a stop with a silent reconcile and assert it returns within about five seconds) |
| **the provider-id dedupe (`known.has`) dropped** | **passes: a gap** (the single record I measured is also protected by persistence-level dedupe; add a case where the stop already saw part of the reply) |
| **the "turn unknown" check dropped** | **passes: a gap** |

## Notes

1. For native, a stop can now take up to about **six seconds** in the worst case (one second of withdrawal grace plus five of recovery) when the host is silent. It is bounded and I measured the five; say the sum in the changelog.
2. The changelog now covers the cancelled metering record for the held-completion case and that recovered replies are stored once by harness message id and do not enter the live output.

## R6 verdict

With this fix, everything I asked for across R6 is closed or documented, and the whole of R6 is **approved** for the pre-alpha, together with R5's documentation. The narrower case above and the three missing tests are follow-ups, not blockers.

# Part 8 — the recovery deadline fix (`97b44e3..bb87489`)

`f45fdab` (fix, tests, docs) and `bb87489` (report). Clean archive of `bb87489`: typecheck clean, **1,675 pass, 0 fail, 160 files** (the report's number), 35 snapshots unchanged, A1 unchanged, harness suites 367 pass, no leftover process. Sizes: `agent-session.ts` 4,491, `native/host.ts` 909, `native/controller.ts` 599, the others unchanged (`recovery.ts` 100). The three new tests **20 / 20** in isolation and `recovery.test.ts` whole-file **20 / 20**.

**Verdict: clean. R6 is approved for the pre-alpha. One related finding outside this commit (R5's ledger reader has the same Bun problem) and one test gap.**

## (1) The Bun issue, reproduced

Bun 1.3.14: a signal from `AbortSignal.timeout(2000)` used by two sequential requests (each adds an `abort` listener and removes it when it completes, as `HarnessClient.request` does). Request 1 completed at 500 ms and removed its listener; request 2 then added one and waited: **the timeout never fired in 6 s** (`aborted` stayed `false`). The control, with a listener left attached throughout, fired at exactly 2,000 ms. So the timer is lost once the last listener is removed, and the fix's single explicit timer is the right remedy.

The fixed function, measured directly:

| Case | Result |
| --- | --- |
| a page, a 400 ms message read, then a second reconcile that never answers | rejected `timed out` at **5,002 ms**: one shared deadline across requests |
| completes early / an unknown turn | returns in 1 ms / rejects in 0 ms, and the **process exits in 0.07 s**: the timer is cleared (`finally { clearTimeout }`) on both |
| the silent case | the process exits in 5.09 s, right after the deadline: no timer outlives the call |
| **Full stack, worst case** (a running turn with its completion held, an unclaimed input whose withdrawal never answers, and a reconcile that never answers) | the stop took **6,023 ms** (one second of withdrawal grace plus five of recovery, **not eleven**); the running prompt was `cancelled`, the unclaimed one `NativeInputStoppedError`; the Agent close afterwards took 11 ms |

## (2) The mutations

On the five native test files (43 tests): reintroducing `AbortSignal.timeout` (the Bun bug), removing the timer, changing five seconds to twenty, dropping the provider-id dedupe, and dropping the unknown-turn check **each fail their targeted test**. **One survives: removing `clearTimeout`** (a leaked timer) passes, so nothing guards the "no timer leaks" property; add a test that runs the function and checks the process or fake timers are clean, or one that asserts the timer count returns to zero.

## (3) and (4) The documentation

- The take-only limitation is documented in both the changelog and the guide: with no prepared turn and the take learned only from the withdrawal response, a committed reply can be missing after stop and after a same-Agent reopen, and a new Agent can recover it from the persisted harness session. That matches my probe (Bravo restored as a `cancelled` record only on a new Agent open). **One nit:** both add "when the submission is still tracked". In my probe the new Agent had fresh in-memory records (no tracked submission) and still restored the reply, so the qualifier is not needed and may mislead; say "a new Agent can recover it".
- "About six seconds … one second for withdrawal and five for recovery. Other shutdown requests keep their own deadlines" is accurate (6,023 ms measured). The honest caveat is that a host that is silent for *every* request can take longer, because the other shutdown requests (for example the interrupt of the running turn) keep the client's own deadline, as the changelog says.

## A related finding outside this commit: R5's ledger reader has the same defect

`NativeUsageLedger.readTurn` (`src/metering/native/ledger.ts:35`) builds its fifteen-second total budget from `AbortSignal.timeout(...)` and uses that signal for **every page**. I ran it with a 1.5 s budget, page one answering after 300 ms and page two never answering (honouring the signal): **no timeout fired in eight seconds.** After the first page completes, the elapsed budget is silently gone, so a hung later page is bounded only by the host client's own request timeout (30 s by default), not the intended 15 s total. The existing test for the elapsed budget uses one hung read (a listener stays attached), so it passes. Replace it with the same single explicit timer, and add a two-page test. This does not change any R5 gate result; it is a robustness fix to schedule.

## Verdict

The recovery fix is correct and bounded, the Bun problem is real and handled, the documentation is truthful, and nothing else changed. **R6 is approved to build** (with R5's documentation). Follow-ups, none blocking: the leaked-timer test, the "still tracked" wording, and the same timer fix in the R5 ledger reader.
