# Gate: the ACP busy-worker restart test, the opt-in live smoke runner and the live run report

`orchestrator` at `9c50ffb` (alpha `3d96dbd` merged): `0f11c79` (the ACP busy-worker SIGKILL regression test), the smoke
runner `e1b378b`, its fixes `c1b1c04` and hardening `f73fde1`, the live run reports `93d12a1` and `9c50ffb`
(runner `0ab13e9`). Reviews (clad2a): `f38098a`, `af40261`, `60be735`: no blockers.

| Check | Result |
| --- | --- |
| Clean copy | `git archive 9c50ffb` into `/tmp/corep-gate-live.h4Wh`, `TMPDIR` on `/dev/shm` |
| Typecheck | clean |
| Full `bun test ./test` | **1,590 pass**, 0 fail, 149 files, 176 s |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| Footprint | no change under `src/` against alpha: a test, `smoke-tests/orchestrator/` and docs only |

**Verdict: passed.** The live runs: the first (`93d12a1`) stopped at the first mismatch because the Codex bridge's default
agent mode (`agent`, workspace-write, auto review) correctly needed no approval for a write inside the worker's own
working directory; the second (`9c50ffb`, `INITIAL_AGENT_MODE=read-only`) passed: one `execute` request from `w1` on
Alice, Bob's queued redirect unable to answer, one approved resolution and one `allow_once` response, one notice to Bob,
11 s, five OpenRouter requests, cleanup verified. Follow-ups (small): the first report states why Codex did not ask
(`INITIAL_AGENT_MODE` unset); the free mode prints "cannot verify" when the installed bridge doesn't match the pinned
2.9.0 text instead of throwing. Outside these commits (reported to the owner): `.mcp.json` is tracked in the repo (since
`2b8ff46`) and contains a bearer token for the local agents hub.
