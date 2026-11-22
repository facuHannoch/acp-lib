# Review — R1 step 0 grounding

This review covers `1bac66c` (`library/reports/11-22-REPORT-R1-grounding.md`) on `native-integration-r`, against
`44bbc25`. I read it through `git show` and the reviews worktree (also at `44bbc25`); I didn't check out the branch.

**Verdict: the grounding is accurate, and I agree with the asynchronous recommendation (no mirror). No blocking
findings.** I add four points the report doesn't cover: (2a–2d). For the open points, (a) is an implementation
detail if the change is additive. (b) and (d) need a spec-owner decision: I give a recommendation for each. (c) is
the rule the spec already implies, so it should only be stated.

## (1) Grounding: line references and drift

I checked these against `44bbc25`, and they're all correct:

- **Host size:** `host.ts` is 984 lines, not the spec's 761.
- **Host line references:**
  - the cutoff at L431–435 (`pendingChanges()` at L433);
  - the compare-and-clear at L438–447;
  - the post-open scan at L576–590;
  - the running transition plus `#afterOpen()` at L357–361;
  - `changeChannel`/`#flushChange` at L771–790;
  - the direct operator `suspendChannel`/`resumeChannel` at L895–896.
- **Manager:** `conversation-manager.ts` is 1,098 lines. The delete retires at L636 and soft-deletes separately at
  L640. L887 is the creation-time title/policy intent.
- **Exports:** `index.ts` L268–269 exports both factories and `NativeHostRecords`/`PendingChange`/`ChannelDesire`.
- **SQLite:** `transaction` at L281–298 (one queued writer, `BEGIN IMMEDIATE`, scoped repositories, commit or
  rollback). The schema is version 16 at `sqlite-schema.ts:5`.

The drift noted in the report is right. The spec's `session/load`/`channel/update` wording predates operator
controls: the open now goes through `session/open` (or `session/create`), and live changes go through the
create/edit/suspend/resume/delete methods. **The spec owner should update the "code as it is" in Brief R1 and the
wording in "Durable channel intents"** (761 → 984; the method names).

The report found a further problem, and it's correct: a **committed-read boundary**. The backend has one SQLite
connection. A read issued outside the write queue while a transaction's work callback is awaiting (for example,
the host reading pending changes) sees that transaction's *uncommitted* rows. If it delivered a retirement it saw
that way, and the transaction then rolled back, the harness would retire a conversation that still exists. So host
reads must go through the queue (or some other committed-only path). This is required for step 3, not optional.

## (2) The asynchronous recommendation versus a mirror

**It avoids two writers.** On a backend with `capabilities.channels`, the repository is the only store of channel
intents. The delete writes `{ lifecycle: "retired" }` and the soft-delete through the same transaction scope. The
host learns of the intent only after the commit, either by the manager scheduling delivery or by the host's next
committed read. A rollback leaves nothing for the host to send. With a mirror, memory would be a second writer
and would need to be reconciled after commit and after rollback. That's the risk the spec names. **I agree with
the asynchronous design.**

**Both ordering constraints are right.**

1. *Per-channel edit order registered before any await.* Today `push` relies on a live edit already being queued
   on `#enqueue(channel, …)`, so the input can't overtake it. If `changeChannel` awaits a repository write before
   calling `#enqueue`, a `push` in that gap would reach the harness before the edit. So the channel's queue slot
   has to be taken synchronously, with the durable write done inside that slot or before it, but still ahead of
   any later push.
2. *Startup cutoff in `#afterOpen` (L357–361 → L576–590).* Today the state flips to `running` and the post-open scan
   runs synchronously. Nothing can come between them. With an asynchronous scan, an intent committed during the
   scan could be:
   - missed: the scan read already happened, and `changeChannel` saw `running` and assumed the live path would
     cover it;
   - or ordered after a newer input.

   A barrier, so that the transition to "accepting input" happens only after the scan *and* any intents committed
   meanwhile are queued, is the right fix.

**Points the report doesn't cover:**

- **(2a) Delivering a committed delete must not mint a version.** The report says "without calling `desire`
  again". The concrete shape: the delete transaction returns the version the repository assigned, and the manager
  passes `(channel, version)` to a host method like `deliverCommitted(channel)`. That method reads the newest
  pending change through the committed path and sends it. A newer edit committed in the meantime must win. That's
  already how `#flushChange` loops, so reuse it.
