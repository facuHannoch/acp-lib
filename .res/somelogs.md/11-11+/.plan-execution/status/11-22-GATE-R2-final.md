# Gate: R2 complete (the permission setting and matcher)

`native-integration-r` at `928f865`: steps 0–3 (`2619e12`, `ccfc32f`, `7c8c18e`, `0ef8da4`, `43db21a`), the alpha
merge `e87907f`. Reviews (clad2a): `29c97db`, `c994609`, `677ce63` (complete, every user decision implemented, no
blocking findings).

| Check | Result |
| --- | --- |
| Clean copy | `git archive 928f865` into `/tmp/corep-gate-r2.eh7V`, `node_modules` linked |
| Typecheck | clean |
| Full `bun test ./test` | **1,488 pass**, 0 fail, 136 files, 237.4 s (first run) |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| `defaultPermission` in `src/` | none (outside the historical log) |
| Large files | `client.ts` 1,077 → 1,062; `agent-session.ts` 4,567 → 4,565 |

**Verdict: passed.** Notes carried into R3: validate `permissionRule` return values; document that `permissionRule`
receives native requests (`tool.name`, string `rawInput`). Accepted as notes: native is detected through
`nativeSteering` (an explicit flag would be clearer; `controller_kind` exists); with no `reject_once` offered, an
automatic deny records cancelled while an unattended ask records denied.
