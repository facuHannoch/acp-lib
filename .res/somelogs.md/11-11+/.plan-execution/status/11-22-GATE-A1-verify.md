# Gate: A1 verification (controller interface)

Commit `f020860` on `controller-interface-verify` (report only, on top of `d11cd18`). Review: clad2a, `d2ba93c`, no
blocking findings.

| Check | Result |
| --- | --- |
| Clean copy | `git archive f020860` into `/tmp/corep-gate-a1.ReJt`, `node_modules` linked |
| `src/` and `test/` untouched | `git diff d11cd18 f020860 -- src test`: empty |
| Typecheck | clean |
| Full `bun test ./test`, run 1 | 1,401 pass, **1 fail** (bridge test, `condition timed out`), 131 files, 223.7 s |
| Full `bun test ./test`, run 2 | **1,402 pass**, 0 fail, 131 files, 235.4 s |
| Full `bun test` (repo root, includes the harness's tests) | 1,727 pass, 0 fail, 175 files, 328.5 s; matches cod2a's count |
| Characterization file alone, 3 runs | 35/35 each |
| Snapshot | sha256 `fbc6ec2c…` unchanged, matches report and review |
| Reviewer verdict | holds for `f020860` |

Counts: `./test` (the spec's gate command) is 1,402 tests in 131 files; cod2a's 1,727/175 is the repo-root run.
Later gates compare against 1,402 for `./test`.

**Verdict: passed**, on a complete green run. The intermittent bridge failure is recorded
(`errors/11-22-a1-bridge-status-wait-flake.md`) and left to the owner.

Open questions (report and review), accepted for the spec's Limitations, wording by the spec owner: fixture names
(lifecycle-agent modes instead of the stalling and permission agents); provider start failure covered as a failed
reattach (A2 step 4 covers the fresh case); capabilities read before start on the controller, since a conversation
can't be read before start; forced cancel through escalation, not a consumer `forceStop`; the bridge test's fixed
50 ms wait; ID numbering not strictly by first appearance (snapshots are not regenerated).
