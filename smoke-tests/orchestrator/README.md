# Orchestrator smoke test

Run the scripted, free stdio case from the repository root.

```sh
bun smoke-tests/orchestrator/run.ts
```

Live mode requires explicit authorization for provider spend, plus `ACP_ORCH_LIVE=1`, an `OPENROUTER_API_KEY` in the environment, local `codex` and `codex-acp` binaries, and a separately authenticated disposable `ACP_ORCH_CODEX_HOME`. Supply and manage that home yourself. The runner creates no credential copy and leaves the supplied home in place. It cleans its own work tree on normal exit, SIGINT and SIGTERM. An uncatchable kill can leave an `acp-orch-live-*` work tree without a login file.

The worker asks for one approved file operation. The open permission stays with the original conversation and the result must reach the redirected destination as one notice. Override the planned models with `ACP_ORCH_NATIVE_MODEL` and `ACP_ORCH_WORKER_MODEL`. Free mode prints the selections without contacting either provider.

The script limits the run to two native prompts, two worker submissions and six OpenRouter requests. A seven-minute work deadline allows a minute for cleanup within an eight-minute supervising limit. The Codex CLI's internal model calls are uncapped.
