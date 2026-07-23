layer
- Core modules: `adapters.ts`, `agent-client.ts`, `agent-session.ts`, `capabilities.ts`, `client.ts`, `config-options.ts`, and 8 more

## What it likely is

Based on the files and the `.res/acp.md` / `SPEC.md`, this appears to be a TypeScript library implementing the **Agent Client Protocol (ACP)**.

Would you like me to dig deeper into something specific — for example, the `package.json`, the `src/` files, or the specs/documentation?info prompt_end stopReason=end_turn status=completed chars=1283 elapsedMs=12660

you › So, it has a ∑
zsh: suspended  acp-lib chat --adapter kimi --verbose
[146] (1) /Users/qlairos/qlairoslabs/libs/acp-lib % code .                                           qlairos@Mac 23:57
(1) /Users/qlairos/qlairoslabs/libs/acp-lib % %                                                      qlairos@Mac 23:57
[1]  + continued  acp-lib chat --adapter kimi --verbose
you › So, it has a ∑



Sometimes it ends up freezed

and ctrl c or anything does not help





# Transcript implementation

Status: implemented in `acp-lib`.

## Purpose

The transcript is an opt-in, append-only JSONL file for repainting chat messages
without starting the agent/harness. It is intentionally a lightweight projection of the
conversation, not a full ACP event replay.

Current v1 writes:

- `meta/open` when an `AgentSession` starts
- `msg/user` before each prompt is sent
- `msg/assistant` after the prompt resolves, with final text, status, stop reason, and
  usage when available
- `msg/assistant` with `status: "error"` and any captured partial text if the prompt
  rejects

It does not currently write thinking, tools, plans, permission requests, or raw ACP
updates. The line envelope supports those later via `activity`, `permission`, and `raw`
line types.

## Session identifiers

At the `AgentSession` / `SessionManager` level:

- `agentSessionId`: stable id owned by this library for the durable `AgentSession`
- `internalSessionId`: ACP/harness session id returned by `codex-acp`, Kimi, etc.

At the `AgentController` / `AcpClient` level:

- `sessionId`: ACP/harness session id, because that layer has no outer `AgentSession`
  concept.

Transcript files should be keyed by `agentSessionId` or by a caller-owned conversation id,
not by `internalSessionId`, so the transcript can survive harness session churn.

## Configuration

`AgentSessionConfig` supports two transcript options:

```ts
transcriptPath?: string;
transcriptDir?: string;
```

Rules:

- `transcriptPath` is an exact file path chosen by the caller.
- `transcriptDir` lets the library choose the filename:
  `<encodeURIComponent(agentSessionId)>.jsonl`.
- Supplying both is a configuration error.
- Supplying neither leaves transcripts disabled.
- Parent directories are created automatically.
- Transcript writes are best-effort: failures are logged and do not fail the prompt.

Examples:

```ts
await AgentSession.create({
  adapter,
  adapterId: "codex",
  agentSessionId: "conv-123",
  transcriptDir: "/app/chats",
});
// writes /app/chats/conv-123.jsonl
```

```ts
await AgentSession.create({
  adapter,
  adapterId: "codex",
  transcriptPath: "/app/chats/custom-name.jsonl",
});
// writes exactly that file
```

## JSONL format

Each line is one JSON object with `v: 1` and a `t` discriminator.

```json
{"v":1,"t":"meta","event":"open","ts":1784847511315,"internalSessionId":"019f...","adapter":"codex"}
{"v":1,"t":"msg","role":"user","text":"Reply with exactly: transcript ok","ts":1784847511317}
{"v":1,"t":"msg","role":"assistant","text":"transcript ok","ts":1784847523961,"usage":null,"stopReason":"end_turn","status":"completed"}
```

Exported reader functions:

```ts
readTranscript(path, opts?)
readTranscriptLines(path, opts?)
appendTranscriptLine(path, line)
```

`readTranscript` returns message entries only. `readTranscriptLines` returns all
recognized line types. Malformed and unknown lines are skipped.

Supported read options:

```ts
{
  before?: number; // return entries older than this timestamp
  limit?: number;  // keep the newest matching entries
}
```

## Write ordering

`AgentSession` now owns a small prompt queue. The lower `AcpClient` already serialized
prompts, but queuing at `AgentSession` ensures transcript order matches turn execution:

```text
user A
assistant A
user B
assistant B
```

instead of recording multiple user messages before the first assistant response when
callers issue concurrent prompts.

## Tests

Unit/integration coverage:

- `test/transcript.test.ts`: JSONL append/read, meta skipping, malformed-line tolerance,
  `before`/`limit`, missing files.
- `test/agent-session-transcript.test.ts`: `transcriptDir` naming and config rejection
  when both path and dir are provided.

Manual/local smoke scripts:

- `local/test1/transcript-smoke.ts`
  - deterministic fake ACP harness
  - exercises `AgentSession -> AgentController -> AcpClient -> AcpTransport`
  - writes `local/test1/chats/smoke.jsonl`

- `local/test1/codex-acp-test.ts`
  - real `codex-acp` smoke test
  - writes timestamped `local/test1/chats/codex-acp-<ts>.jsonl`
  - defaults to `gpt-5.4`, override with `CODEX_ACP_MODEL`
  - should remain manual because it depends on local auth/account/model availability

Verification after implementation:

```bash
bun run typecheck
bun test
bun local/test1/transcript-smoke.ts
bun local/test1/codex-acp-test.ts
```
