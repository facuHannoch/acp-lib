# Review — orchestrator brief O1 (the pool and the workers table)

This review covers `4e88243..bf368b6` on `orchestrator`:

- `6a9ab88`, `8199b9a`: step 1;
- `6582fb1`: step 2;
- `4373fe7`: step 3;
- `6e0a72d`: step 4;
- `bf368b6`: the report.

I read them through `git diff`/`git show` and a clean `git archive bf368b6` (`/tmp/clad2a-o1`); I didn't check out the
branch. I wrote my own probes (`test/zz-probe/` in that archive).

**Verdict: O1 meets its brief. No blocking findings.**

- **Full suite on the archive:** typecheck clean, **1,521 pass, 0 fail, 140 files**, 35 snapshots; the characterization
  hash is still `fbc6ec2c…`.
- **Two robustness gaps** came out of my low-level probe. Neither is an O1 gate failure; both are small and both are
  best fixed in O5a (see "The low-level APIs").

## Against the brief

### Step 1: the repository, schema 19, the refusals

- **`workers?` holds only worker rows.** `WorkerPersistence` and the `workers` table have `handle`, `conversation_id`
  (unique, foreign key to conversations), `opened_by`, `about`, `last_conversation`, `created_at` and `dropped_at`.
  There are no assignment, result or notice columns. Those stay in `workerDelivery?`.
- **Schema 19 upgrades on real databases.** I wrote real databases with older code, opened them with `bf368b6`, and
  created a worker row:

  | From | Result |
  | --- | --- |
  | **18**, written by `4e88243`'s `src` | conversation kept; `workers` and `conversations.role` present; `schema_migrations` `[18, 19]`; the second open re-ran nothing |
  | **16**, written by `44bbc25`'s `src` | the chain to 19 works; conversation kept; `workers` and `role` present; `schema_migrations` `[16, 19]` (only the final version is recorded, as for earlier migrations); the second open is a no-op |

  Their own test also covers both starting points.
- **The three refusals.** `validateOrchestrator`, run in the `Agent` constructor, throws a `PersistenceCapabilityError`
  without `capabilities.workers` or `capabilities.workerDelivery`, and an error without message capture `content`.
  The limit must be a positive integer. cod2a's test covers each refusal.
- **A refused open doesn't leak the SQLite file.** I opened a file database with capture `metadata` (refused:
  `orchestrator requires message capture "content"`), then immediately reopened the same file: it opened normally,
  so the owner lock is released.
- **Capture is enforced per conversation as well.** The settings resolver rejects a worker whose per-conversation capture
  isn't `content`, before any write (test: "worker creation rejects a per-conversation capture override…").

### Step 2: the worker marker and identity isolation

- `role: "worker"` is persisted on the conversation row (`ALTER TABLE … ADD COLUMN role`, repaired on every open like
  `controller_kind`) and shown by `conversations.list()`.
- **Every call site into the identity runtime is guarded.** I grepped for them:
  - `identity.load` is skipped for a worker (the preamble is `{}`);
  - `identity.update` returns early;
  - `identity.delivered` runs only when a receipt exists, and a worker never gets one;
  - the built-in checkpoint-backed identity filters `role === "worker"` out of its source conversations.
  Workers can't adopt provider sessions and require an ACP adapter.
- **Tests:** the spy-runtime test shows `load` called only for the ordinary conversation, `update` only for the ordinary
  one, no preamble in the worker's prompts across a reopen, and an out-of-band append not reaching identity. The built-in
  identity test shows a non-worker conversation never sees the worker's text.

### Step 3: the pool

- **Racing opens.** All pool operations run through one serial queue. **My probe:** six simultaneous opens with `limit: 2`
  gave exactly two `sent` (`w1`, `w2`), **four `no_worker_free`**, a listing showing `w1:busy`, `w2:busy`, and exactly two
  rows. Handles come from the highest existing ordinal over *all* rows, dropped ones included, so they never recycle.
- **LRU eviction and reload of the same conversation:** `makeRoom` evicts the least-recently touched *idle* slot, emits
  `worker_stopped: eviction`, and `send` reopens the same conversation id (`worker_reloaded`). The test covers it.
