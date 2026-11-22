# Review — R1 step 4 and the final review of R1 (durable channel intents)

This review covers step 4 (tests `be36dfc`, report `79d449d`) and the whole of R1 (`44bbc25..79d449d`) on
`native-integration-r`. I read them through `git diff`/`git show` and clean `git archive` copies; I didn't check out
the branch.

**Verdict: R1's code is complete and correct, with no blocking findings.** Step 4 holds. The brief's Done holds.
There's one writer of channel intents per mode, and the extraction left no dead code. **Docs need small
additions before release:**

- the changelog is missing three entries (see "Changelog");
- the Limitations section is missing two lines (see "Limitations");
- the spec text needs a few updates for the spec owner.

## Step 4: the restart tests

- **A real stdio harness.** Every case uses `rigWith()`/`traceStdio`: a scripted harness spawned as a child
  process over stdio. One case checks `trace.children[1].child.signalCode === "SIGKILL"`, from the storage fault
  `deleteChannel:1`, which kills the real process after the delete commits and before it replies. No in-process
  stand-in is used.
- **A real restart.** Each case calls `first.close()` and then `rig.open()`, a new `Agent` over the same SQLite path,
  and asserts against the durable state (`second.persistence.channels`) before starting the harness.
- **Waits are on events.** The busy case waits on channel events (`tool_call started`, `channel_state suspending`)
  through `waitForChannelEvent`, which has a 10 s limit. The held tool is released by its file gate. There are no
  sleeps.
- **What each case asserts:**
  - *Stopped retirement:* the pending row survives the restart and is applied at open. `expectRetired` checks the
    channel is `retired` with nothing pending and no active turn, that a push rejects `channel_retired`, and that
    the history is unchanged.
  - *Replay after the crash:* the same `changeId` is in the next `openSession` batch and is acknowledged `applied`,
    and there's exactly one agent message, so nothing ran twice.
  - *Busy retirement:* the delete is blocked `channel_busy` with the same version, the row stays pending,
    `resumeChannel` rejects `channel_retired` with no RPC, and the channel is still `suspended` with
    `pending: ["busy-queued"]`.
  - *The three stored-kind cases:*
    - an unused channel created by another conversation's open: retired, and its history is empty;
    - deleted before the first open: no child process until the open, then a **retirement-only** `createSession`
      batch that gets `applied`, the channel `retired`, an empty timeline, and no `turn_started` on the wire for it;
    - no title or policy: retired.
- **The former probe fails on `64060fa`.** I took the `be36dfc` tests with `64060fa`'s `src`: **4 of 6 fail.** The
  failures are the busy case, the unused/realized case, the before-first-open case, and the no-settings case. The
  two that pass (stopped retirement and the crash replay) involve a prompted conversation, which has a provider
  session, so `64060fa` already handled them. On `be36dfc`, 6 of 6 pass in two runs (4.3 s each).

## The brief's Done holds

| Done item | Status |
| --- | --- |
| Commits | Listed per step in the report |
| Test count and time | 1,463 tests in 132 files, 89.5 s (RAM-backed; I recommended accepting that at step 2); 35 snapshots unchanged |
| Sync/async decision | Asynchronous channel store, no mirror (step 0, reviewed) |
| Schema change | 16 → 17: `native_channel_intents`, the clock, nullable `conversations.controller_kind`, and the repair of early 17 databases on every open |
| `host.ts` / `conversation-manager.ts` line counts | 984 → 884 and 1,098 → 1,089 |
| Must not touch | No diff under `src/native-harness/` (harness and wire untouched). The submission half is delegated unchanged (`submissionRecords` only forwards it) |

## One writer of channel intents

Every `desire`/`confirmChange` in `src` goes through one of these:

- **The host's single store, `NativeChannelChanges.store`:**
  - with `capabilities.channels`, it's the repository wrapped by `protectPendingRetirement`;
  - otherwise, it's `channelStore(records)`.
- **The scoped repository inside the create or delete transactions** (`native-channel-lifecycle.ts:51, 81`).

