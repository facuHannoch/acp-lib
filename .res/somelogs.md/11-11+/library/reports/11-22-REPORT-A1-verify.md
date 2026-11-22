# Controller interface verification — A1 characterization

Verified `d11cd180785fea49bd5a4f34a5aedf539af5d614` on `controller-interface-verify` against [Brief A1](../11-11-SPEC-controller-interface.md#brief-a1-characterization-tests) and the [original A1 report](11-12-REPORT-A1.md). The baseline archive already includes the 35 characterization tests and later briefs. The spec's 1,096 tests in 112 files describe the historical pre-A1 baseline.

## Clean baseline and three-run check

I unpacked `git archive d11cd18` into `/tmp/acp-a1-verify.36v1CC`, linked `node_modules` from the main checkout, and used Bun 1.3.14. The first restricted run hit fixture connection failures and was interrupted. A same-archive probe passed outside the sandbox, so the checks below ran on a fresh archive outside the sandbox with approval.

| Check | Result | Saved output |
| --- | --- | --- |
| `bun run typecheck` | Exit 0, clean | `/tmp/acp-a1-verify.36v1CC.typecheck.log` |
| Full `bun test` | 1,727 passed, 0 failed, 175 files, 35 snapshots, 352.06 s | `/tmp/acp-a1-verify.36v1CC.test.log` |
| Standalone run 1 | 35 passed, 0 failed, 35 snapshots, 19.16 s | `/tmp/acp-a1-verify.36v1CC.characterization-1.log` |
| Standalone run 2 | 35 passed, 0 failed, 35 snapshots, 15.35 s | `/tmp/acp-a1-verify.36v1CC.characterization-2.log` |
| Standalone run 3 | 35 passed, 0 failed, 35 snapshots, 22.07 s | `/tmp/acp-a1-verify.36v1CC.characterization-3.log` |

Each standalone invocation was `bun test test/conversation-turns/characterization.test.ts`. The snapshot file had SHA-256 `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d` at `d11cd18`, after the full run and after each of the three standalone runs. The hash and run summaries are in `/tmp/acp-a1-verify.36v1CC.snapshot-check.log`.

## All-modes group

The rows refer to [characterization.test.ts](../../../../../test/conversation-turns/characterization.test.ts). **Different** means the scenario is exercised with a fixture, setup, or observation point that differs from the wording. **N/A** means the spec excludes that mode.

| A1 case | Agent-owned | Managed | Detached | Evidence |
| --- | --- | --- | --- | --- |
| Plain prompt | Present | Present | Present | L292. Echo fixture; one prompt, settled result and persisted records. |
| Second prompt queued behind a running one | Present | Present | Present | L302. Waits for the first `turn_started`, then queues and awaits both handles. |
| Two steer messages combined into one run | Present | Present | Present | L314. Steer fixture sends both at the first tool event. Snapshots preserve the combined delivery IDs and all three results. |
| Interrupt of a running turn | Present | Present | Present | L335. Interrupts at `tool_running` and snapshots the settled turn. |
| Stalled prompt | Different | Different | Different | L351. Lifecycle fixture emits partial output then stalls; short 30 ms turn limits, 50 ms cancel grace. Covers the stale policy using a different fixture from the named stalling-prompt agent. |
| Permission answered through the handler | Different | Different | Different | L365. The lifecycle fixture requests permission; the handler records the request and selects `allow`. The spec names the permission agent. |
| Internal command | Present | Present | Present | L381. Calls `executeInternalSessionCommand("status")` against the offline operations fixture. |
| Handoff with a summary | Present | Present | N/A | L390. Generated summary between prompts on source and target. |

For the 23 tests here, each case captures settled results, events and records. The shared capture keeps turn and message events and compact metering and presentation events in observation order. The Agent-owned setup reads SQLite via `agent.persistence.records.list` and observes the committed record bus. Managed reads the persisted v2 activity transcript with its records. Detached reads the legacy JSONL transcript. The current snapshot wrapper runs the existing contract checks and applies the two pair-order allowances from A2 before normalization. No ordering allowance was added by this verification.

## Once-only group

| A1 case | Mode / surface | Status | Evidence |
| --- | --- | --- | --- |
| Withdraw a queued message and await its result | Agent-owned | Present | L419. Awaits the queued handle; snapshot pins cancellation and the second withdrawal returning false. |
| Interrupt and drop queued messages, awaiting their promises | Agent-owned | Present | L432. `clearQueue: true` drops both queue and steer handles, and the test awaits both plus the running handle. |
| Provider fails to start, prompt rejects with `turn_failed` | Agent-owned | Different | L450. Exercises startup for reattachment through a failed load after `forceStop`; directly checks rejection and matching `turn_failed`. It starts with a functioning conversation. |
| PTY startup yields empty session ID and no acquisition event | Controller, degraded PTY | Present | L470. Uses idle PTY and pins an empty ID on both starts and an empty progress stream. Raw start progress is available at the controller boundary. |
| Authentication refusal yields empty session ID, no acquisition, usable connection | Controller; extra detached case | Present | L492 pins both empty results and only `initialized`, then successful authentication, fresh session and prompt. L516 separately pins an auth-required prompt rejection from a detached conversation. |
| Bridge from degraded mode | Controller, degraded PTY | Present | L534–570. Drives fixture PTY input and exit chord; spies pin that it reuses the live PTY and remains connected. |
| Bridge from normal mode | Detached conversation | Different | L572. Spies pin creation, bridge and stop of a temporary PTY. The same ACP session stays connected and accepts a prompt. The fixture conversation is detached, with no event log or transcript in this snapshot. |
| Read prompt capabilities before and after start | Controller and Agent-owned | Different | L594. The controller checks literal pre-start and post-start. The public conversation factory awaits start, so the conversation checks connected, force-stopped and reconnected reads instead. This snapshot holds the getter outcomes. |
| Internal prompt stalls | Agent-owned | Present | L614–636. Short handoff-summary inference limits, acknowledged cancellation, metering and zero `turn_*` during the handoff. |
| Internal prompt cancelled by force | Agent-owned | Present | Same loop. Silent fixture reaches `cancel: "forced"` through escalation. Metering and absence of turn events are pinned. An explicit consumer `forceStop` during the summary is a different trigger. |
| Immediate permission request is visible in operation stages | Agent-owned | Present | L639–669. Fixture sends permission immediately. Snapshot pins `waiting → awaiting_permission → streaming`. |
| Immediate tool start is visible in operation stages | Agent-owned | Present | Same loop, pins `waiting → tool_running → streaming`. The existing commit-event barrier gates the turn's end after the last chunk. |

There are 12 once-only tests. The two bridge paths share one test, and authentication refusal has its additional detached test. Neither group lacks a requested scenario outright. The controller startup cases snapshot controller progress/state, and the bridge and capability cases snapshot their direct observations. The other once-only cases using the shared conversation setup capture persisted records and result envelopes where a prompt or handoff runs.

## Normalization

[normalize.ts](../../../../../test/conversation-turns/normalize.ts) replaces UUIDs, minted and other recognized IDs, timestamps, temp paths and hashes. It removes duration and PID fields and normalizes textual `pid=` values. Equal recognized IDs share placeholders, including in the composite record IDs used by these cases. Arrays and retained sequence numbers preserve their order. Numbering prioritizes values under identifier keys in a preliminary pass, which differs from literal first appearance across all string values. The auth controller snapshot already contains an `<id:2>` before its first `<id:1>`. See the normalization error entry below.

## Triage and open questions

- The fixture substitutions cover the intended stale-policy and permission-handler behavior. The spec owner can name the lifecycle modes if exact fixture names matter.
- Failed reattachment tests failure after a conversation already exists. The capabilities case uses the actual controller start boundary and the public conversation's reconnect boundary. Confirm whether the spec should describe those observation points explicitly.
- The forced cancellation test characterizes the result of the cancellation escalation. Confirm if the wording also intends an explicit consumer force stop.
- The baseline uses a fixed 50 ms sleep between typing and sending the bridge chord. That differs from the plan's event-wait rule. The assertions cover routing, session continuity, status and screen clear. The wait does not determine a pinned fixture-output order.
- No fixes or test commits were needed for missing scenarios. The report is the only repository change. No live harness ran.

Error notes in `$AGENTS_COMMON_ARTIFACTS_DIR/errors/`:

- [ID numbering order](../../../../../.agents/.artifacts/common/errors/11-22-a1-normalize-id-order.md)
- [Fixed PTY bridge wait](../../../../../.agents/.artifacts/common/errors/11-22-a1-bridge-fixed-wait.md)
- [Sandboxed fixture connection failure](../../../../../.agents/.artifacts/common/errors/11-22-a1-sandbox-fixture-connection.md)
