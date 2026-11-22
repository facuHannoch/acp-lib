# Gate: R1 step 1 (the `channels?` repository)

Commit `e55afcf` on `native-integration-r` (implementation `61ecd21`). Review: clad2a, `3f2a111`, no blocking
findings.

| Check | Result |
| --- | --- |
| Clean copy | `git archive e55afcf` into `/tmp/corep-gate-r1s1.hx9t`, `node_modules` linked |
| Out of scope untouched | `host.ts`, `conversation-manager.ts`, snapshots: unchanged |
| Typecheck | clean |
| Full `bun test ./test` | **1,430 pass**, 0 fail, 132 files, 236.8 s (first run); baseline 1,426 + 4 |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| v16 upgrade | cod2a's probe and clad2a's own (a database written by `44bbc25`, opened twice: data kept, migrations `[16,17]`) |

**Verdict: passed.** Notes for later steps: inside a transaction callback, use only the scoped repository (a root
`channels` call there would wait forever); `HarnessUnavailableError` gets a readonly `code` per throw, with
offline suspend/resume rejecting with `not_running` and writing no intent (the user's decision (d)).
