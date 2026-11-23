# Review — R5 step 1 (the bounded ledger reader and per-channel source)

This review covers `c2ba881..7e537af` on `integration-r456`: `f4d9fab` (the amended brief), `47e2750` (`src/metering/native/{ledger,projection,source}.ts` and `test/metering-native-source.test.ts`) and `7e537af` (the report). I used a clean `git archive 7e537af` (`/tmp/clad2a-r5`, `TMPDIR` on `/dev/shm`); I didn't check out the branch. Probes and mutations were run only in that archive.

**Verdict: step 1 meets its gate. No blocking findings.** The reader and projection are exact on the real wire (probe below). Three things to carry into step 2a, and one test gap.

- **Typecheck clean. Full suite: 1,624 pass, 0 fail, 152 files**, 35 snapshots; no snapshot or protected file changed, so the A1 hash is unchanged. No leftover process.
- **Each of the seven new tests: 20 / 20 in isolation** (each `-t` matched exactly one test), and **20 / 20** whole-file runs.
- **Size gates** (all measured on the archive): `agent-session.ts` 4,495, `client.ts` 1,046, `controller.ts` 764, `native/host.ts` 916, `native/controller.ts` 599, `agent/conversation-manager.ts` 1,012, `agent.ts` 563, `metering/engine.ts` 1,059: **every one exactly at its ceiling, unchanged**. The only source change is three new files: `ledger.ts` 80, `projection.ts` 110, `source.ts` 56 lines. The source is not wired into anything yet (nothing else in `src` references `metering/native`), so the harness, OpenCode and the engine are untouched.

## Against the amended brief

| Requirement | Result |
| --- | --- |
| **Bounded shared reader, independent per-channel pulls** | `NativeUsageLedger` is stateless: each `readTurn` owns its own `AbortSignal.timeout` (default 15 s) and page budget (1,000), optionally combined with a caller signal. Each source has its own `#pulling` guard (a second concurrent pull on the same channel throws). Test: a pull on channel `alpha` that never returns does not delay `beta`'s pull, and the hung one is cancellable ("read cancelled"); the late page after cancel is not staged. **Slow-channel try:** the same fake-reader pattern; I did not stress it against the real host client (see risk 3) |
| **Exact call / attempt / usage projection** | Probe against the **real** harness, below: exact |
| **UNKNOWN route** | `providerID` and `modelID` are `""` (typed as the literal `""`), `cost: null`, `sequence: null`, `certificationId: "native-harness-unverified"`: no configured model leaks in. In the engine `providerID`/`modelID` form the grouping key and the "no pricing policy for …" reason (`engine.ts:739–770`), so an empty route should resolve to `pricing_unavailable`; that is step 2a's to prove |
| **Staged sealed rows only** | A drained inference needs: the call is not `running` with a valid `endedAt`, the attempt is not `running` with a valid `endedAt`, and **all three** token fields present. Everything else is counted in `unmeasured`, which `outstandingReports` returns, and stays in the evidence (`running` and partial rows keep their field presence; explicit zero is preserved) |
| **Never zero, no completeness claim** | A missing or partial usage is never filled: probe M4 below (zero-filling) fails the test. The source claims nothing (`certificationId` is the "unverified" label; `lastSeenCallId` is documented as an observation, not an acknowledgement) |
| **Running rows at terminal** | Covered: a `running` call stays out of the drain and is counted in `outstandingReports`; after the call seals and a re-pull, the same call is staged with its final attempts |
| **Host down at close** | A pull after the harness is stopped rejects ("the native harness is not running"), leaves the source **unhealthy** with nothing staged, and **does not relaunch the harness** (my probe: 0 new launches). Tested with an injected failure: no stale or partial batch after a paging or host failure, and recovery on the next good pull |
| **The O(session length) scan avoided by the cursor** | The supplied cursor works: a 403-call ledger with `after: "400"` took **two page reads** and returned only the last three calls. The cursor is the caller's accounted prefix; the reader never advances it itself, which is the right split for 2b. In step 1 a pull **without** a cursor still reads the whole ledger, as the report says |
| **Page validation** | A non-array page, a `next` that isn't the last returned call, an empty page with `next`, a repeated or empty call id, a missing channel or turn, a repeated attempt id or a non-contiguous ordinal, an unknown outcome, and a negative or non-integer count all throw; an exceeded page budget and an elapsed timeout fail closed |

