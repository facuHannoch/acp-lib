# Review — the delivery retry follow-up, and the Acceptance read-through

Two parts:

1. the retry follow-up, `bc974ce..ea5a34c` on `orchestrator` (`3ef4ee0` code, `ea5a34c` report);
2. a read-through of the orchestrator spec's **Acceptance** section (latest `orchestrator-status`) against what's built.

I read the code through `git diff`/`git show` and a clean `git archive ea5a34c` (`/tmp/clad2a-retry`); I didn't check out the branch. My
probes are in `test/orchestrator/zz-*.test.ts` and `test/fixtures/zz-acp-busy-producer.ts` there.

---

## 1. The retry follow-up

**Verdict: no blocking findings.** Full suite on the archive (`TMPDIR` on `/dev/shm`): typecheck clean, **1,589 pass, 0 fail, 149
files**, 35 snapshots; the characterization hash is still `fbc6ec2c…`.

### Checklist

| Requirement | Result |
| --- | --- |
| **`check` and `list` show the delivery state (the latest staged state)** | `deliveryState` is `latest.delivery.state` of the newest staged assignment. cod2a's stdio tests read all four states (`pending`, `blocked_policy`, `delivered`, `failed_destination`) through both `check` and `list`. My probe agrees: with notices `A` (blocked), `B` (blocked) and `C` (delivered, the newest), `check` and `list` both showed `delivered` |
| **The retry is explicit, never automatic** | **My probe:** after reopening with the missing policy configured and flushing the host, `A` and `B` **stayed `blocked_policy`** and only `C` had reached the channel. Nothing retried until `retryDelivery` was called |
| **It targets the NEWEST blocked notice** | `latestOutcome(worker, "blocked_policy")` selects by `delivery_state = 'blocked_policy'` newest first, even when a newer assignment is `delivered`. **My probe:** with `C` delivered, the first retry moved `B` (newer than `A`), the next retry moved `A` |
| **It only moves `blocked_policy` → `pending`** | it uses `transitionDelivery(id, { from: "blocked_policy", to: "pending", explicitRetry: true })`, the repository's compare-and-set, so it can't reopen `delivered` or `failed_destination`; the destination's original delivery id and payload are reused. cod2a's test shows a retry **refused** on `pending`, `delivered` and `failed_destination` (missing and retired) notices |
| **It triggers the native flush and delivers once** | it awaits the native flush for a native destination (the ACP flush otherwise). **My probe:** after the retries the channel had exactly one notice for each of `A`, `B`, `C`; a futile retry (the policy still unknown) put the notice straight back to `blocked_policy` without delivering or duplicating |
| **A consumer API only** | `agent.workers.retryDelivery(handle)`. The delegation catalog is still `delegate, check, list, stop` (my probe prints it), and `grep` finds `retryDelivery` only in `orchestrator.ts`, `consumer-api.ts`, `durable-assignments.ts` and `assignments.ts`. No tool or route can reach it |
| **It refuses when nothing is blocked** | "worker w1 has no policy-blocked delivery to retry"; my second and third retries after both notices were delivered were both refused |
| **Concurrency** | calls are serialized in the pool, so two concurrent retries each took the newest blocked notice in turn (`B` then `A`), with one notice each |
| **Changelog** | accurate: `deliveryState` on check and list, and `retryDelivery` (rejects when nothing is blocked) |

**Cod1a's files again.** `latestOutcome`'s second parameter widens from `"result"` to `"result" | "blocked_policy"` in the contract and the SQLite
implementation (the SQL now uses `?1`/`?2`). Existing `"result"` callers are unchanged; cod2a added a repository test that finds an older
blocked notice under a newer outcome, and Cod1a's tests pass.

### Notes (none blocking)

1. **Blocked notices are invisible behind a newer outcome.** `deliveryState` is the latest staged assignment's. In my probe, `A` and `B` were blocked
   while `check` said `delivered`. A consumer can only learn about older blocked notices by calling the retry blindly. Consider surfacing a count
   of blocked notices (or the newest blocked one) in the summary.
2. **A successful return doesn't mean the notice was delivered.** A retry against a policy that's still unknown returns normally and the notice
   goes straight back to `blocked_policy` (my probe). The caller has to check `deliveryState` afterwards.

---

## 2. Acceptance read-through

The spec's Acceptance section has three bullets. Evidence for each:

### Bullet 1 — "the suite (workers on the offline fixture agents) covers…"

