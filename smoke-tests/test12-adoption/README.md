# Adoption smoke test

Adopts an existing session of a real harness (`agent.conversations.create({ adopt })`) and checks what was stored.
Like `end-to-end`, running it leaves `agent.sqlite` in this directory (replaced on every run, git-ignored).

```sh
bun smoke-tests/test12-adoption/index.ts                         # codex, first listed session, no model call
ACP_TEST12_ADAPTER=opencode bun smoke-tests/test12-adoption/index.ts
ACP_TEST12_SESSION=<id> ACP_TEST12_LAST=all bun smoke-tests/test12-adoption/index.ts
ACP_TEST12_RECAP=1 bun smoke-tests/test12-adoption/index.ts      # also asks the session to summarize itself (spends tokens)
```

It lists the harness's sessions (`session/list`), adopts one, imports the last N turns of its replay, then checks that
the conversation is marked adopted, the provider session is recorded, imported messages are stored and marked, adopting
the same session again is refused naming the owner, the listing shows who owns it, and the conversation reopens by loading
the same session. Without `ACP_TEST12_RECAP=1` no model call is made: listing, loading and importing a replay do not
need one. The adapter must already be authenticated.

Variables: `ACP_TEST12_ADAPTER`, `ACP_TEST12_SESSION`, `ACP_TEST12_LAST` (a number, `0` or `all`), `ACP_TEST12_RECAP`,
`ACP_TEST12_LIST_LIMIT`, `ACP_TEST12_DATA_DIR`.