## Ground truth on the real wire (my probe)

The test fixtures in the commit use a fake page reader. I added a throwaway test over a real `serve --stdio` harness through `nativeRig`, with a script whose attempts carry distinct usage values A (101/7/108), B (55/1/56, a **transient failure that is retried**), C (207/13/220) and D (311/19/330): a tool-using turn of three model calls and four attempts. Through `NativeUsageLedger` reading `host.modelCalls()` (pages of size 100) and `NativeInferenceSource`:

- the ledger showed 3 calls, 4 attempts, with exactly the scripted values (also read at `limit: 1`);
- the source staged **4 inferences** with ids `1:0, 2:0, 2:1, 3:0` and tokens exactly `A, B, C, D` in that order, `unmeasured: 0`, and the summed total **714 = the script's 714**. The failed attempt's own usage (B) is kept, not merged into the retry.

So the existing wire is enough for the in-turn gate, as the brief says; the scripted values, not only the ledger, agree. (`TurnResult.usage` is still `null`, as the brief says.)

## Mutations (each reverted)

| Mutation | Result |
| --- | --- |
| remove the channel filter | fails |
| remove the turn filter | fails |
| zero-fill partial usage | fails |
| stop reporting `unmeasured` | fails |
| `drain` returns the staged batch again (double charge) | fails |
| remove the cursor-advance check | fails |
| keep the staged batch when a pull fails | fails |
| **ignore the call-level seal (`sealed = true`)** | **passes: a test gap** |

## Gap and notes (none blocking)