| Item | Covered by | Status |
| --- | --- | --- |
| **Slots** | `pool.test.ts`: "two opens racing for the last slot admit one, with the busy worker in the refusal" | ✓ |
| **Eviction and reload** | `pool.test.ts`: "idle eviction is least-recently used and send reloads the same conversation"; the idle-stop test reloads after a stop | ✓ |
| **`no_worker_free` with the listing** | the racing test checks the listing; visibility filtering by scope is tested in `pool.test.ts` | ✓ |
| **Busy and redirect** | `busy.test.ts` (continue, redirect, replace, take over with a new assignment) and `durable-assignments.test.ts` (seven modes, on real ACP steering at a tool boundary) | ✓ |
| **Policy refusals** | `pool.test.ts` ("conversation policy enforces use, scope, redirect, other-giver stop/drop and maxOpen"), `policy.test.ts` (composition), `native-delegation.test.ts` (unknown name, two-policy turn, missing names) | ✓ |
| **Forwarded permissions at each level and on timeout** | `permissions.test.ts`: allow and deny resolve on ACP without involving the giver; ask is answered through `answerPermission`; the timeout and a headless giver refuse; stopping the giver closes it; `allow_always` for owner and non-owner; plus the stdio end-to-end test | ✓ |
| **Restart with a busy worker** | native destination: `native-recovery.test.ts` "partial" boundary (worker busy on a forwarded permission, no final record, SIGKILL, one uncertainty notice, nothing redispatched). **ACP destination: no committed test** | ✓ native, **gap for ACP** (below) |
| **No provider key** | every worker is a fixture agent or the scripted harness model; the suite runs offline. O6 step 3 (the live run) is outside the suite and held for the user | ✓ |

**The ACP restart gap, closed by a probe.** I wrote a real-SIGKILL probe for an ACP destination: a worker held at a tool, the producer killed, then
a replacement `Agent` whose worker command **cannot dispatch**, reopened twice. At the crash there was no final record and nothing staged. After
each reopen: outcome `uncertain`, delivery `delivered`, **exactly one** record on the giver (`worker_failed`, `errorKind: "uncertain"`, sender
`w1`), the worker `offline`, nothing redispatched. So the behaviour is right; the suite just doesn't pin it. **Recommend adding that test**
(my fixture is about 15 lines).

### Bullet 2 — "a consumer lists and stops every worker"

✓ `pool.test.ts` ("the consumer lists, interrupts and drops workers while worker events stay distinct from records"), through
`agent.workers` (`list`, `check`, `stop`, `delete`, and now `retryDelivery`). `stop` returns nothing, as specified for the consumer API.

### Bullet 3 — "no edit to `src/agent-session.ts`"

**Not literally true, and the spec should say so.** Against the pre-orchestrator base (`4e88243`), `agent-session.ts` has **one changed
line and zero growth** (4,564 lines both): the O4 constructor line that registers the conversation with the permission coordinator
(`new ConversationPermissions(…, this, () => this.controllerDefaults)`). The review log and the O4 brief already call it a reviewed
exception. Reword the bullet: "no edit to `src/agent-session.ts` except the one-line permission-coordinator registration (O4)".

### Other mismatches between the spec and what's built

- **Acceptance is out of date.** It lists only the O1 to O5a behaviours. What O3 to O6 built is tested but not listed: durable delivery to native
  and ACP destinations, the crash and recovery cases (the three native SIGKILL boundaries, the two ACP ones), the delegation route over
  `serve --stdio` with a two-policy actor, the delivery retry, and the steer cases (continue, replace, refused, racing completion).
- **Events:** all nine spec events exist. The built `worker_stopped` has a third reason, `requested`; `worker_failed` can carry `reason: "refused"`,
  a `cause` and a `destination`. The Events section could say so.
- **Configuration:** the example shows only `orchestrator.workers`. The built config also has `policies`, `ownerPolicies` and
  `defaults.{delegation, workerPermissions}`, described under Policy limits but not in the example.
- **Summaries:** `check` and `list` now carry `latestOutcome`, `deliveryState` and `latestResult`; the spec's operation types don't.
- **Limitations that match the code** (checked): direct `conversations.open` bypasses the pool limit (my O1 probe), no native workers, no "ask the
  agent", uncertain outcomes are reported not resolved, LRU eviction, costs metered on the worker, headless refusal, all workers equal, and no notice
  to the previous conversation on a redirect. **Candidates to add**, from notes already accepted: a native destination's result isn't visible in `check`
  until the harness opens; `worker_idle` waits for the native flush; a folded steer emits one `worker_replied` per handle; a blocked notice is visible
  in `check` only while it's the newest.

# Part 3 — the ACP busy-worker SIGKILL regression (`0f11c79`) and the smoke runner (`e1b378b`)

Read through `git show` and a clean `git archive 0f11c79` (`/tmp/clad2a-o3r`, the branch tip; `ea5a34c` is its parent). I didn't check out the branch.

