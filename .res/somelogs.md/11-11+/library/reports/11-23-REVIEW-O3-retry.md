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

# Part 4 — the fixes in `0f11c79..c1b1c04`

One commit, `c1b1c04` (smoke runner, README, `lifecycle-agent.ts` fixture). I read `git diff` and ran a clean `git archive c1b1c04` (`/tmp/clad2a-c1`), `TMPDIR` on `/dev/shm`. I didn't check out the branch.

**Verdict: all five of your points hold. No blocking findings; two small notes.** Full suite on the archive: typecheck clean, **1,590 pass, 0 fail, 149 files**.

| Point | Result |
| --- | --- |
| **No path copies or reads `~/.codex/auth.json`** | Confirmed. `grep` over `smoke-tests`, `src` and `test` finds no `auth.json` (the one hit is an unrelated `auth.jsonl` in the characterization test). `writeFile` and the `auth` variable are gone; `readFile` is still imported and is used only for the result file (`run.ts:188`). The runner only passes `CODEX_HOME` to `codex login status` and to the worker |
| **Missing or non-disposable `ACP_ORCH_CODEX_HOME` refused** | Confirmed with a fake `HOME` (so nothing touched the real home) and stub `codex`/`codex-acp`: unset → "Live mode requires … a disposable ACP_ORCH_CODEX_HOME"; equal to `~/.codex` → "Use a disposable Codex home"; **a symlink to `~/.codex` → refused too** (both sides go through `realpath`); a nonexistent path → `ENOENT` from `realpath`, i.e. refused, if with a less friendly message. All happen before the temp root is created and before any spend |
| **Cleanup on a signal removes the tmp tree** | Confirmed. With a stub `codex login status` that sleeps, `timeout` sent SIGTERM mid-run: output `Live run terminated` then `{"tempRemoved":true}`, and no `acp-orch-live-*` directory was left. SIGINT uses the same path. The supplied home is never removed (only `root`) |
| **Orphan lifecycle-agent no longer leaks** | Confirmed. The fixture now exits on stdin `end`. After the full suite (including the SIGKILL tests) there is no `lifecycle-agent` process from the archive. The two orphans still running belong to my earlier retry probe and to core-p's gate directory, both from before the fix |
| **Free mode makes no network calls** | Confirmed: `unshare -rn bun smoke-tests/orchestrator/run.ts` (no network namespace) passes, 1 pass, 4 filtered out. It prints the planned model names first, which is only a `console.log`. The model environment variables are read, never sent anywhere |

**Notes:**

1. **"Disposable" means only "not exactly `~/.codex`".** My probe with `ACP_ORCH_CODEX_HOME` set to the fake `HOME` itself (a parent of the real `~/.codex`) was accepted and ran. A parent directory, or a directory that contains the real login, isn't refused. Consider also rejecting a home that contains, or is inside, `~/.codex`, or one that already holds `auth.json` unless the user opts in. It is the user's own variable, so this is a guard-rail, not a hole.
2. **Signals are caught, then work waits for the abort to unwind.** The handlers only abort the deadline controller, so a signal during an unbounded await (for example `agent.close()` in the `finally`) doesn't kill the process until that await ends. Nothing leaks, but a second signal won't force an exit. The README states that an uncatchable kill (SIGKILL) leaves an `acp-orch-live-*` work tree, which now contains no login file.

# Part 5 — the live-run files (`c1b1c04..9c50ffb`)

Four commits: `f73fde1` (hardened runner), `93d12a1` (the first live report), `0ab13e9` (the permission-tracing runner and `codex-permissions.ts`) and `9c50ffb` (the second live report). I read `git diff` and clean archives of `93d12a1` and `9c50ffb` (`/tmp/clad2a-live`, `/tmp/clad2a-live2`). I made **no live run, no paid call, and did not read or touch any Codex home**: my runner tests used a fake `HOME` and stub binaries.

**Verdict: the hardening, the redaction and the gating all hold, and the reports are consistent with what the runner asserts. No blocking findings. One thing outside these commits needs attention (the committed `.mcp.json` token), and three small notes.**

## The runner's hardening (`f73fde1`)

With a fake `HOME` (so the real one was never involved) and a stub `codex` that sleeps, each case run with `ACP_ORCH_LIVE=1`, a dummy key and a 4 s timeout:

