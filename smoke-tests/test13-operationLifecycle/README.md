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