**Verdict: the regression is real and fails when the behaviour breaks. The smoke runner is correctly gated, but one of the stated properties is not true: live mode copies a credential file (below). No blocking findings for the free path.**

- **Full suite on the archive** (`TMPDIR` on `/dev/shm`): typecheck clean, **1,590 pass, 0 fail, 149 files** (up from 1,589).
- `test/orchestrator/acp-delivery.test.ts`: 6 pass.

## `0f11c79`: the busy-worker regression

It adds a third boundary, `partial`, to the existing crash fixture. The producer runs a real ACP worker (the lifecycle fixture) and waits for the tool call to be announced (the gate file is never created, so the worker stays at the tool), then holds so the test can SIGKILL it. It reuses the two-reopen loop of `final` and `append`.

At the crash point it asserts no final record, no delivery state and no staged row. After each of two reopens it asserts: the worker is `offline`, the outcome is `uncertain`, the delivery is `delivered` to the giver, exactly one message on the giver, and exactly one `worker_failed` record with `errorKind: "uncertain"` and sender `w1`. On the second reopen, the next prompt's text contains the "no reliable result" evidence exactly once. The reopen config's worker command is `no-work-dispatched`, so a redispatch would fail.

**Mutations applied to the archive** (each reverted after):

| Mutation | Result |
| --- | --- |
| `stage()` no longer settles unfinished inherited work | **`partial` fails** (others pass) |
| `stage()` settles it as `failed` instead of `uncertain` | **`partial` fails** |
| the ACP scan skips `stage()` for unstaged entries | `final`, `append`, `partial` and the deleted-outcome test all fail |
| the record kind is always `worker_reply` | `partial` and the blank and fail tests fail |
| `deliver` called twice for a pending entry | passes, as it should: the stable record id makes the append idempotent |

So the test pins the contract of my probe: one uncertain notice, one record on the giver, worker `offline`, nothing redispatched, reopened twice.

**Notes:**

1. **Orphan process.** The SIGKILL kills the producer, not its worker child. After the suite a `lifecycle-agent.ts` from the archive directory was still running, held at the tool gate (as was one from my earlier probe). It's a stray test process, but `partial` leaks one per run. Make the fixture worker exit when its stdin closes, or kill the process group in the test.
2. **No explicit "not redispatched" assertion.** The `no-work-dispatched` command makes a redispatch fail, but the test doesn't assert the absence of a launch or `worker_failed` event; the single-record and `offline` checks cover it today. I'd leave it.

## `e1b378b`: the smoke runner

| Property | Result |
| --- | --- |
| **Free mode is the default** | `ACP_ORCH_LIVE` unset (or anything but `"1"`) spawns `bun test native-delivery.test.ts -t "stdio delegation redirects"`. I ran it: **1 pass, 4 filtered out**, no network, no credentials read. The test name exists (`native-delivery.test.ts:14`) |
| **Live needs `ACP_ORCH_LIVE=1`** | Yes, checked first. With the flag set and no `OPENROUTER_API_KEY` it stops at once ("This run needs OpenRouter environment authentication and an existing Codex CLI login") before any spend. I ran that |
| **No paid calls so far** | None made by me: I ran only free mode and the fail-fast live path |
| **No credentials copied** | **Not true for live mode.** `run.ts:53` copies `~/.codex/auth.json` into a temp `CODEX_HOME` (file 0600, directory 0700) and runs `codex login status` against it. The README states it ("the isolated Codex login copy") and asks for explicit authorization. The copy is removed in the `finally` (it removes the root and checks it is gone), but a SIGKILL from the supervising limit would leave it in `/tmp`. `OPENROUTER_API_KEY` comes from the environment and is redacted in the error output; the worker gets `OPENROUTER_API_KEY: ""` |

Other checks:

- **Caps.** The native request cap of 6 runs inside the provider before `fetch`. The runner also aborts on an unexpected `open`/`send` (the wrappers check actor, text, redirect flag and count), on an extra worker permission, and on a permission appearing on the successor. A 7-minute deadline bounds the work. **The Codex CLI's own model calls are not capped** (the README says so); that is where spend can exceed the six-request count.
- **The result checks are strict**: exactly one `external_notice` on Bob's channel with source `w1`, one permission ask and one resolution, the old permission refused on Bob and accepted on Alice, `deliveryState: "delivered"`, and cleanup that checks `providerDeleted === true`.
- **Model names** (`deepseek/deepseek-v4.1-flash`, `gpt-6.1-terra`) are hard-coded; I can't check they exist without a paid call, so confirm them before the live run.

**For the held O6 step 3:** because live mode copies the user's Codex login, get the user's go-ahead for the copy as well as the spend, and make cleanup survive a kill (a signal handler that removes the root, or a user-provided isolated `CODEX_HOME`).