| `ACP_ORCH_CODEX_HOME` | Result |
| --- | --- |
| the normal `~/.codex` | **refused** ("Use a disposable Codex home that does not overlap…") |
| a child of it (`~/.codex/sub`) | **refused** |
| `$HOME` itself | **refused** |
| an ancestor of `$HOME` (`/dev/shm`), and `/` | **refused** |
| a symlink to `~/.codex`, a symlink to its child, a symlink to `$HOME` | **refused** (both sides go through `realpath`) |
| siblings with a similar name (`~/.codex-other`, `~/.codexy`) and an unrelated directory | accepted (they ran until my timeout and the temp tree was removed), so the check is path containment, not a name prefix |

All refusals happen before the work tree exists. `README` now says shutdown, including `Agent.close()`, runs to completion and recommends `timeout --signal=TERM --kill-after=10s 470s`. **Note 1:** the guard protects only `~/.codex`; a user whose real login lives at a custom `CODEX_HOME` would not be protected if they pass that as the disposable home. It is the user's own variable, so this is a guard-rail.

## The permission-tracing runner (`0ab13e9`)

| Check | Result |
| --- | --- |
| **`INITIAL_AGENT_MODE=read-only` is set** | Yes (`workerEnv`, `run.ts:101`). Free mode reads the installed bridge's bundle **as data** and checks that `read-only` means `on-request`, the `user` reviewer, a read-only sandbox with network off, that the bridge reads `INITIAL_AGENT_MODE`, and that approvals go through `session/request_permission` with `kind: "execute"` and the command in `rawInput.command`; it also checks that the ACP matcher recognizes the projected command. It ran here against the installed bridge and printed the settings |
| **The output file is outside the worker's cwd** | Yes: the worker's cwd is `<root>/worker`, the output is `<root>/result.txt` |
| **The runner approves only the exact command** | Yes: it checks `kind === "execute"`, `command === the authorized echo`, no `url`, no `additionalPermissions` before answering, and picks the `allow_once` option |
| **The trace is redacted** | Yes. The logger keeps **only** tool kind, option *kinds* (`allow_once` etc.), a fixed string for the permitted command (`echo 'orch live ok' > [run output]`) or `[redacted]`/`[absent]`, and the selection kind. Raw option ids and unrecognized command text are dropped. Every other debug event is discarded. Printed output goes through `safe()`, which replaces the API key and the run root |
| **The trace is deleted with the run and isn't committed** | It is written to `<root>/worker-permissions.jsonl` (mode 0600), and `rm(root, recursive)` runs in the final `finally`, after the summary is printed. No such file or `acp-orch-live-*` path is in the tree at `9c50ffb`; the work tree is under `/tmp` |
| **The runner never reads or prints anything inside `ACP_ORCH_CODEX_HOME`** | Confirmed by reading every file access in `smoke-tests/orchestrator`: the only reads are the bridge bundle (`readFile(realpath(codex-acp))`) and the run's own result file. `CODEX_HOME` appears only as an environment value for `codex login status` and for the worker; it is never opened, listed or printed. `codex login status` still receives the real `HOME` (note 2) |
| **No paid calls in free mode / offline** | Free mode passes (1 pass, 4 filtered out), also under `unshare -rn` with no network |

## Key-like strings

I searched every file in the archives of both commits, plus the two live reports and the log files, for OpenRouter-style keys (`sk-or-…`, `sk-…`), JWTs, `access_token`/`refresh_token` values, `OPENROUTER_API_KEY=<value>` and bearer tokens. **Nothing in the live-run files, the reports or the logs matches**, and the reports contain no 32-character-or-longer token. The added lines of `c1b1c04..9c50ffb` contain no `auth.json`, token or secret word other than documentation of what is *not* done.

**One hit outside these commits: `.mcp.json` is tracked and contains an `Authorization: Bearer <64 hex>` header for the local `agents-hub` MCP server (`http://localhost:3409`).** It was added long ago (`2b8ff46`), it is on `main` too, and it is not an OpenRouter or Codex credential, so it does not touch this review's question. It is still a bearer token in the repository history: tell the owner, and consider ignoring the file and rotating that token. I did not print the value here.

## The reports against the evidence

