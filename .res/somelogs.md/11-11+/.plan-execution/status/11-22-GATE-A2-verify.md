# Gate: A2 verification (controller interface)

Commit `c6c6a00` on `controller-interface-verify` (report only). Review: clad2a, `b1d4a33`, no blocking findings.

| Check | Result |
| --- | --- |
| Clean copy | `git archive c6c6a00` into `/tmp/corep-gate-a2.u2gK`, `node_modules` linked |
| `src/` and `test/` untouched | `git diff d11cd18 c6c6a00 -- src test`: empty |
| Typecheck | clean |
| Full `bun test ./test` | **1,402 pass**, 0 fail, 131 files, 200.3 s (first run) |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| Reviewer verdict | holds for `c6c6a00` |

**Verdict: passed.**

Intermittent failures (cod2a's runs; four error notes): operation-lifecycle timeouts under full-suite load, and one
checkpointing/strategy early assertion that the reviewer traces to a wall-clock jump (`Date.now()` deadline, WSL2),
not a race: the coordinator stores the higher watermark before the first checkpoint completes. Test timing, no
`src/` race found; left to the owner with the A1 bridge flake.

For the spec owner (accepted, wording only): the commands listener receives the command list (`contracts.ts:106`;
the spec's Interface example takes none); one sentence in "How a turn runs" on readiness starting at `send` and
awaited with acceptance, and the ACP input built at preparation; `agent-session.ts` is 4,641 lines (the ~4,550 was
an estimate; under the 5,022 limit). Minor test weakness: the finalization test sets `providerFinished` in its own
`afterPrompt`.
