# Review — R1 step 3: delete and creation with their channel intents

This review covers implementation `c600199` and report `49b5a1c` on `native-integration-r` (diff `7be9456..49b5a1c`).
I read them through `git diff`/`git show`; I didn't check out the branch.

**Verdict:**

- **The transaction work is correct.** One transaction, scoped repositories only, delivery after the commit with no
  second version, rejections propagated. The rollback tests really fail the intent write, and the reverse case is
  covered.
- **One should-fix within step 3's own scope, finding 1:** the live operator `resumeChannel` ignores a pending
  retirement.
- **The never-prompted gap is real, and it's wider than the report says (finding 2).** The proposal of keeping
  channel rows is sound, *if* it comes with two additions: always register a native conversation's channel when
  it's created, and clear the desire when a change is confirmed.

## Checked

- **Delete in one transaction.** `deleteConversationWithChannel` (`agent/native-channel-lifecycle.ts`) runs
  `scope.channels.desire(id, { lifecycle: "retired" })`, then the checkpoint delete and
  `scope.conversations.delete`, all on the transaction **scope**. It never touches the root repository, so it can't
  wait on its own transaction. Without the capability it keeps the old order (`changeChannel`, then delete) as the
  documented fallback.
- **Creation in its transaction.** `createConversationWithChannel` writes the row and the initial desire in one
  transaction. `start()` then skips its own `changeChannel` (`channelIntentCommitted`), so no second version is
  minted.
- **Delivery after commit, with no second version.** `deliverCommitted(channel, commit, running)` registers the
  write (`#trackWrite` bumps `#revision`, so a startup scan running at the same time rescans) and takes the
  channel's queue slot *synchronously*. Then it awaits the commit and, if the harness is running, calls
  `#deliverPending`, which is the existing `#flushChange`. That reads the committed version through the committed
  path and sends it. If the harness isn't running, the intent waits for the next open's batch.
  - A failed delivery after the commit is logged and the intent is left in place, which is correct, because the
    local commit is what counts.
  - The test "a running harness receives one retirement after its transaction commits" holds the transaction open
    and pushes in the meantime. It asserts there's no `deleteChannel` before the commit, exactly **one**
    `deleteChannel`, that it reaches the harness before the push, that the push rejects `channel_retired`, that
    version + 1 is the retirement, and that nothing is left pending.
- **A pending retirement wins over suspended/open.** `protectPendingRetirement` wraps the host's root store. For
  `open`/`suspended` it reads and conditionally writes in **one** root transaction, and returns the existing
  retirement unchanged. `change()` then reports `{ blocked, channel_retired }`. The test checks that both later
  edits are blocked and the retirement row is unchanged.
- **Rejections propagated.** A transaction rejection rejects `deliverCommitted`'s queued job, which the delete or
  create caller awaits.
- **The rollback tests really fail the write:**
  - *Intent write fails:* the scoped `desire` **performs** the write, then throws. The test checks the delete
    rejects with that error, the conversation is still present with no `deletedAt`, nothing is pending, and it
    reopens and prompts normally.
  - *Reverse case:* `delete(..., { deletedAt: "invalid" })` makes the conversation delete throw *after* the
    retirement was written. The test checks the conversation is kept and the initial intent is restored exactly.
  - *Creation:* the desire is written, then throws. The test checks there's no row, no intent and no launch.
- **Sizes:** `host.ts` goes from 887 to 884 lines, `conversation-manager.ts` from 1,098 to 1,092. The new
  `native-channel-lifecycle.ts` is 78 lines. Moving `HarnessIncompatibleError` into `errors.ts` is a pure move,
  re-exported.

## Findings

### 1. Should fix: the live operator `resumeChannel` can reopen a channel whose retirement is pending

`host.ts:795–796` still sends `suspendChannel`/`resumeChannel` straight to the live client. `protectPendingRetirement`
only guards `changeChannel`.

**Scenario:**

1. A busy native conversation is deleted.
2. The live retirement gets `channel_busy`, so the harness suspends the channel and the `retired` intent stays
   pending (blocked).
3. An operator calls `host.resumeChannel(id)`.
4. The channel reopens, and its pending input runs on a conversation that no longer exists in acp-client.

That's the spec's gap of "a later turn … on a channel nobody sees", and decision (d) said operator suspend/resume
"cannot overwrite a pending retirement". The intent row survives, but the effect is overwritten until the next
open.

**Fix (small):** in `resumeChannel`, read `pendingChange(channel)` from the active store. If its lifecycle is
`retired`, reject with `channel_retired` or return blocked, before calling the client. `suspendChannel` can stay as
it is, since it's harmless. Add a test for the running case; the existing one covers only the stopped case.

### 2. The never-prompted gap is real, and it's wider than reported

**How delete decides a conversation is native:** `isNative` comes from `providerSessions.active(id)?.adapterId ??
live?.adapterId`. A native conversation never has a provider session of its own, so after a restart a
**never-prompted** native conversation that isn't live isn't recognised as native, and no retirement is written.
cod2a's probe shows the result: the channel stays usable.

The gap is actually wider:

- **(i) The initial intent is still pending when the conversation is deleted.** The harness never opened, and the
  conversation was deleted after an acp-client restart. The delete isn't recognised as native, so it writes
  nothing, and the creation intent stays in the repository. **The next open creates a channel for a deleted
  conversation.**
