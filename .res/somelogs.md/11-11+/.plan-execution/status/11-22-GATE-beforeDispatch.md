# Gate: `beforeDispatch` hook (for worker delivery)

Commits `acc6d5d` (the hook) and `7be9456` (the id fix) on `native-integration-r`, on `a902ccf`. Reviews (clad2a):
`0fd1e2e` blocking (ids didn't correlate), `40bab3f` resolved, no blocking findings.

| Check | Result |
| --- | --- |
| Clean copy | `git archive 7be9456` into `/tmp/corep-gate-hook.5vhU`, `node_modules` linked |
| Typecheck | clean |
| Full `bun test ./test` | **1,448 pass**, 0 fail, 132 files, 225.1 s (first run) |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| `agent-session.ts` | 4,600 (4,604 before) |
| Contract | per-message `beforeDispatch(messageId)` and causal `messageIds` on `afterPrompt` (every terminal status) and `promptFailed`: what Cod1a's approved `de82940` needs, nothing more (reviewer) |

**Verdict: passed.** Handed to Cod1a as `7be9456` (contains `acc6d5d`), to merge from `native-integration-r`.