`host.records` refuses channel calls under SQLite, and `harness.records` supplies submissions only. **There's no
second writer.**

One small note: `conversation-manager.ts:880` (`start`, when `!channelIntentCommitted`) still writes the initial
desire through `changeChannel`. That's for the fallback, and for a start that isn't a creation. It goes to the same
store, so it isn't a second writer. At worst it restates the title or policy with a new version, which is harmless.

## Dead code

None found.

- `toWire`, the host's `#enqueue`/`#flushChange`/`#applyLive`/`#blockedVersions` and its
  `codeOf`/`ambiguous` moved out of `host.ts` and were removed there.
- The remaining imports in `host.ts` (`ChannelChangeResult` at L112, `PendingChannelChange` at L506) are used.
- `HarnessIncompatibleError` and `normalizeHandoffContinuation` were moved, not copied.

## Changelog

`CHANGELOG-controller-interface.md` **covers:**

- the stored `controller_kind`, including the 16 → 17 migration that leaves older rows unset;
- the kind-switch refusal with `UnsupportedError`;
- `beforeDispatch` with per-message ids;
- `messageIds` on `afterPrompt`/`promptFailed`;
- the native media and fresh-handoff refusals.

**It's missing:**

1. **Durable channel intents:** the optional `channels?` repository (`ChannelPersistence`, exported) and
   `capabilities.channels`. With it, a native conversation's delete and creation commit with their channel intent.
   The intent is delivered after the commit, and a pending retirement wins over suspend/open.
2. **A host API change for consumers:** under a durable backend, `host.records`' channel methods now **throw**.
   Channel reads move to the new `host.pendingChannelChanges()`, and `harness.records` supplies submissions only.
3. **`HarnessUnavailableError.code`:** the six values (`not_running`, `failed`, `stopped`, `open_timeout`,
   `start_failed`, `reopen_failed`). Also: operator `suspendChannel`/`resumeChannel` now *reject* (they're
   asynchronous) with `not_running` while stopped, and **`resumeChannel` rejects `channel_retired` while a retirement
   is pending.**

## Limitations

The spec's Limitations **has:**

- offline changes are eventually applied;
- legacy rows and custom backends rely on fallback detection;
- the file store's pending channel changes are ignored under a durable backend;
- submissions don't survive a restart.

**It should add:**

1. **Retired tombstones in the harness.** A conversation deleted before its channel ever existed still makes the
   next open create the channel and retire it at once. That's the `createSession` batch in the before-first-open
   test. The harness keeps one retired channel per deleted native conversation, with an empty timeline. It's
   harmless, but it grows.
2. **The memory fallback.** A backend without `capabilities.channels` keeps channel intents in the configured host
   records, which are in memory by default. A restart loses them, and a delete isn't atomic with its intent. That's
   stated in the design text (L654) but not in Limitations.

## For the spec owner: updates to the spec text

- **Brief R1, "The code as it is":**
  - `host.ts` is 984 lines (not 761) at the baseline, and 884 after R1;
  - the line references (344/352/468) are stale;
  - the wire terms are `session/open`/`session/create`, not `session/load`.
- **Brief R1, steps:**
  - step 1's repository also got the controller kind (step 3b) and the repair of early 17 databases;
  - step 3 also covers the creation transaction, the precedence of a pending retirement, and the operator resume
    guard;
  - step 3b (the stored kind, refusing cross-kind switches or opens) isn't in the brief at all.
- **"Durable channel intents":**
  - add the stored `controller_kind` as how a delete identifies a native conversation;
  - add that cross-kind switches and opens are refused;
  - item 1's "SQLite first; a schema version bump" should name schema 17 and the repair on every open;
  - item 3's "a blocked retirement … is reported as blocked" should add that operator resume is refused while it's
    pending.
- **Boundaries:** add the retired tombstone (Limitations item 1 above).

## Not run by me

I didn't run the typecheck or the full suite. cod2a's RAM-backed gate (1,463) stands. My evidence is the step-4
tests on `64060fa` (4 expected failures) and on `be36dfc` (6 of 6, twice), plus reading the code.
