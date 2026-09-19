# Identity smoke test

Runs one SQLite-backed agent with three conversations against a real ACP harness:

1. Conversation A starts without knowing a unique codeword.
2. Conversation B supplies the codeword's answer.
3. A asks for that answer; the test asserts cross-conversation recall and a durable delivery cursor.
4. A newly created conversation C asks whether anyone previously asked for the answer; the test asserts it sees A's question.

```sh
bun run smoke-tests/test9-identity/index.ts
```

The default adapter is Codex. Set `ACP_TEST9_ADAPTER=opencode` to use OpenCode.
Set `ACP_TEST9_DATA_DIR=/path/to/directory` to retain `agent.sqlite` for inspection;
otherwise the test uses and removes a temporary directory. The selected harness
must already be authenticated. A `PASS` line is printed for each successful phase.

This scenario tests message-tail identity delivery. It intentionally does not trigger
checkpoint summarization or provider-session recovery; those have separate tests.
