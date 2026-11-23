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