1. **Test gap: the call-level seal.** A call whose outcome is `running`, or that has no valid `endedAt`, but whose single attempt is `succeeded` with full usage and an end time, should stay unstaged (a retry attempt could still be appended). The existing test only has a running *attempt*, so the call-level check is untested. Add that case.
2. **For 2a: an empty turn looks like proven zero.** In my probe, pulling a turn id with **no calls** returned `calls: []`, `unmeasured: 0` and a **healthy** source, indistinguishable from a turn that really spent nothing. The wire can't prove a turn made no calls; 2a must not read "empty and healthy" as exact zero unless the operation is provably undispatched, and the gate should name that case (a turn whose id never appears in the ledger).
3. **For 2a: the reader's signal is not passed to the host.** `readPage(query, signal)` receives the signal, but `NativeHarnessHost.modelCalls(params)` takes none, so a timed-out or cancelled pull is detached (the `untilAborted` race) while the request stays in flight until the host's own timeout (`requestTimeoutMs`, 30 s by default, longer than the reader's 15 s). The staged result is safe, but a hung host request occupies the connection; keep the two timeouts coherent when wiring, and test a slow channel against the **real** host client, not only the fake reader.
4. The source's `#pulling` guard makes a second concurrent `pullTurn` on one channel throw rather than queue; 2a should serialize per channel (a held backend turn plus a normal close can both ask).
5. `certificationId` is `"native-harness-unverified"`, which the engine will treat as a certification label; confirm in 2a that nothing treats a source with that id as a verified source.

**Process:** per my own rule, each of the seven new tests ran 20 times in isolation, plus the whole file 20 times and the full suite once; all clean.

# Part 2 — R5 step 2a (in-turn parity and the operation close)

This covers `7e537af..28da8d5` on `integration-r456`: `f56de5e` (code) and `28da8d5` (report), plus the alpha merge `e3ebb0b`. I used a clean `git archive 28da8d5` (`/tmp/clad2a-r5b`, `TMPDIR` on `/dev/shm`) and didn't check out the branch. Probes and mutations ran only there.

**Verdict: step 2a meets its gate. No blocking findings.** Every item you listed holds, and the independent real-wire parity matches. Four notes.

- **Typecheck clean. Full suite: 1,635 pass, 0 fail, 153 files**, 35 snapshots (none changed; the A1 hash is unchanged). The harness's own suites, which this commit touches (`HarnessClient`), also pass: `src/native-harness/test` **360 pass, 0 fail, 47 files**. No leftover process.
- **Each of the ten new tests: 20 / 20 in isolation** (each `-t` matched one test), and both touched files **20 / 20** whole-file.
- **Size gates** (measured): `agent-session.ts` **4,493** (≤ 4,495), `client.ts` 1,046, `controller.ts` 764, `native/host.ts` **909** (≤ 916), `native/controller.ts` 599, `conversation-manager.ts` 1,012, `agent.ts` 563, `metering/engine.ts` **1,051** (≤ 1,059). New modules: `ledger.ts` 81, `operation.ts` 61, `projection.ts` 110, `source.ts` 79, `measurement-provenance.ts` 20, `native/usage.ts` 15. The engine and host shrank by extraction.

## Your five notes

| # | Note | Result |
| --- | --- | --- |
| 1 | A running call (or one with no `endedAt`) whose attempt succeeded stays unstaged | **Closed.** New test `a succeeded attempt waits for its call outcome and end timestamp to seal`. *Mutation:* forcing `sealed = true` now fails it (it passed before) |
| 2 | An empty healthy turn is unavailable, not proven zero | **Closed.** `measureNativeTurn` returns `usage_unavailable` ("native ledger has no calls for this turn") with the evidence `calls: []`, and the engine counts it as an unmetered operation. *Mutation:* treating an empty read as measured fails `a healthy empty native ledger cannot prove a dispatched turn spent zero`. Note 1 below on the undispatched case |
| 3 | The slow channel and cancellation against the **real** host client | **Closed.** `HarnessClient.request` now takes an optional `AbortSignal`; an abort or the reader's deadline rejects the waiter and clears its timer and listener, and `close()` rejects remaining waiters. The new test `a slow model-call read through the real host client…` uses the real `NativeHarnessHost` and `HarnessClient` over a controlled transport: a hung read is cancellable and the deadline fires against the client's 30 s default, while **another channel reads independently**. The reader's `openRead` pins **one client** across pages, so a restart mid-read can't splice pages from two sessions |
| 4 | Concurrent `pullTurn` on one channel is serialized | **Closed.** `NativeInferenceSource` runs pull and drain through one promise queue (`readTurn` = pull + drain as one queued operation), so a second close can't overwrite the first's batch. Test `concurrent same-channel turn reads serialize…`. *Mutation:* removing the queue fails it |
| 5 | `native-harness-unverified` is excluded from every certified path | **Closed, and I tried to defeat it.** The engine drops a source with that id before use (`inferenceSource = undefined`), so it can't supply attribution, outstanding reports, health preflight or strict certification. Probes: `new MeteringEngine({ adapterId: "opencode", enforcement: "billing_required", inferenceSource: <native source> })` throws (needs a live `opencode-plugin@1`), and so does `adapterId: "main"`; a native conversation configured with `billing_required` and that source is refused at create; with `best_effort` the source's staged batch is left undrained and the record's provenance is `none`. *Mutation:* removing the exclusion fails the test. A native conversation also ignores a consumer-supplied `inferenceSource` (`!config.native`) |

## Parity on the persisted record

`native metering matches the scripted attempts and the paged stdio ledger`: Alpha runs a tool turn (a held tool, a transient failure with its own usage, a retry, a final reply) while Beta runs an interleaved turn; the script fixes 101/7/108, 55/1/56, 207/13/220, 311/19/330 for Alpha and 41/3/44 for Beta. The persisted record has `reportedCumulative` 674/40/714, `nextState.totals.total.knownTokens` 714, the evidence's per-attempt usage and outcomes equal to the **script**, and its call list equal to an independent `limit: 1` page of the ledger, call id by call id. `result.usage` stays `null`, `providerId`/`model` are `null`, `pricingStatus: pricing_unavailable` with the route reason, provenance `native_ledger` / `partial` / `routing: unknown` with **no certification id**, and the pricing function is never called. Beta's 44 tokens are in Beta's record only.

**My additional probes (a throwaway test over the real stdio harness):**

- **Interleaved channels, two turns closing at once:** 6 rounds with both channels prompted together and distinct per-step usage (1,00x/x on Alpha, 5,00x/50+x on Beta). Every record carried its own exact usage, and the final persisted totals were Alpha **6,042** and Beta **30,342**, exactly the script's sums: no bleed.
- **A failed save of the metering record:** I made the first metering commit throw once. The first prompt failed with `AgentSessionOperationError`, but the retry in the catch path persisted the record once; the next prompt completed, and the persisted state was **operation counts 1 then 2, totals 110 then 330**: nothing double-counted. (Failed-save replay across a restart is 2b's.)
- **Duplicate drains:** the source's `drain` empties its batch and `readTurn` returns pull and drain together, so a second `drain` returns nothing.

## Mutations (each reverted; both new test files, 17 tests)

| Mutation | Result |
| --- | --- |
| zero-fill partial usage | fails |
| no channel filter | fails |
| no turn filter | fails (4 tests, including the stdio ones) |
| double drain | fails |
| stale batch kept after a failed pull | fails |
| no call-level seal | fails |
| empty turn counted as measured | fails |
| unverified source accepted as verified | fails |
| no per-channel queue | fails |

## Seam and record shape

One close seam, `engine.close` → `measureNativeTurn`, is used by the live turn, the already-ended backend turn, the reconciled terminal turn after a stdio restart (tests for each, including a kill after the durable terminal commit) and the error/cancel path, with the wire turn id captured at `prepareTurn`. The pull is **awaited before** the synchronous `drain` (`readTurn` does pull then drain). The record carries `nativeUsage` (channel, wire turn id, calls, attempts, `unmeasured`) and is persisted through the normal `meteringRecorded` commit under the stable operation id; host loss at close gives an `unavailable` record with the wire identity and does **not** relaunch the harness.

## Notes (none blocking)

1. **Undispatched or cancelled-before-dispatch turns are `unavailable`, not exact zero.** The brief allows exact zero for a provably undispatched operation; 2a conservatively never does that. It is safe; say so in the changelog so consumers don't read it as a bug.
2. **A turn with some sealed inferences and some unmeasured ones is `usage.status: "metered"`.** The summed total excludes the unmeasured attempts, and the honesty is carried by `provenance.attribution: "partial"` (always partial for native) and `nativeUsage.unmeasured > 0`. A consumer that reads only `usage.status` would see a measured total that under-counts. Consider a reason on `usage` or a distinct status when `unmeasured > 0`, or document that `nativeUsage.unmeasured` must be checked.
3. **A `billing_required` native conversation is refused with an opaque message** ("The provider session could not be created."). 3a owns the refusal text; make sure it names the missing capability.
4. **`HarnessClient.request` was changed** (`src/native-harness/src/interfaces/client.ts`): an optional signal and a restructured waiter/timer. It is additive and the 360 harness tests pass, but it is a harness-owned file: have haurness-l confirm it.

**Process:** per my rule I ran every new test 20 times in isolation plus both files whole 20 times, the touched harness suite and the full suite.

# Part 3 — R5 step 2b (durable cursor and replay) and the HarnessClient tests

This covers `28da8d5..9fb2b2e` on `integration-r456`: `2aff51c` (HarnessClient tests and doc), `0fdb886` (2b) and `9fb2b2e` (report). I used a clean `git archive 9fb2b2e` (`/tmp/clad2a-r5c`, `TMPDIR` on `/dev/shm`) and didn't check out the branch. Probes and mutations ran only there.

**Verdict: 2b meets its stated gate, and the replay path is sound. One important finding about what the cursor design cannot recover (it silently drops a paid turn's usage when the database is failing during staging), plus a scan-cost consequence of a gap and four mutations the tests miss.**

- **Typecheck clean. Full suite: 1,639 pass, 0 fail, 154 files**, 35 snapshots (none changed; A1 unchanged). The harness suites: **367 pass, 0 fail, 48 files**. No leftover process.
- **Each of the four new tests: 20 / 20 in isolation** (each `-t` matched one test), the durability file **20 / 20** whole-file, and the harness client-abort file **20 / 20**.
- **`2aff51c` glance:** seven fake-transport tests (pre-abort sends nothing, a late response after abort, a response or a timeout before abort removes the listener once, transport close, a throwing send, and 64 requests sharing one signal), all checking the pending map is empty and listeners are released once; the doc says `cancelled` ends the caller's wait and the harness may already have applied the request. Reasonable and sufficient; Clad1a owns the confirmation.
- **Size gates** (measured): `agent-session.ts` **4,495**, `client.ts` 1,046, `controller.ts` 764, `native/host.ts` 909, `native/controller.ts` 599, `agent/conversation-manager.ts` 1,012, `agent.ts` 563, `metering/engine.ts` **1,059**. Two files **grew past the step 2a numbers** you set as ceilings: `agent-session.ts` +2 (4,493 → 4,495) and `engine.ts` +8 (1,051 → 1,059). Both are back at the original `cb6f959` ceilings, but "they may only shrink" is not met; either extract a few lines or restate the ceilings. New modules: `durability.ts` 86, `requirements.ts` 10; `ledger.ts` 91, `operation.ts` 68, `source.ts` 81.

## Against your checklist

| # | Check | Result |
| --- | --- | --- |
| 1 | **The cursor is derived from persisted evidence; no full rescan at a close** | **Yes.** `nativeCursor { channelKey, after }` lives in the persisted metering state and is restored before the next scan; it only advances over a wire-confirmed terminal turn whose calls are all sealed and measured (`unmeasured === 0 && terminal && prefixEnd`). The long-history test seeds 320 interleaved calls and, after a restart, one read with `after: "322"`. **My probes:** with alpha and beta interleaved, a restart and a gap on alpha, beta's cursor advanced to its own last call (`6`) and its next close read only `after: "4"`, while alpha's close read `after: "1"` (the gap); beta's total was exactly 606 (script) and alpha 35: independent per channel. A deleted/pruned record: with record detail off, a reopened conversation still knows `native-turn-1` through the SQLite operation index and does not re-accrue it |
| 2 | **A failed save: write-ahead, reopen commits once, no launch, no double count** | **Yes for a commit failure, with one caveat (finding 1).** With the final commit failing, a write-ahead record is left; the state stays at its previous values; reopening commits it **once without a harness launch** (`launches: 0`), and the next turn totals **110 → 330 in two operations**. My probe: fail the commit, close, drop the failure, reopen **twice**: count 1, tokens 110, no pending and 0 launches both times, exactly one metering row. The live path and the replay path cannot both accrue: every native close first restores persisted state into the engine (`adoptAccounting`) and returns an already committed record, and `record()` returns without committing when the operation already exists |
| 3 | **Partial totals carry a reason and partial coverage; "committed incomplete history is preserved as recorded"** | **Yes.** `usage.reason` ("some native model-call attempts could not be measured" or "the native turn's terminal outcome was not confirmed") and an accrual flag that marks the aggregate coverage `partial`. Preserved as recorded is true: the pull is turn-scoped, so an earlier turn's closed record is never rewritten. The flip side is finding 1 and 2 |
| 4 | **Native strict refusal and deferred between-turn accounting** | **Yes.** `billing_required` for a native adapter throws `MeteringPreflightError` naming `native-harness@1` and the sealed per-turn accounting capability, from the manager before a conversation is created and from the engine constructor; the test checks that the conversation list stays empty and the harness was never launched. There is no sweep surface and no `drainForeign` on the native source; the changelog says between-turn usage is a harness dependency |
| 5 | **Earlier notes** | Undispatched turns documented as unavailable (and a queued-cancelled prompt as possibly having no record) in `CHANGELOG-metering.md`; detail pruned handled (above) |

## Mutations (each reverted; the three native metering test files, 21 tests)

| Mutation | Result |
| --- | --- |
| the cursor advances over an unmeasured attempt | fails |
| gap not blocking the cursor | fails |
| no write-ahead staging | fails |
| no restore at open | fails |
| partial flag dropped from the accrual | fails |
| **the cursor advances without a confirmed terminal turn** | **passes** |
| **no de-duplication in `record()`** | **passes** |
| **no recovery at close (`recoverNativeClose` skipped)** | **passes** |
| **the cursor ignores its `channelKey`** | **passes** |

The last four are untested behaviours; add a test for each (a turn without a terminal outcome must not advance the cursor; a second `record()` for a committed operation must not commit again; a close must restore a pending record before accruing; a cursor saved for one channel key must not be used for another).

## Findings

1. **Important: a paid turn's usage is silently lost when the database fails during staging, and nothing marks the loss.** The write-ahead record protects only a failure of the *final commit*. In my probe I made both the staging write and the commit fail for turn 1 (then restored the database and either kept the process or reopened): the next turn completed and the persisted state was **operation count 1 and 220 tokens instead of 330**, no pending record, no cursor. The turn's calls are still in the harness ledger, but later closes read only their own turn id, so the earlier rows are never accounted, and the next record carries no flag that earlier calls exist on the channel. (It is the same failure that a late-sealed attempt of an earlier partial turn would hit.) Fix options: at a close, count sealed same-channel calls of earlier turns found while scanning from the cursor and either account them as unallocated or at least record `unaccountedEarlierCalls` in that operation's `nativeUsage`, so the loss is visible; and say in the report that write-ahead covers commit failures only.
2. **After one gap the cursor never advances again, so every later close rescans from the gap.** My probe: a partial turn, then eight normal turns: every close read `after: 1`, and the persisted cursor stayed `1` throughout (coverage `partial`). That is by design ("keeps the cursor behind the gap"), but it makes the cost of every later close grow with history since the gap, and the reader's 1,000-page budget (100,000 calls) would then make closes fail as unavailable. It also means the partial turn's later-sealed attempts are never counted. Decide how a gap is retired (resolved when its turn is re-read as sealed, or acknowledged explicitly) before 3a.
3. A pruned replay hands the live caller a synthesized "unavailable, detail was pruned" record when the operation was already committed; correct, but only reachable through a crash replay, so it is worth one line in the changelog.
4. The four test gaps above.

# Part 4 — R5 step 2b follow-up (`9fb2b2e..4bbefcb`): retirement, earlier evidence and SQLite schema 21

`3ef44c2` (code) and `4bbefcb` (report). I used a clean `git archive 4bbefcb` (`/tmp/clad2a-r5d`, `TMPDIR` on `/dev/shm`) and a second archive of alpha `173e4e7` (`/tmp/clad2a-alpha`) to write a real schema-20 database. Probes and mutations ran only in those archives.

**Verdict: the follow-up fixes the loss I found and the schema change is safe. 2b can be approved, with one design point you should decide knowingly (the 110 earlier tokens are visible on a record but are in no aggregate), and two small notes.**

- **Typecheck clean. Full suite: 1,646 pass, 0 fail, 154 files**, 35 snapshots (none changed; A1 unchanged). Harness suites **367 pass**, no leftover process.
- **Sizes:** `agent-session.ts` **4,492** (≤ 4,493) and `metering/engine.ts` **1,038** (≤ 1,051); `client.ts` 1,046, `controller.ts` 764, `native/host.ts` 909, `native/controller.ts` 599, `conversation-manager.ts` 1,012, `agent.ts` 563: all at or below their ceilings. New: `retirement.ts` 73, `durability.ts` 110, `ledger.ts` 100, `operation.ts` 83, `native/metering.ts` 12.
- **Each of the seven new tests and the four strengthened ones: 20 / 20 in isolation** (each `-t` matched one test), and the touched files whole-file **20 / 20** (`metering-durability`, `metering-native-source`, `orchestrator/workers`, `worker-delivery-repository`, `persistence-sqlite-backend`).

## SQLite schema 21, checked like R1's

| Check | Result |
| --- | --- |
| **Additive and idempotent** | One column, `metering_records.native_metering_proof_json TEXT` (nullable). `CREATE TABLE IF NOT EXISTS` carries it for fresh databases; for existing ones the migration runs `ALTER TABLE … ADD COLUMN` only when `PRAGMA table_info` lacks it, **unconditionally of the version row**, inside the same `BEGIN IMMEDIATE` transaction, and inserts the `21` row only when `version < 21`. No index or statement in the base schema references the new column before the `ALTER` |
| **A REAL database written by alpha `173e4e7`'s source (schema 20), opened twice** | I wrote it with alpha's own code: an Agent with an ACP conversation (a prompt, so a metering row) and a worker whose result was delivered (worker assignment and delivery rows). It had schema 20, two metering rows, one worker assignment, no proof column. With the new source, **two successive opens**: versions `20,21` (one `21` row), the column present, **every other table byte-identical** (I compared all table contents except the new column, after each open), the worker's staged delivery still `delivered`, the worker list intact, the old metering row readable through `operationIdentity` with **no proof invented** for it, and a new prompt after the upgrade completed and wrote its record. 0 rows have a proof (none were native) |
| **A fresh database** | schema 21, column present |
| **The chain 16/18 → 21 and the early-state repair** | The existing upgrade tests were updated to the constant and pass: workers from 16 and 18, the worker repository from 16, 17 and "early 17", the early schema-17 repair, and the new `SQLite v20 upgrades native metering proof…` test (it simulates v20 by dropping the column from a v21 database, which also exercises the unconditional column check). All 20 / 20 |
| **Open order with worker delivery (20) and the orchestrator (19)** | The version-gated blocks (`< 17`, `< 18`, `< 19`, `< 20`) are unchanged and run before the new column check, which doesn't depend on any of them |
| **What exactly is stored** | A small JSON object per native operation: the measured attempt ids (`["1:0"]`, `[]`) and, when a close preserved earlier calls, for each call its call id, turn id, attempt ids and counts, the token sums when they were known, and a reason string. Observed rows: 37, 32 and 212 bytes. **No message content, no raw usage payload, no secrets.** It is stored whether or not detailed records are kept, which is why it survives pruning. **Bound:** not capped; it grows with the attempts of one turn (a few bytes per attempt) and up to 100 earlier turns per close, which is small in practice but worth a ceiling if a turn can have thousands of attempts |
| **Old rows without the proof still work** | Yes: the proof is read only for native operations; an old complete record falls back to its retained calls, an old partial one is treated as "proof unavailable" and its tokens are **not** re-attributed (no double count), as the test checks |
| **Downgrade** | Alpha's code refuses a schema-21 database ("incompatible … recreate the database"), as for any newer schema; fine, but state it in the changelog if deployments mix versions |

## My probes, re-run

All over a real stdio harness with SQLite triggers for the failures.

| Probe | Result |
| --- | --- |
| **Both writes failing, in-process and after a reopen** (triggers on the state save and the record insert, then removed) | Turn 1 rejects; turn 2's record shows its own 220 and `unaccountedEarlierCalls: [{ call 1, tokens 110 }]`; turn 3 then 33. **The earlier 110 is visibly attributed, not lost, and not repeated on turn 3.** Same in both modes |
| **Several closes after a gap** (a partial turn, then eight normal turns) | **Bounded:** every close read `after` = the previous cursor (`3, 4, 5 … 9`), one request each, and the persisted cursor advanced each time (`3 … 10`). The gap is retired when the partial turn's row is recorded as unmeasured on a terminal turn, so the permanent rescan from my earlier probe is gone |
| **A late-sealed attempt of a partial turn** (the call hidden as running at turn 1, visible after a reopen; detail retained) | Turn 2's record carries the late call once (`2:0`, tokens 30); turn 3 carries nothing: **counted once**. The test for the pruned variant also passes |
| **A failed save during retirement** (staging works, the final commit fails on the turn that retires the earlier evidence) | The pending record holds the earlier evidence; reopening **twice** commits it **once** (one metering row, no change on the second reopen); turn 3 doesn't repeat it (1 of 2 records carries the evidence) |
| **Two channels closing at once, with a double failure on one channel** (triggers scoped to alpha's conversation) | Beta untouched: **224 = 77 + 147 exactly**, coverage `complete`, cursor 4. Alpha's next record carries its lost turn's 1,001 tokens as earlier evidence, totals 2,002 |
| **The cursor ignoring its `channelKey`** | Now fails a targeted test (`native cursor requires channel ownership…`); a cursor saved for another channel is not used |
| **Double counting between the retired evidence and a record** | None found: the earlier call's attempts that an operation's proof already attests are excluded (`already` set), a call with no proof contributes evidence but no tokens, and a replayed close finds the committed operation first |

## Mutations (each reverted; the three native metering files, 28 tests)

| Mutation | Result |
| --- | --- |
| cursor advances without a terminal turn | **fails** (was a survivor) |
| no dedupe in `record()` | **fails** (was a survivor) |
| no recovery at close | **fails** (was a survivor) |
| the cursor ignores its channel key | **fails** (was a survivor) |
| earlier turns retired without terminal proof | fails |
| accounted attempts not excluded (late-sealed double count) | fails (3 tests) |
| the proof not persisted | fails (2 tests) |
| earlier evidence dropped | fails (4 tests) |
| an earlier unmeasured row's tokens counted | fails |

## Notes

1. **Design point for you to confirm: the earlier tokens are visible, but in no aggregate.** In the double-failure probe the persisted totals after turn 3 are **count 2, known 253 = 220 + 33**; the 110 is in turn 2's `nativeUsage.unaccountedEarlierCalls` only, and `unallocatedUsage` is empty. The coverage is `partial`, so a consumer is told the total is a lower bound, but anyone summing `state.totals` (the usual limit-enforcement input) misses 110, and "330 expected" in your brief is true of the evidence (110 + 220), not of the state. The engine already has an `unallocated` accrual for usage that belongs to no operation; accruing the earlier tokens there would put them in an aggregate as well as in the record. If "recorded separately" is the intended design, the changelog should say that totals exclude earlier unaccounted calls.
2. **The proof column has no explicit size bound** (see the table).
3. The report's disk-backed focused trials hit `session/create` timeouts before the RAM-backed gate; I saw none, but note that these are heavy tests on a slow disk.
