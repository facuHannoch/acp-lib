# Gate: R2 steps 1–2 (the neutral permission request and the matcher)

Commits `ccfc32f` (step 1), `7c8c18e` (step 2), merge of alpha `29715a3` at `e87907f`, report `ead74b8` on
`native-integration-r`. Review: clad2a, `c994609`, no blocking findings.

| Check | Result |
| --- | --- |
| Clean copy | `git archive ead74b8` into `/tmp/corep-gate-r2s12.aNgV`, `node_modules` linked |
| Typecheck | clean |
| Full `bun test ./test` | **1,484 pass**, 0 fail, 136 files, 214.0 s (first run; includes worker delivery's tests from alpha) |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| Large files | `agent-session.ts` 4,567, `client.ts` 1,077: not grown |

**Verdict: passed.** Step 3 held for the user's decisions (the three behaviour points, and the order of handler and
rules). For step 3: validate rules at config time; document that a `command:` allow can't override a stricter
`kind:`; a changelog line for `tool` on handler callbacks.
