# Log: native harness integration, R4–R6

Spec: `11-11-SPEC-native-harness-integration.md`, "Remaining work: implementation plan": R4 (ACP cancellable connect and
`providerStart`), R5 (native usage and billing-grade metering), R6 (small gaps from the integration log), in that
order (decided by the user, 2026-11-23). Rules: `../.plan-execution/plan.md`. Written only by the coordinator.

| Role | Agent | Branch |
| --- | --- | --- |
| Coordinator and gatekeeper | core-p | `integration-r456-status` |
| Implementer | cod2a | `integration-r456` |
| Independent reviewer | clad2a | `integration-r456-reviews` |

All three branches start from alpha at `fe7d28c` (the orchestrator through O3b, O5b and O6 step 2 merged). Baseline:
`bun test ./test`, 1,589 tests in 149 files, green with `TMPDIR` on `/dev/shm` (gates use a RAM-backed `TMPDIR`: on disk,
different tests time out under machine load). R4 is an outline: its step 0 grounds the code and writes the full brief.

## Entries

### 2026-11-23: setup

- Branches created at `fe7d28c`; R4 (grounding and the full brief) goes to cod2a when the live run is done or waiting on
  the user.
- From here the coordinator keeps both tracks on this status branch (`integration-r456-status`, which now contains
  `orchestrator-status`); the orchestrator log is `11-22-LOG-orchestrator.md`, this file is for R4–R6.
- R4 step 0 in from cod2a, `ba36596` ([report](reports/11-23-REPORT-R4-grounding.md); the full brief); review from
  clad2a, `b6b9378`: accurate, ready to implement, no blockers. Verified: `stop()` reaches only the installed client;
  `reconnect` installs before it validates; `setMode` publishes the replacement before tearing down the source; a
  handoff target's stop is unreachable while startup hangs; the Agent-close ordering gap is real (the initial create is
  in neither `openings` nor `live`). Eight additions: bypass `bringUp`'s auth-preserving catch on cancel; guard
  `onCrash` by attempt identity; dispose a late `launcher.prepare` result; PTY in or out of scope; a post-await check
  before every install; a second start while one is in flight; keep the optional caller signal; assert the child pid
  is dead. Size gate: the attempt registry in a new module; `controller.ts`, `client.ts` and `agent-session.ts` must
  not grow; A1 hash unchanged. **R4 released** (after cod2a's small orchestrator fixes).
