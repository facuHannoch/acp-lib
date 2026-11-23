# Orchestrator smoke test

Run the scripted, free stdio case from the repository root.

```sh
bun smoke-tests/orchestrator/run.ts
```

Live mode requires explicit authorization for provider spend, plus `ACP_ORCH_LIVE=1`, an `OPENROUTER_API_KEY` in the environment, local `codex` and `codex-acp` binaries, and a separately authenticated disposable `ACP_ORCH_CODEX_HOME`. Supply and manage that home yourself. The runner refuses the user's home and any directory that overlaps the normal Codex home. It creates no credential copy and leaves the supplied home in place.

The worker asks for one approved file operation. The open permission stays with the original conversation and the result must reach the redirected destination as one notice. Override the planned models with `ACP_ORCH_NATIVE_MODEL` and `ACP_ORCH_WORKER_MODEL`. Free mode prints the selections and verifies the installed bridge's read-only mode by reading its bundle without starting it. The bridge uses user-reviewed, on-request approvals with a read-only sandbox and network access disabled. The live worker writes only to a single file in the run tree outside its working directory.

The runner logs only permission tool kinds, a redacted command, option kinds and the resulting selection. The private JSONL trace belongs to the run tree and is removed with it. The runner prints a short summary, including when no ACP permission packet arrived.

The script limits the run to two native prompts, two worker submissions and six OpenRouter requests. The Codex CLI's internal model calls are uncapped.

The seven-minute work deadline and SIGINT or SIGTERM cancel work that observes the signal. Shutdown, including `Agent.close()`, still runs to completion and may wait on the provider. When running live, supervise the process with `timeout --signal=TERM --kill-after=10s 470s` to enforce the eight-minute wall cap. An uncatchable kill can leave an `acp-orch-live-*` work tree without a login file.