- **`no_worker_free` with the listing:** yes. A busy worker is never evicted.
- The `busy` result for a send to a busy worker is O2's to extend, as planned.

### Step 4: the consumer API and events

- `agent.workers` has `list`, `check`, `stop` and `delete`. `stop` interrupts with `clearQueue`; `delete` interrupts, deletes
  the conversation and marks the row dropped (and still marks it if the delete half-completed). The test lists, interrupts
  and drops workers.
- **Events never synthesize a record.** `publishWorker` emits only to a separate `workerHub`; the record hub and its filters
  are untouched, and `subscribe`'s listener type is still record-only. Delivery sequence numbers are shared through one
  envelope function. `subscribeWorkers` is the only way to see worker events. The test checks that worker events stay
  distinct from records.
- **Untouched, as required:** `agent-session.ts` is unchanged at 4,564 lines. `orchestrator/` makes **no** call to
  `stage`, `transitionDelivery`, `reserve` or any flush; the only mention of `workerDelivery` is the capability check.

### Sizes and reuse

- `orchestrator.ts` 174 lines, `pool.ts` 81, `contracts.ts` 41, `config.ts` 22, `consumer-api.ts` 18,
  `sqlite-workers.ts` 59, `workers.ts` 19: all well under 400, one concern each.
- `conversation-manager.ts` 1,085 → 1,085, `client.ts` and `controller.ts` unchanged, `agent.ts` 528 → 545.
- Reuse is good: `workerTerminalFailure` for the failure reason, the existing settings resolver, manager `create/open/delete`,
  and the existing subscription hub and envelope.

## The low-level APIs: acceptable for v1, with two small fixes

cod2a's note is that slots count only pool-mediated dispatch, and the low-level `agent.conversations` APIs stay available to
trusted code. My probe (limit 1, two workers) shows the consequences:

1. **A direct reopen bypasses the limit.** `agent.conversations.open(<evicted worker's conversation id>)` puts a second live
   worker conversation outside the pool. The pool reports it `offline` while it's actually idle. This only happens with a
   direct call by trusted code, so **accept for v1**. Add a Limitations line: "`workers.limit` bounds pool-mediated work;
   a trusted caller that opens or prompts a worker conversation directly is outside it."
2. **A directly deleted worker conversation leaves a zombie row** (**should fix, in O5a**).
   - After `agent.conversations.delete(<worker conversation id>)`, `check` says `offline` and `list` keeps showing it as
     `offline`, with no `dropped_at` ever written.
   - `send` fails with "unknown active conversation".
   - The row never heals, and it's visible to every consumer.
   - Fix: where the pool opens a worker (`send`) or reads rows, treat a deleted or missing conversation as dropped and call
     the existing `markDropped`.
3. **A failed reload still costs an eviction** (**small, fold into the same fix**). In the same probe, `send` to the zombie
   first made room by evicting the other idle worker (`w2` became `offline`) and then failed to open. Checking that the
   conversation exists *before* `makeRoom` avoids the needless eviction.

## Notes (none blocking)

- **Rationale comments were trimmed to hold the line budget.** `conversation-manager.ts` lost three explanatory comments
  (why persistence settings are decided before any write; why caller input is validated before the durable row; why the
  settings are resolved once per open). The file ends at exactly 1,085 lines. Restore them, or move the logic into a module,
  rather than trading documentation for the budget.
- **`AgentEvent` is now a wider exported union.** It includes `WorkerEvent`. `subscribe` listeners still receive only
  record events, so existing observers are unaffected, but a consumer who typed a variable as `AgentEvent` and read `.record`
  would no longer compile. Worth one changelog line.
- **A crash between creating the conversation and writing the worker row leaves an orphan** `role: "worker"` conversation
  with no row. It's invisible to the pool. O5b's restart should sweep for them.
- **`delete` doesn't pass `providerSession: "best-effort"`**, so the provider-side session isn't cleaned. That's O5a's
  step 1 ("delete the conversation and provider session"), as the brief says.
- **A cancelled or interrupted worker run emits neither `worker_replied` nor `worker_failed`**, only `worker_idle`. That's
  fine for O1; O3a and O5a define the notices.
- **Baseline:** 1,521 tests, up from 1,509 at brief G.
