# Final check: R9 (`scratch/r9-sdk-e594870` at a55b574)

Reviewer: clad2a-s. Clean `git archive` of a55b574 on `/dev/shm`; no `src/` edits; probes and mutants on separate copies.

Verdict: **approve. No open findings from my R9 reviews.** B1' is fixed and pinned; the three `discardExhausted` guards are now tested; the guide additions are accurate.

## Gate

- Root `tsc --noEmit`: exit 0. Harness `bun run typecheck`: exit 0.
- Plain `bun test`: **2,191 pass / 0 fail, 226 files, 35 snapshots.**
- Joint one-off real-stdio file: **20/20** (12 tests each).
- The three new tests (frozen batch + session loss, running-host guard, memory discard scope and high-water), each 20x in isolation: **60 runs, 0 failures.**
- `src/native-harness/` vs the combined base `70b1a5d`: empty diff. host 909, native/controller 591, agent-session 4,527. The only source change in this commit is one line in `recovery.ts` (the `frozen && !replacement` veto removed), plus tests and the guide.

## B1' re-run and the create path

I re-ran my reproduction and two neighbours through the real `openOrCreate` with the scripted routine peer (a stored batch of one entry for reminder `keep`):
- **a. Not-exhausted frozen batch, session lost:** calls are `open, create`; the create carries exactly `[keep, 1]` (the frozen entry); afterwards the frozen batch and the marker are both cleared.
- **b. Exhausted frozen batch, session lost:** `open, create`, start succeeds.
- **c. Frozen batch, session lost, the create fails without publishing (`transport_closed`):** the start fails with that error; the marker and the frozen entry are kept; the next start does `open, create` again and succeeds; the reminder is applied once (row text `edit`, journal entries for it 0), so no veto and no duplicate application.
Mutants: restoring the `frozen && !replacement` veto: **killed** (the new frozen-batch test); restoring the marker veto (`replacement` in the condition): **killed** (the interrupted-create test).

I found no remaining path where a marker or a frozen batch blocks a create: the only conditions that stop a create now are a storage failure already in progress in this start (the frozen batch goes through open then) and an error other than `not_found`. Duplicate minting is not possible on these paths because entries keep their original ids and change ids, the retry is the stored frozen set, and live retries reuse the saved id (unchanged and still covered).

## discardExhausted guards (mutants)

- Conversation scope removed: **killed** (memory test: a different conversation gets `false` and the frozen entries are untouched).
- Host-state guard removed (`stopped`/`failed` only): **killed** (the running-host test).
- High-water decremented on discard: **killed** (the memory test asserts `highWater` unchanged and that the next enqueue gets `changeId + 1`).
- Dropping the `exhausted` requirement: killed (two tests). Discarding more than the chosen reminder, or clearing the remainder: killed (earlier).

## Guide

The recovery paragraph now says the harness does not identify the failing entry, recovery is by elimination (discard one reminder, start again, repeat), `discardExhausted` returns `true` only when it removed that reminder's frozen entries, later pending entries for the same reminder stay and can come back `blocked/not_found` (cleared with `discardBlocked`), and that discard removes local intent only: a create that already committed can still fire, shows up as a confirmed row after the next sweep, and a new id would be a duplicate. All of that matches the code and my probes.

Nothing further to fix. Residual notes, all accepted: the host-state check is not atomic with the write, and routine real-stdio acceptance still waits for the approved harness runtime.