- **(2b) The creation-time intent (L887) should also be in the creation transaction.** The spec says that "All
  intents go through it from the start". Otherwise a created conversation whose title/policy intent write failed
  becomes an open channel with the default policy. That's a smaller version of the same gap. If the creation path
  has no transaction today, it's acceptable for R1 to write the intent right after the creation commits and
  document that. Either way, state it in the step 3 report.
- **(2c) Writes can now fail.** `changeChannel` can now reject when the repository fails. Today the synchronous
  memory write never fails. Callers (L636, L887, the operator conveniences) need to propagate that rejection and
  not return `{ state: "pending" }`. Add one test: a failing channel write rejects `changeChannel` and queues no
  delivery.
- **(2d) The version allocator.** The report already says it must stay durable even when no pending row remains.
  Add a concrete check to step 1's tests: merge, clear, restart (reopen the database), merge again, and the new
  version is greater than the cleared one. Otherwise a late acknowledgement from before the restart could clear a
  new desire.

## (3) Open points

| Point | Recommendation | Who decides |
| --- | --- | --- |
| **(a) Public compatibility.** `NativeHostRecords` and both factories are exported. Synchronous `pendingChange(s)` reads exist only in **tests** (`checkpoint.test.ts`, `host.test.ts`, `controller.test.ts`). No library code reads them outside `host.ts`. | **Make it additive:** keep `NativeHostRecords` and both factories as they are (synchronous) for the no-repository case. Add an internal asynchronous `ChannelIntentStore` interface that the host uses. A small adapter wraps the synchronous records for the memory fallback, and the repository implements it directly. Keep `host.records` for submissions. For channel reads, add an asynchronous `host.pendingChannelChanges()` and move the tests to it. Under a durable backend, `host.records.pendingChange(s)` must not report stale data: either make it throw (a clear error) or document that it covers the memory fallback only. I'd pick throwing. | **Implementation detail** if additive as described. Breaking the exported type would be a **spec-owner/user** call, and it isn't needed. |
| **(b) File-store pending changes under a durable backend** | **Ignore the file's channel half, log a warning once if it holds pending changes, and document it.** Don't import. An import on every open would replay stale desires over newer repository ones. A one-time import needs a marker in the file, which `createFileHostRecords` would then also have to write. That's design growth for a store with no library callers (only `host.test.ts` uses it). Rejecting at `Agent.open` would block an otherwise valid configuration just to protect against a migration nobody needs. | **Spec owner** (behaviour of a public option). Recommend "ignore + warn + document" in Limitations. |
| **(c) Explicit `harness.records` must not override the repository for channel intents** | Agreed, and it follows from the spec's "one writer, the repository". Rule: with `capabilities.channels`, channel intents always use the repository. A caller-supplied `records` still supplies submissions. Without the capability, a supplied `records` keeps today's behaviour for both halves. Test it: an Agent with SQLite plus explicit memory records sends a delete's retirement from the repository after restart. | **Implementation detail.** The spec should state it in one line under "Durable channel intents". |
| **(d) Operator `suspendChannel`/`resumeChannel` (L895–896)** | Route them through the durable path, with `changeChannel(channel, { lifecycle: "suspended" / "open" })` committed first and then delivered live, and keep their return contract by returning the live channel status once delivered. Two cases have to be pinned in tests: (1) **the harness is stopped:** today they throw, because there's no client; afterwards they record a pending intent. That's a contract change, and I think it's the better one, but someone has to decide it. (2) **a pending `retired` desire must not be downgraded.** Suspending or resuming a channel whose newest desire is `retired` must be refused, or leave `retired` in place. Otherwise an operator click could resurrect a deleted conversation's channel. The internal suspension used to block a busy retirement stays outside the intent path, as the report says. | **Spec owner** for (1), stopped harness: throw as today, or record a pending intent. (2) is a correctness rule, and the spec should state it. |

## Baseline

The report's baseline (typecheck clean, `bun test ./test` with 1,426 tests in 132 files, green) is from cod2a. I didn't
rerun it, because step 0 changes no code.
