# Note: a model-call controller (no harness)

2026-10-17. Idea, not a plan. Recorded so that the work in between (operation lifecycle, the 10-13 requirements)
does not close doors on it.

## The idea

Today a conversation is driven by `AgentController`, which runs one leaf at a time: `normal` (`AcpClient`, a harness
over ACP) or `degraded` (`PtyClient`, the harness's terminal UI; exists, not usable without more work, deferred). Both
need a harness process.

A third kind would call a model API directly (API key, or an OpenAI/Anthropic-compatible gateway) with no harness:
a chatbot that keeps the conversation's identity, persistence, metering, steering and checkpoints.

Why:
- cheaper, faster and more flexible when only conversation is needed;
- usable by untrusted users (no file system, no commands);
- scales: a harness costs hundreds of MB per conversation; a model-call conversation costs a request.

Trade-off: no actions, no files (until the library has its own tool layer, the "outer harness" that was always meant
to come), and API-key auth instead of a harness login.

## What changes underneath: who owns the context

With a harness, the provider holds the history and the library mirrors it (`session/load`, adoption, recovery all
exist because the harness is the source of truth). With model calls, the library is the source of truth:

- each prompt sends a message list built from what is stored (or held in memory); `load` is a rebuild from records;
  recovery is trivial; adoption does not apply;
- context-window management is the library's job. The adoption checkpoint floor already has the shape: checkpoint
  summary + the messages after it. Checkpoints become the compaction mechanism, not only a recovery artifact;
- metering is exact per call (the `per_turn` reading);
- steering has no tool boundaries: abort the stream and re-request with the message added, or deliver at turn end;
- parts/media (requirements 6–8 of `10-13-acp-client-requirements.md`) are mapped to each API's content format, so
  the `parts` model must be the library's own, not ACP content blocks.

## First user: internal inference

Checkpoints and recovery seeds are one prompt and one answer. Running them as model calls instead of a disposable
harness session per attempt removes the process cost and the harness's own background work (OpenCode's title request,
see the 10-14 entries of `10-4-LOG-adopt-provider-session.md`). This could come before any chat use.

## Untrusted users and identity

The risk is not only tools. An untrusted user's conversation feeds the Agent's shared memory, which trusted
conversations then read: a prompt-injection path. Per-conversation control over contributing to and receiving identity
(the parked `identity: false`, `todos/10-2-TODO-attach-and-identity-false.md`) becomes a requirement for this.

## Prerequisite: a provider-session interface

`AgentClient` (`prompt`, `interrupt`, `stop`) is the nominal contract, but `agent-session.ts` (~4.5k lines) uses much
more of `AgentController`, all ACP-shaped. Counted on 2026-10-17: `configOptions` (27 uses), `isDegraded` (8), `start`
(6), `setConfig` (5), `currentMode` (4), `setMode` (3), `prompt` (3), `startFresh`, `interrupt`, `currentSessionId`,
`capabilities` (2 each), `subscribeUsageUpdate`, `subscribeAvailableCommands`, `stop`, `listSessions`, `bridge`,
`availableCommands`, `authenticate` (1 each), plus `session/load` with replay and `session/delete` through the client.

A third controller first needs that surface extracted into an interface the conversation layer depends on, with ACP
and PTY as two implementations and the ACP-only parts (load, list, delete, modes, commands) as optional capabilities.

## Order

1. Operation lifecycle guarantees (never invisible, never stuck) designed **above** the controller, with each controller
   supplying only `cancel` and `forceStop` primitives (ACP: `session/cancel`, kill the process; model calls: abort the
   request, drop the connection). This is the first slice of the interface.
2. The 10-13 requirements, keeping `parts` in library terms.
3. The provider-session interface extraction (the refactor).
4. The model-call runtime for internal inference.
5. The model-call controller for conversations; then identity controls for untrusted conversations; then tools.
