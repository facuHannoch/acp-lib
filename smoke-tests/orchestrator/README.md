# Orchestrator smoke test

Run the scripted, free stdio case from the repository root.

```sh
bun smoke-tests/orchestrator/run.ts
```

Live mode requires explicit authorization for provider spend and the isolated Codex login copy, plus `ACP_ORCH_LIVE=1`, an `OPENROUTER_API_KEY` in the environment, and local `codex` and `codex-acp` binaries. It uses a temporary workspace and Codex home, asks for one approved file operation, and redirects the worker to another new native conversation. The open permission stays with the original conversation. The result must reach the new destination as one notice.

The script limits the run to two native prompts, two worker submissions and six OpenRouter requests. A seven-minute work deadline allows a minute for cleanup within an eight-minute supervising limit. The Codex CLI controls its own internal model calls.
