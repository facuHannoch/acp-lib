# Gate: `aiagent/haurness-l` merged into the release candidate, with the bounded model-calls read

Candidate code commit `0df01b0` = `f32c5a2` (`aiagent/haurness-l` `7fa4075` merged into the release candidate `d407820`, one documentation
conflict resolved: the orchestrator spec's durable native completion paragraph, this branch's wording kept) plus the harness-only fix
`31ffb79` (Cod1a; decision 0029, bounded model-call pages). Reviews: Clad1a (decision `e45c097` approved with four pins; code
`31ffb79` and the trial `0df01b0` approved).

| Check | Result |
| --- | --- |
| Without the fix (`f32c5a2`) | `test/native/checkpoint.test.ts:1209` "operator stdio reads stay bounded on 10,000 records…" fails every time: one full storage snapshot where zero are allowed (the acp-client turn-close pull calls `session/model-calls`, which took a full snapshot) |
| Clean copy of `0df01b0` | `TMPDIR` on `/dev/shm` (coordinator, Cod1a and Clad1a each) |
| Typecheck | clean (root and harness) |
| Root `bun test ./test` | **1,678 pass**, 0 fail, 162 files |
| Harness `bun test` (src/native-harness) | **382 pass**, 0 fail |
| The 10,000-record checkpoint test | 0 failures in 10 runs (coordinator); zero snapshots |
| Snapshot | sha256 `fbc6ec2c…` unchanged |

**Verdict: passed.** The fix: an indexed, additive side projection of model calls (integer call number cursor and range, no blob read); the
canonical model state, the wire, the frame, the stored format and the archive are unchanged; ordinary writes update only the touched call's
row; a stale projection fails closed; writes from older code rebuild it on reopen. Pre-fix candidate (without `aiagent/haurness-l`) is kept
as `pre-alpha-prev` (`d407820`).