**First live attempt (`93d12a1`).** Consistent with the runner of that commit: three OpenRouter requests are the first native prompt (the delegate call), its post-tool reply, and the notice-driven turn; one worker submission; the run stopped at the first mismatch (no forwarded permission) and the report says the permission and redirect gate stayed open. Its claims are scoped to what it saw (delivery from the run's database, not the runner's final assertions). **Note 3:** the report doesn't say *why* Codex didn't ask. The second runner's change explains it: the first run didn't set `INITIAL_AGENT_MODE`, which is what the bridge reads for its approval policy and sandbox (the `CODEX_CONFIG` JSON alone didn't select them). One sentence to that effect would make the two reports read as one story.

**Second attempt (`9c50ffb`).** Every quoted result is one the runner **asserts and fails hard on**, so an exit code of 0 implies it:

| Claim in the report | Where the runner enforces it |
| --- | --- |
| an `execute` request from `w1` reached Alice, command `echo 'orch live ok' > [run output]`, options `allow_once`, `allow_always`, `reject_once` | the permission trace (exactly one request, kind and command checked) and the check on `ask.source.handle === "w1"` and the exact command |
| Bob's redirect queued while it was open; Bob's answer was rejected | `send` result must be `steered`; `bob.answerPermission(...)` must be not accepted; `resolutions === 0` is checked before Alice answers |
| Alice's `allow_once` gave one approved resolution and one ACP `allow_once` response | `alice.answerPermission` accepted; `resolutions === 1`, `trace.requests.length === 1`, `trace.responses === ["allow_once"]` |
| one notice from `w1` to Bob | `notices.length === 1`, channel Bob, source `w1` |
| 5 OpenRouter requests, 2 native prompts, 2 worker submissions | the counters (`nativeCalls`, `workerSubmissions`) are asserted at 2, 4 and 5 along the way; the request cap is 6 |
| the file contained the line | `readFile(output)` is checked |
| provider delete true; both native conversations tombstoned; trees removed | `providerDeleted === true`, `deletedAt` checks, and `existsSync(root)` is checked in the final `finally` |

I can't re-observe the live output (I did not run it), so "11 s" and the quoted model sentences rest on the report; nothing in them contradicts the code. The report states the supplied Codex home was not inspected; that matches the runner. **Note 4:** the report says the bridge reported no count of Codex's internal model calls, which is the stated limitation (those calls are uncapped); keep that sentence in the final status.

## Notes (none blocking)

1. The home guard protects only `~/.codex`, not a custom `CODEX_HOME` of the user's.
2. `codex login status` is given the real `HOME`; with `CODEX_HOME` set, Codex should not read `~/.codex`, but it's the one place the real home directory reaches a child process.
3. Add one sentence to the first report on why Codex did not ask (the mode variable).
4. **Free mode now depends on the installed bridge.** `checkWorkerMode` throws if the bundle doesn't match the pinned 2.9.0 text, and nothing catches it in the free path: I put a stub `codex-acp` on `PATH` and the "free, scripted" run **exited with an error before running its test**. A newer bridge version would break the free smoke the same way. Catch it in free mode and print "cannot verify", as the not-installed branch already does.

# Part 6 — the live-run follow-up (`9c50ffb..1a769da`)

One commit, `1a769da` (`codex-permissions.ts`, `run.ts`, the README and the first live report). I used a clean `git archive 1a769da` (`/tmp/clad2a-live3`) and a fake `HOME`/stub bridges; no live run, no paid call, no Codex home touched.

**Verdict: both notes are closed. No findings.**

| Check | Result |
| --- | --- |
| **The first report says why Codex did not ask** | Yes: at that run `INITIAL_AGENT_MODE` was unset, so the bridge used its default `agent` mode ("Auto review", on-request approvals with an auto reviewer and a workspace-write sandbox); the worker wrote inside its own working directory, where the bridge may allow it without asking, and the runner's `CODEX_CONFIG` setting did not select read-only. I checked it against the installed bridge's bundle: it has the `Agent` mode ("Auto review", `on-request`, reviewer `auto_review`) as the default and reads `INITIAL_AGENT_MODE` to choose another, which matches |
| **Free mode prints "cannot verify" for an incompatible bridge** | Yes. With a stub `codex-acp` on `PATH` the free run printed `plannedWorkerPermissions: "cannot verify: Installed bridge differs from the reviewed permission path (found no recognized ReadOnly entry; INITIAL_AGENT_MODE lookup absent)"` and still ran and **passed** the scripted test (1 pass). A stub with a partly matching `ReadOnly` entry reported what it found ("approval on-request and sandbox readOnly") the same way. With no bridge on `PATH`: "cannot verify: Codex ACP bridge was not found on PATH". With the real bridge it prints the verified settings, also with no network (`unshare -rn`) |
| **The incompatible bridge is never started** | The stub, which writes a marker file when executed, **was not executed** in any free run (marker absent). The check only reads the bundle as data, and the "found …" text is built from the three values the check extracts (approval, sandbox, whether the lookup exists), not from file contents |
| **No credential involved** | The free runs ran with no `OPENROUTER_API_KEY` and no Codex home; the message contains no credential material |
| **Live mode is still strict** | Yes: with the stub bridge and `ACP_ORCH_LIVE=1` the runner still throws the same "differs from the reviewed permission path" error before creating any work tree, and the stub wasn't executed |
