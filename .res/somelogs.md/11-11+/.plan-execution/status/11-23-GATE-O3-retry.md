# Gate: the retry and delivery-state follow-up (and the Acceptance read-through)

`orchestrator` at `ea5a34c` (alpha `fe7d28c` is an ancestor): `3ef4ee0`, report `ea5a34c`. Review (clad2a): `819ff12`, no
blocking findings.

| Check | Result |
| --- | --- |
| Clean copy | `git archive ea5a34c` into `/tmp/corep-gate-retry.Ozvj`, `TMPDIR` on `/dev/shm` |
| Typecheck | clean |
| Full `bun test ./test` | **1,589 pass**, 0 fail, 149 files, 184 s (clad2a: the same) |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| Footprint | `agent-session.ts` 4,564, `host.ts` 916 (unchanged); `retryDelivery` is a consumer API only, absent from the delegation catalog |

**Verdict: passed.** Acceptance read-through (clad2a): the spec's Acceptance, Events and Configuration sections were
updated to what is built (durable delivery, crash recovery for both destination kinds, the stdio route, the live run, the
retry; `worker_stopped` reasons, the refusal reasons, the policies, `ownerPolicies` and `defaults` keys; the new summary
fields; Limitations for the accepted notes). Follow-up: a committed real-SIGKILL test for a busy worker with an ACP
destination (clad2a's probe: one uncertain notice delivered, one record on the giver, nothing redispatched).
