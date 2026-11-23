# Review — the integration slice: O3b (native delivery), O5b (restart), O6 step 2 (the route end to end)

This review covers `d030961..bc974ce` on `orchestrator`:

- `8db2c67`: terminal native flush wired, inherited ACP staging (recovery at open), and eight real-stdio and restart tests;
- `bc974ce`: the report.

I read them through `git diff`/`git show` and a clean `git archive bc974ce` (`/tmp/clad2a-int`); I didn't check out the branch. My probes
are in `test/orchestrator/zz-int.test.ts` there.

**Verdict: the slice meets the briefs. No blocking findings.**

- **Full suite on the archive** (`TMPDIR` on `/dev/shm`): typecheck clean, **1,589 pass, 0 fail, 149 files**, 35 snapshots; the
  characterization hash is still `fbc6ec2c…`.
- **The source change is two small edits.** The rest is tests, which are strong: real SIGKILL at three boundaries, real stdio,
  and a replacement process that can't dispatch any worker.
- **core-p's question about a native destination after `old_settled`: no gap** (below).
- Four notes, none blocking.

## What changed in `src/`

| File | Change |
| --- | --- |
| `acp-delivery.ts` | the unstaged scan now calls `stage()` on **every** unstaged entry, not only those with a final record. Discovery already excludes work the current process owns, and `stage` settles only inherited unfinished work as `uncertain`. This is the ACP half of O5b |
| `durable-assignments.ts` | `settled()` now flushes both ACP **and native** after a conversation-actor completion |

Nothing under `src/native`, `src/persistence` (Cod1a's files) or `src/agent-session.ts` changed, and `host.ts` is untouched. The
biggest orchestrator file is `orchestrator.ts` at 310 lines. One existing test was updated, correctly: after a restart, the abandoned
binding is now settled as `uncertain` and delivered, where it used to stay unstaged.

## The question about a native destination after `old_settled`

**There's no gap.** Before this slice only a `replaced` result called `flushNative()`. Now `settled()` flushes the native host after
**every** conversation-actor completion, which includes the old turn's. The old final record is committed before that
callback runs, so the native module stages and delivers it then, whatever the replacement path was.

**My probe** (a native destination; a worker held at a tool; a steer sent; the gate released so the old turn finished by itself and
the steer became a fresh assignment): the steer returned `steered`, and **386 ms** after the release both `worker-result:orig` and
`worker-result:s1` were already on the destination's timeline, both `delivered`, in that order.

**What bounds the delay in the cases that remain.** A flush while the harness is down is a no-op, and it never starts the harness (my
probe: 0 launches while a worker completed). The notice is then staged and delivered when the host next opens, resumes, or confirms an
earlier channel change. So the delay is bounded by the next host open, not unbounded, and nothing is lost.

## Against the briefs

### O3b: native delivery

| Requirement | Evidence |
| --- | --- |
| **One notice**, through Cod1a's module, with the steer's policies | The end-to-end stdio test (Alice delegates, Bob redirects) ends with exactly one `external_notice` on Bob's channel, `worker-result:1:delegate`, source `w1`, and `policy.inherited: ["guest", "owner"]` in the harness's reconciliation view. **My probe:** after many triggers (three extra flushes, a host stop and restart, a resume) the destination still had exactly **one** notice, `delivered` |
| **A redirect retargets it, both orders** | Before staging: the redirect at the ACP tool boundary moved the notice to Bob. After staging: `repo.redirect(...)` returns `false` and the staged payload is unchanged, in both the end-to-end and the pending-destination tests |
| **Pending** | a suspended channel leaves the notice `pending` with no timeline notice, then one notice after resume |
| **Blocked on `invalid_policy`, with an explicit retry** | an unknown policy gives `blocked_policy`; after reopening with the policy configured it **stays blocked** until `transitionDelivery(… explicitRetry: true)` moves it to pending, then it delivers (see note 1) |
| **Failed for a missing or retired destination** | `failed_destination`, no timeline notice |
| **The result kept for `check` and `list`** | every case asserts `latestOutcome` equals the staged outcome |

### O5b: restart

The producer is a real subprocess that uses the **production orchestrator** and is killed with SIGKILL. The test reads the database at
the crash point, then opens a replacement `Agent` whose worker command **cannot dispatch** (`no-worker-redispatch-permitted`), so any
redispatch would fail loudly, and starts a real stdio harness.

| Crash boundary | Recovery verified |
| --- | --- |
| Final record committed, not staged | the exact final text recovered by assignment id, delivered, one timeline notice; the harness woke a native turn |
| Forwarded permission pending, no final record | **one uncertainty notice**; the old permission id is refused (`answerPermission` → `accepted: false`); nothing redispatched |
| Staged, receipt not accepted | the same notice id and payload delivered **once**; the staged record unchanged by a repeated flush |

In every case the worker row is read from the repository and shown `offline` (no provider started), and `check` shows the staged
outcome. The ACP half does the same through its startup scan (`Agent.open` flushes).

### O6 step 2: the route end to end

The test runs a scripted model over the real harness: Alice's channel calls `delegate`; Bob's native turn calls `delegate` with the
worker handle and `redirect: true` while the worker is held at its tool boundary; the successor's permission request appears on **Bob's
conversation marked with the worker source**; Bob answers with `answerPermission`; one notice wakes Bob's channel; `worker_redirected`
is emitted once and only after the gate release. The composed actor (owner + guest policies) is visible in the notice's inherited
policy names.

## Notes (none blocking)

1. **The explicit retry has no product path, and a blocked notice is invisible.** The test calls the repository's `transitionDelivery`
   directly. `check` and `list` expose only `latestOutcome` (my probe: the summary's keys are `conversationId, createdAt, handle,
   lastConversation, latestOutcome, openedBy, state`; nothing about delivery). A consumer can't see that a result is blocked, and
   has no worker API to retry it. Surface the delivery state in the summary and add a retry operation.
2. **For a native destination, `check` and `list` can't show a finished result until the harness is up.** Staging for native destinations
   is done by the native module only while the host is available. In my probe the worker's final record was committed with the harness down,
   but `readStaged` was `undefined`, so `latestOutcome` was empty until the host opened. ACP stages locally and doesn't have this gap.
3. **`worker_idle` waits for the native flush.** `settled()` is awaited before the idle event and the idle-stop timer. I held every flush to
   test the coupling: the worker is **not** blocked (`check` said `idle` and a new `send` was accepted), but its `worker_idle` event
   was delayed until the flush returned. The flush is bounded by the host's request timeouts. The tests use `worker_idle` as a "delivery
   settled" signal, which is worth keeping in mind if the coupling is changed.
4. **Recovery order for ACP:** `Agent.open` awaits `acpWorkerDelivery.flush()`, so open takes as long as the pending ACP backlog; it's
   local database work, so this is fine in practice.
- **Not covered here:** O6 step 3, the live run, is held for the user.
- **Baseline:** 1,589 tests, up from 1,581.
