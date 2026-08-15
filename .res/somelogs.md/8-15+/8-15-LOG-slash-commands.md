# Slash commands and AgentSession operations — implementation log

Branch: `feat/agent-session-operations`

This is the running implementation log for the staged AgentSession operations work. A
new entry is appended only after each part is finished and verified.

## Part 1 — consumer operations smoke contract

Status: complete

### Purpose

Before changing the public API, establish one executable scenario showing how an
orchestration consumer should use all three operational levels:

1. Catalog-level management through `SessionManager` and `SessionStore`.
2. Stable logical-session control through `AgentSession`.
3. Harness-specific command discovery and invocation over ACP.

The scenario is deliberately non-interactive. Slash syntax is a possible UI binding, not
the underlying consumer contract. This keeps the smoke test focused on library operations
rather than readline, terminal rendering, or command parsing.

### Files added

- `smoke-tests/test5-operations/README.md`
- `smoke-tests/test5-operations/operations-smoke.ts`
- `smoke-tests/test5-operations/operations-agent.ts`

### Contract established

The smoke consumer constructs a file-backed catalog and creates two logical sessions with
custom fake adapters. It pins the following intended API and invariants:

- `agentSessionId` is the consumer's permanent identity and never changes.
- `internalSessionId` is the current provider-thread identity and may change.
- `AgentSession.state`, `isBusy`, and `queuedOperationCount` expose authoritative runtime
  state.
- `AgentSession.subscribe(listener)` exposes ordered session lifecycle notifications.
- Turn start/completion and harness-command changes are observable by listeners.
- `agentCommands` exposes the harness's current advertised command set.
- `executeAgentCommand(name, input?)` explicitly invokes a harness command.
- `handoff({summary})` retains the same `AgentSession` and `agentSessionId`, creates a new
  internal session, updates the existing catalog record, and emits lifecycle events.
- The logical transcript spans the handoff and contains a typed handoff boundary.
- `AgentSession.restore(...)` reconstructs a stopped logical session from its catalog
  record using a consumer-provided adapter resolver.
- Creating a second logical session makes both records visible through
  `SessionManager.list()`.

Planned methods are feature-detected at runtime. This lets the existing part of the
scenario execute while missing future APIs are reported as explicit red checks. The smoke
entry itself remains syntactically valid and bundleable throughout the staged work.

### Deterministic ACP fixture

`operations-agent.ts` is a standalone fake ACP process. It:

- Implements initialize, session/new, session/load, session/list, session/prompt, and
  session/cancel.
- Gives each new internal thread a deterministic distinct id.
- Advertises `status` during session creation.
- Adds `usage`, including its unstructured input hint, during the first prompt.
- Returns recognizable responses for `/status` and `/usage`.
- Recognizes the handoff seed text so a later handoff implementation can prove that the
  replacement thread received the continuation context.

The fixture is colocated with the smoke consumer but kept in a separate process entry so
the consumer and harness each have one responsibility.

### Failure classification

The script uses these exit codes:

- `0`: the complete operations contract passed.
- `1`: the scenario ran and an operation is missing or incorrect.
- `2`: the fixture/transport could not run, so the contract is inconclusive.

A configurable watchdog (`SMOKE_TIMEOUT_MS`, default 15 seconds) prevents transport startup
problems from hanging indefinitely. Output is explicitly flushed before exit because ACP
stream readers can retain an event-loop handle briefly after process termination under
Bun.

### Verification

- `bun run typecheck` passed.
- Both new smoke entries bundled successfully with `bun build --target=bun`.
- The fake harness responded correctly when driven directly with an initialize request.
- In the current managed sandbox, ACP subprocess tests stall before the harness receives
  initialize. Existing subprocess-based transcript tests display the same baseline
  behavior (`ACP connection closed` / timeout), so this is not classified as a Part 1 API
  failure. The new smoke watchdog correctly reports it as inconclusive with exit code 2.

### Deliberately not implemented in Part 1

- AgentSession state/listeners.
- Explicit harness-command execution.
- Handoff behavior or transcript lines.
- Restoration helpers.
- REPL or slash-command changes.

