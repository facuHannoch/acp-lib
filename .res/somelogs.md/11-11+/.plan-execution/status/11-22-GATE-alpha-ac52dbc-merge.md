# Gate: spec 1 verification on alpha `ac52dbc`

Merge `035b7d7` (parents `4cd3ce9`, `ac52dbc`), report section `58389dd` (cod2a); review section `a951e4e`
(clad2a, no blocking findings).

| Check | Result |
| --- | --- |
| Clean copy | `git archive 58389dd` into `/tmp/corep-gate-n.6cD8`, `node_modules` linked |
| `src/` against `ac52dbc` | only the two authorized native fixes; byte-identical to the `713a76a` → `4cd3ce9` diff (clad2a) |
| Typecheck | clean |
| Full `bun test ./test` | **1,426 pass**, 0 fail, 132 files, 268.7 s (first run) |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| cod2a's runs | 2 × `./test` green; rehearsal 5 × 10/10; characterization 35/35 |
| clad2a's runs | rehearsal 6 × 10/10 |

**Verdict: passed.** Spec 1 verification is complete on alpha `ac52dbc`. It is combined for the user's merge as
`pre-alpha`: `controller-interface-verify` (`58389dd`) plus `-reviews` (`a951e4e`) plus `-status`.
