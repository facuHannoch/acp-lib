# Operation lifecycle smoke test

Run `ACP_TEST13_ADAPTER=mock bun smoke-tests/test13-operationLifecycle/index.ts`.
Use `codex` or `opencode` for a real harness. Real runs spend tokens; mock runs do not.
Models are never selected. Only newly created throwaway conversations are used.

`m1` measures first output, longest observed gap without a running tool, and interrupt latency.
Variables: `ACP_TEST13_ADAPTER` (mock), `ACP_TEST13_RUNS` (3), `ACP_TEST13_ONLY` (all scenarios),
`ACP_TEST13_DATA_DIR` (this directory). Each run replaces `agent.sqlite` and `results.json`.
Live progress is printed before every operation. A short normal completion before interrupt is reported
as completed, so its duration must not be interpreted as an acknowledged cancellation.

Inspect records through `agent.persistence.records.list(conversationId, { limit: 1000 })` and
`agent.persistence.providerSessions.active(conversationId)`. Error records have `kind === "error"`.
Additional fault scenarios are added with their implementation phases.

`s1` opens a permission whose handler never answers, interrupts, checks its AbortSignal and cancellation,
and sends a second prompt. It spends tokens on real adapters. A real adapter must actually ask permission;
a harness that auto-approves cannot exercise this scenario and the runner reports that gap as a failure.

`s5` runs a tool longer than the configured silence limit and checks it completes without a stall.
`ACP_TEST13_FIRST_OUTPUT_MS` and `ACP_TEST13_NEXT_OUTPUT_MS` set the general smoke limits (5000ms).
The mock scenario uses 100ms limits and a 150ms tool; real prompts use a twenty-second sleep with fifteen-second limits.

`s2` freezes its harness with SIGSTOP, verifies a no-response stall and stored error, and checks that
loading the same session preserves a remembered keyword. `s3` sends SIGKILL during a prompt and checks
that the next prompt loads the same session and remembers the keyword. The launcher writes only its
own newly spawned harness PID to `harness.pid`; signals never target an existing consumer session.
`ACP_TEST13_CANCEL_GRACE_MS` defaults to 1000ms for smoke runs.

For a quick mock fault run:
`ACP_TEST13_ONLY=s2,s3 ACP_TEST13_FIRST_OUTPUT_MS=100 ACP_TEST13_NEXT_OUTPUT_MS=100 ACP_TEST13_CANCEL_GRACE_MS=100 bun smoke-tests/test13-operationLifecycle/index.ts`.

`s4` freezes its own harness with SIGSTOP with one queue and two steers pending. It checks the
stall error's followedBy IDs, a combined steer turn delivered via stall, and queue hold/release events.
These message events are live observations; s4 saves them in results.json. Canonical stored stall errors
can be read with `records.list(id, { kinds: ["error"] })`; provider mappings with `providerSessions.active(id)`.


The default run executes all scenarios, recording individual failures and continuing. It prints an
elapsed-time heartbeat every ten seconds and saves failures in results.json; any failure sets exit code 1.
`ACP_TEST13_HISTORY_TURNS` adds short prompts before m1 cancellation/loading to measure longer replay.

Measurements from 2026-10-18 are checked into `measurements/`. Codex and Claude m1 used three
throwaway sessions each. Codex passed freeze/crash/steer and long-tool checks, but its default
permission smoke prompt produced no native permission request; this is a real-scenario coverage gap.
OpenCode's default upstream rejected every model call because of its free-tier policy; no model or
provider configuration was changed. Mock scenarios all passed. These short measurement runs do not
exercise automatic compaction, so 120/180-second silence limits and 30-second cancellation grace
remain conservative defaults. Canonical record queries use the persistence API, not the live message
hold events, which s4 explicitly stores in results.json.

A further Codex m1 run added 24 short history turns: loading replayed 53 updates in 554ms, with a
535ms maximum replay gap (including the initial wait). It did not exercise context compaction.
