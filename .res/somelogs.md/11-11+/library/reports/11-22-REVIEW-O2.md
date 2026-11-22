# Review — orchestrator brief O2 (busy rules and policy)

This review covers `9fa7745..ce28ee5` on `orchestrator`:

- `8c76be9`: step 1, the busy rules;
- `d72a8e2`: step 2, the policy;
- `ce28ee5`: the report.

I read them through `git diff`/`git show` and a clean `git archive ce28ee5` (`/tmp/clad2a-o2`); I didn't check out the
branch. The spec is the latest `orchestrator-status`. I wrote my own probes (`test/zz-probe/o2.test.ts` in that archive).

**Verdict: O2 meets its brief. No blocking findings.**

- **Full suite on the archive:** typecheck clean, **1,527 pass, 0 fail, 141 files**, 35 snapshots; the characterization
  hash is still `fbc6ec2c…`.
- **The fake assignment port is the right place for O3a to plug in, but it needs three additions** (last section).
- **The most-restrictive composition across `policyNames` isn't in O2.** The spec assigns it to O6, so it isn't an O2 gap.
- Four small notes, none blocking.

## The send semantics against the spec's table

`planAssignment` (13 lines) maps the spec's Flow 2 table exactly:

| Situation | Code result |
| --- | --- |
| Idle worker | `start` → `"sent"` |
| Busy, the giver's own running work | `continue` (the same assignment id, with the steer's destination) → `"steered"` |
| Busy, someone else's work, no `redirect` | `undefined` → **`busy`** + the worker summary. This holds even with `assignment: "new"`: the spec allows "new" only in an *allowed* busy case |
| Busy, someone else's work, `redirect: true` | `continue` with the new destination; `requireWorkerRedirect` first. The destination and `last_conversation` move, and `worker_redirected` is emitted with the previous conversation |
| Busy, same giver, `assignment: "new"` | `replace`: a new assignment id, the previous one kept with its own destination |
| Redirect plus new | `replace` with the new destination. The previous assignment keeps *its* destination for the "interrupted (steered)" notice |

**Tested on real ACP steering with the fake port.** The test runs the lifecycle fixture, holds the worker in a tool call,
then releases the boundary:

- all four cases ("continue", "redirect", "replace", "take over with new assignment");
- an other-giver send is refused as `busy` while the provider sees no second dispatch;
- the fake port receives `[start, continue|replace]` with the right ids and destinations;
- the two message ids are distinct;
- `worker_redirected` appears exactly when the destination changes.

**Details I confirmed in the code:**

- Events are right across a steer. `worker_busy` only for a `start`. `worker_idle` is emitted only when the *last*
  started run finishes, because `pool.finish` returns false for a run that has been superseded. A steered original
  completes as `cancelled` and emits nothing.
- `interrupt` waits on **all** tracked completions, so a stop doesn't return while a successor is still pending.
- A refusal leaves no side effects. The policy checks run before the row update, the dispatch, the eviction or the
  worker creation.

## The `busy` response: complete, with one flaw

`busy` carries `pool.summary(row)`: `handle`, `about`, `lastConversation` (where), `sender` (for whom), `operation` (what it's
doing), `state`, and `busyMs` (how long). The test asserts the `lastConversation`, `sender` and `state`. **The flaw is
`busyMs`.** It restarts at every steer: `pool.start` sets `started` on each dispatch. In my probe a worker had been busy
for about 1.6 s in total but reported 901 ms, counted from its latest steer. For "how long has this been going on", the
count should start at the beginning of the busy period or the assignment, and reset only on a replacement. Small fix.

## Policy

| Rule | Where | Result |
| --- | --- | --- |
| `use` | `requireWorkerUse` on `open` and `send` | refused, `rule: "use"` |
| `scope` | `check`, `list`, `open`, `send`, `stop`, `drop` | refused, `rule: "scope"` |
| `redirect` | a busy redirect; `stop` of someone else's running work; **every** `drop` | refused, `rule: "redirect"`. A giver can stop its own work without it |
| `maxOpen` | `checkWorkerOpenLimit`, before eviction and creation | counts non-dropped workers the conversation opened, offline ones included. Dropping frees the quota (tested) |

The tests exercise each denial with a typed `WorkerPolicyError.rule`. The consumer API passes the unrestricted consumer
actor.