- **(ii) A native conversation created with no title and no `defaultPolicy`.** No initial desire, so no row. The
  harness creates the channel the first time something is pushed. After a restart and before a prompt, it's the
  same as (i) or cod2a's case, just with no row at all.

**Is "keep channel rows after confirm, marked applied" sound?** Yes. It's the most natural fix inside R1: the
`channels?` repository becomes the registry of which conversations are native. Schema 17 hasn't been released yet,
so its table can be amended in place without another migration. To close all three cases it needs:

1. **Always register a native conversation's channel when it's created**, in the creation transaction, even with
   an empty desire. That closes (ii).
2. **On confirm, keep the row but clear it:** `desire_json = '{}'`, plus an `applied` or `pending = 0` flag. Don't
   keep the merged desire. If the full desire were kept, every later edit would restate all old fields (an old
   `suspended`, the name, the policy) in the next batch, and that's a change to today's wire behaviour.
   - `pendingChange(s)` and the startup batch read only pending rows.
   - `desire` on an applied row starts from `{}` and flips it back to pending.
   - The version clock is untouched.
3. **Delete decides "native" from the repository, inside its transaction:** `isNative ||= capabilities.channels &&
   await scope.channels.known(id)`, where `known` is a new read that also sees applied rows. That closes cod2a's
   case and (i).
4. **Leave rows for retired channels as applied tombstones.** They're harmless, and they make a second delete a
   no-op.

**Cleaner alternatives, and why I'd still pick the registry:**

- *Store the adapter id on the conversation row.* This is more general, since ACP could use it too. But it changes
  `conversations` (the shared schema and every backend), and it still needs (1) for conversations created before
  the change. It's outside R1's channel scope.
- *Write a retirement on every delete whenever a native harness exists.* For ACP conversations, the harness would
  then create a channel only to retire it (the open batch creates unknown channels). It pollutes the harness with
  tombstones. No.
- *Record a provider-session descriptor for native conversations.* That puts native into the continuation and
  provider-delete paths, which deliberately exclude it. It's risky.

**Limits that still apply:**

- **Older native conversations:** ones created before R1, or under the memory fallback, have no row. That's a
  limitation to document, or the fix could include a one-time backfill, but there's no source to backfill from, so
  documenting it is what's left.
- **Memory fallback:** without `capabilities.channels`, the registry doesn't exist. Today's behaviour stays, and
  the spec already documents that.

**Who decides:** the user, as core-p has proposed. My recommendation: adopt the registry, with (1)–(4), as an R1
follow-up step before step 4. Step 4's restart tests should then include cases (i) and (ii), and cod2a's
never-prompted case.

## Not run by me

I didn't run the typecheck or the suites. cod2a's gates stand.

## Follow-up: the resume guard (`64060fa`)

Finding 1 is **resolved**. No blocking findings.

- **Change:**
  - `host.resumeChannel` now delegates to `NativeChannelChanges.resume`.
  - That method queues the work on the channel's queue. Inside the job, it reads `store.pendingChange(channel)`
    through the committed path (wrapped by `protectPendingRetirement` under SQLite). If the newest desire is
    `retired`, it throws `HarnessClientError("channel_retired")` before any RPC. Otherwise it calls
    `client.resumeChannel`.
  - The error is built by `pendingRetirementError` in `errors.ts`.
  - `suspendChannel` is unchanged, which is fine.
- **The test is an extended existing one, not a new test**, which is why the count stays at 1,451. The test is "a
  delete that finds pending work suspends the channel instead…" in `host.test.ts`, and it already runs for both
  memory and SQLite. After the busy delete it now asserts:
  - `resumeChannel` rejects `channel_retired`;
  - no `resumeChannel` RPC was sent;
  - the retirement intent is unchanged;
  - the channel is still `suspended` with `waitingForResume` and the same pending work.
- **It fails on the old code.** I took the `64060fa` tests with `49b5a1c`'s `src`: both variants (memory and SQLite)
  fail with "Expected promise that rejects / Received promise that resolved". On `64060fa` itself,
  `host.test.ts` gives 32 pass, 0 fail.
- **No race with a retirement recorded at the same time.** Retirements and resumes on a channel go through the
  same per-channel queue, and the check reads committed state:
  - *Retirement first* (a delete via `deliverCommitted`, or `changeChannel` while running): its job takes the slot
    synchronously, before its commit. The resume queues behind it and reads after the commit, so it sees
    `retired` and refuses. If the retirement was already applied and confirmed, the row is gone, but the harness
    channel is retired, so the RPC itself fails `channel_retired`.
  - *A delete transaction still open when the resume reads:* the committed read waits on the write queue, so it
    sees the retirement once it commits, never an uncommitted or rolled-back one.
  - *Resume first:* it runs before the retirement's job, and the retirement then applies, or suspends the channel
    if it's busy. That order is consistent.
  - *Harness stopped:* `this.client()` throws `not_running` before anything is queued (it's an async method, so it
    rejects), and the intent is untouched. That's the step 2 test.
- **Nit:** `resume` captures `client` before queueing. If the connection is replaced while the job waits in the
  queue, the RPC goes to the old client and fails with a transport error instead of being sent on the new one.
  That's harmless: the caller gets an error, and nothing changes. Resolving the client inside the job would be
  slightly cleaner.
