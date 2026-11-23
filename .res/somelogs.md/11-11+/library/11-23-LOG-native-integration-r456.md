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
