# Gate: R3 complete (permissions as conversation events)

`native-integration-r` at `fcd6f09`: step 1 `c0fcf62`, step 2 `fef2020`, follow-ups `8776401` (the test stand-in;
fixes the coordinator's failed step 1 gate), `ce5e3d5` (expiry during a held record write), `c5b10b0` (step 3 docs),
`a95f82a` (native detach, force stop and stop deny open approvals), `fcd6f09` (the microtask contract, the report).
Reviews (clad2a): `299eb24`, `b6e5b9d`, `9039369` (complete, every decision implemented), `aad1f10` (follow-ups
resolved).

| Check | Result |
| --- | --- |
| Clean copy | `git archive fcd6f09` into `/tmp/corep-gate-r3b.GkV6`, `node_modules` linked |
| Typecheck | clean |
| Full `bun test ./test` | **1,509 pass**, 0 fail, 137 files, 308.5 s (also `c5b10b0`: 1,507 green twice) |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| Large files | `agent-session.ts` 4,564, `host.ts` 877, `client.ts` 1,062, `conversation-manager.ts` 1,085: none grew |

**Verdict: passed.** User decisions implemented: handlers unbounded; `permissionTimeoutMs` only for the consumer
wait; an ask nobody can answer is refused (`by: "default"`). Note: a conversation stop also denies an approval owned
by the host responder (only an observer detach keeps it). The spec's two paragraphs on the 10-minute timer are
corrected.
