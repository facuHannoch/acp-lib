# Operation lifecycle smoke test

Run `ACP_TEST13_ADAPTER=mock bun smoke-tests/test13-operationLifecycle/index.ts`.
Use `codex` or `opencode` for a real harness. Real runs spend tokens; mock runs do not.
Models are never selected. Only newly created throwaway conversations are used.

`m1` measures first output, longest observed gap without a running tool, and interrupt latency.
Variables: `ACP_TEST13_ADAPTER` (mock), `ACP_TEST13_RUNS` (3), `ACP_TEST13_ONLY` (m1),
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
The mock scenario uses 100ms limits and a 150ms tool; real prompts use an eight-second sleep.

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
