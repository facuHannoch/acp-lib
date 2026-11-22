# Gate: spec 1 verification on alpha `713a76a`

Merge `4cd3ce9` on `controller-interface-verify` (parents `9016c0c`, `713a76a`); report `32d30d0` (cod2a); review
`de0b059` (clad2a, no blocking findings).

| Check | Result |
| --- | --- |
| Clean copy | `git archive 4cd3ce9` into `/tmp/corep-gate-m.DRh1`, `node_modules` linked |
| `src/` against alpha | only the two authorized native fixes (`native/controller.ts`, `agent-session.ts`, `handoff-options.ts`) |
| Typecheck | clean |
| Full `bun test ./test`, run 1 | 1,425 pass, **1 fail**: `SQLite agent persistence > releases cross-process ownership when the owner process terminates` (6.3 s, unchanged test, not touched by this pass) |
| Full `bun test ./test`, run 2 | **1,426 pass**, 0 fail, 132 files, 282 s |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| cod2a's runs | 2 × `./test` green (1,426 / 132); repo root green (1,786 / 179); characterization 3 × 35/35 |
| Probes (cod2a, clad2a) | media refused with no push and no attach; fresh handoff refused with no events or records |

**Verdict: passed**, on a complete green run.

Intermittent failures, not caused by this pass, for their owners: the SQLite cross-process ownership test (run 1
here); alpha's `test/native/rehearsal.test.ts`, failing about 1 in 5 on alpha itself and on the merge in two modes
("Unused model records", test timing from compressed offsets; "rehearsal deadline before all work settled", probably
load, but a real stop in settling would be a stuck channel), handed to the alpha owner. `host.ts` is 984 lines on
alpha (761 before; the plan says it shouldn't grow), alpha's change.