**Composition across `policyNames` is not in O2, and that's per the spec.** There's no composition code anywhere in
`orchestrator/` or its tests. The actor arrives with an already-composed `policy`. The spec says the actor is "composed from
the call's policyNames" (the `Actor` type, spec L213) and gives the resolution to **O6's route** (L603–604: names resolved
to the session's worker rules, most restrictive, empty → defaults, missing or unknown → declined). What O6 should add:

- a small reduction helper with tests: `use` and `redirect` need **all** names to allow; `scope: "none"` wins;
  `maxOpen` is the **minimum**;
- the `workerPermissions` part of the actor, which O4 needs.

## Deleted offline worker: fixed, without an eviction

My probe (limit 1, `w2` live, `w1` evicted then its conversation deleted directly): `send` to `w1` threw "worker
conversation is unavailable" and `w2` stayed `idle`. The conversation is checked **before** `makeRoom`. That closes my
O1 note (3). **O1 note (2), the zombie row, is still open for O5a:** the row is still listed as `offline`, never
marked dropped.

## O2 and the repository: clean

- `orchestrator/` calls none of `stage`, `transitionDelivery`, `reserve`, `redirect`, `addContributingPolicies` or any flush; the
  only mention of `workerDelivery` is the capability check in `config.ts`. O2's only writes are the O1 worker row
  (`workers.update` for `about` and `last_conversation`) and events.
- `agent-session.ts` is untouched (4,564). `conversation-manager.ts` is 1,076, after the report's extraction. The largest
  new module is 209 lines.
- The assignment port is optional. The `Agent` builds its orchestrator without one, so no delivery code runs.

## Is the fake assignment port the right seam for O3a?

Mostly yes. `WorkerAssignmentPort.beforeDispatch(row, plan, messageId)` is called from the `beforeDispatch` hook of each
dispatched message, with `start | continue | replace`, the previous and new assignment ids, and the destinations. That
matches what `reserve` needs for a new assignment (the message id is only known inside the hook). **Three things are missing
for the real calls:**

1. **`policyNames`.** `reserve` needs `originatingPolicyNames` and `contributingPolicyNames`, and a steer adds names
   through `addContributingPolicies`. Neither the port nor the actor (here or in the spec's `Actor` type) carries
   `policyNames`. Add them to the conversation actor (O6 supplies them from `functions/call`) and pass them to the port.
2. **The `continue`/`replace` handling of the *previous* assignment has to happen before the steer is sent.** This is the
   steer-boundary gap from my brief G review. A steer *interrupts the running turn when it's accepted*, so the
   lifecycle stages the original assignment as interrupted ("steered") **before** the successor's `beforeDispatch` ever
   runs. By then it's too late to say "this assignment continues", and staged notices are immutable. So O3a needs a call
   that runs **before** `conversation.prompt(...)` for `continue` and `replace` (for example `port.prepare(row, plan, actor)`,
   called inside the pool's serial section), which marks the previous assignment as continuing or closing. `reserve` for
   the successor's message stays in `beforeDispatch`. This is the same repository change as at brief G: a link or
   transfer call, and a flag so `recordFailure` skips a steer end for an assignment marked as continuing.
3. **An error from the hook after a steer.** With a hook that rejects, the old turn is already interrupted, and the event
   `worker_redirected` has already been emitted (it's published before dispatch). O3a should decide the recovery (or emit
   the event after the hook), and test a refused hook on a `continue`.

With those three, the port is the right place, and replacing the fake with the real
`replaceAssignment`/`continueAssignment`/`reserve` calls is straightforward.

## Notes (none blocking)

- **A same-giver `redirect: true` is refused without redirect authority**, rather than treated as an ordinary steer
  (my probe: a policy without `redirect` got `refused:redirect`; the plain steer worked). The spec's table only gates
  redirect for *other* conversations' work. Either ignore `redirect` for the giver's own work, or document it.
- **`use: true` with `scope: "none"` can't open a worker** (my probe: `refused:scope`). The code ties `use` to `scope: "all"`, so
  there's no "fire and forget" policy. The spec's presets (owner, trusted, guest) don't contain that combination, so it's
  fine; ask the spec owner whether the coupling is intended.
- **`worker_redirected` is emitted before dispatch**, so a rejected hook leaves it already published (see point 3 above).
- **Baseline:** 1,527 tests, up from 1,521.
