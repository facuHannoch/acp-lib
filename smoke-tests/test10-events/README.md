# Committed-record event bus smoke test

Runs one SQLite-backed agent against a real ACP harness and asserts that `agent.events`
delivers exactly the canonical records persistence commits:

1. A subscriber is attached before the first prompt, since the bus has no replay.
2. Every emitted record matches a persisted row by `recordId`, `sequence`, and `kind`.
3. A generated checkpoint's `conversation_checkpoint` `native_action` reaches the bus —
   the internal-inference artifact path that does not flow through a conversation prompt.
4. `recordKinds` filtering is exact, and an unknown conversation id matches nothing.
5. A throwing subscriber cannot fail a prompt or stop its siblings.
6. A consumer-direct `persistence.records.append()` is not observed.
7. Closing the Agent clears subscriptions.

```sh
bun run smoke-tests/test10-events/index.ts
```

The default adapter is Codex. Set `ACP_TEST10_ADAPTER=opencode` to use OpenCode. Set
`ACP_TEST10_DATA_DIR=/path/to/directory` to retain `agent.sqlite` for inspection; otherwise
the test uses and removes a temporary directory. The selected harness must already be
authenticated. The checkpoint phase generates a real summary with that harness, so the run
costs provider tokens.
