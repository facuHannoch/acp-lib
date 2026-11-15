# Native harness

One agent entity, with a stable identity, talking on many channels. Consumers
configure its instructions, tools and policy. This directory lives inside acp-client but
is intended to become a separate package: it must not import acp-client modules.

## Current state

An initial in-memory agent, channel queues, terminal clients and tool loop are
implemented. A separate agent process accepts messages over HTTP on a Unix socket.
All channels use one shared in-memory context store. Each channel has a sequential
queue; different channels execute concurrently. It uses OpenRouter native tool calls and includes one harmless
`current_time` tool. There is no complete public session API or stdio protocol yet.
Experiments live in [.res/sandbox/](.res/sandbox/).

We are starting with a small, hands-on learning milestone before delegating the
broader implementation:

1. Send a message to a model and keep one conversation's history in memory.
2. Add one harmless tool and run the inner loop: model call, tool execution,
   matching tool result, next model call, until the model answers without tools.
3. Show requests, tool calls, results and stop reasons; enforce a call limit.
4. Reproduce the behavior offline with a scripted model before expanding it.

This milestone is a slice of the design, not completion of v1 part 1. Richer
sessions, participant policies, notices, persistence, MCP and the
host protocol remain to be built. Coding-worker integration belongs to acp-client.

## Development

This directory is an independent TypeScript and Bun project (Bun >= 1.3.5), with
its own package manifest, lockfile and TypeScript configuration. It does not
depend on the parent acp-client package. Development dependencies are TypeScript
and Bun types; there are no runtime dependencies.

From this directory:

```sh
bun install
bun run typecheck
bun run test
OPENROUTER_API_KEY=your-key bun run start
```

Leave the agent running. In separate terminals, from this directory:

```sh
bun run chat channel1 alice
bun run chat channel2 bob
```

Open `http://127.0.0.1:3000` for the read-only context inspector. It starts with
the agent and opens on Live context, showing the rendered shared base and tool
definitions in one plain-text container. The system prompt and tools are visible
immediately, before any inference. Shared history updates as events are recorded;
the view excludes channel routing and active-turn additions. The same shared-base
builder is used to construct inference contexts.
Timeline is an empty placeholder. Channels shows participants, pending turns,
execution status and turns separated by their IDs. Each turn groups inference
iterations into an orange context card (with the initiating prompt highlighted)
and a blue result card, including tool calls and results. Expand Inference request
under its context for the exact JSON sent, or Provider response under its result
for the original assistant message. Authorization headers are not captured.
Snapshots remain unchanged as later turns run.

The page receives live updates over Server-Sent Events and reconnects with a
fresh snapshot. Set `HARNESS_INSPECTOR_PORT` on the agent to override port 3000
(use 0 to choose an available port); the actual URL is printed at startup.
The inspector binds only to `127.0.0.1` and stops with the agent. Inspection
history is in memory, grows during the run, and is lost on restart. It is a local
development view, without participant access controls or editing capabilities.

The chat clients do not need provider credentials. Type `/exit` to disconnect.
Reconnecting to the same channel continues its history while the agent is alive.
Ctrl+C in the agent terminal stops it and loses all histories. Ask for the current
time to exercise tool use. Tools and results are logged in the agent terminal;
chat clients receive the final answer.

`src/interfaces/cli/main.ts` dispatches commands; `start.ts` beside it assembles
the agent and servers, and `chat.ts` owns terminal interaction. Development
defaults, including `systemPrompt`, live in `src/runtime/config/development.ts`.
The default model is `deepseek/deepseek-v4.1-flash`; override it with
`OPENROUTER_MODEL` on the agent process. Each input includes a participant ID,
which is labeled in model context. This is caller-supplied identity, not
authentication or a participant policy system.

The default socket is `native-harness-<uid>/agent.sock` under the OS temporary
directory. Its directory and socket are restricted to the current user. Set
`HARNESS_SOCKET` to an absolute socket path on both server and clients to override
it; the parent directory must exist. A second agent cannot use an occupied socket.
The Unix socket transport targets Linux/macOS. Its `/messages` endpoint is an
experimental local interface, not the eventual host protocol.

`src/kernel/channels.ts` owns channels and queues; `src/kernel/loop.ts` coordinates
turns; `src/capabilities/model/openrouter.ts` translates provider messages. The
time tool owns its definition, validation and execution in
`src/capabilities/tools/current-time.ts`; the startup command selects it. Only
`current_time` is permitted. Transport code lives in
`src/interfaces/protocol/local.ts`. Inspection wrappers live in
`src/interfaces/inspector/observe.ts`, keeping observation out of the kernel.

The shared store is `src/state/storage/shared-context.ts`. It records inputs on
acceptance, including queued inputs, then assistant responses and tool results
with channel, turn and sender attribution. It copies entries on append and read.
There are no independent per-channel history arrays in the agent.

Before every inference, `src/capabilities/context/build.ts` renders a fresh store
snapshot with the unchanged system prompt. Other turns are attributed JSON
history; the active turn preserves native assistant/tool exchanges. Opaque
provider state is not exposed in shared text. Tools remain a separate request
field. All channels currently see all shared events; there is no scope filtering,
summary, compaction or context budget. Rebuilding shared history also changes the
request prefix; caching optimization is deferred.

Live context shows the current shared base; Channels provides per-channel
projections and exact inference snapshots. Those requests show how `context.build()`
rendered a store snapshot for a particular turn. The live view is not a currently
running model's hidden state.

Offline tests cover loop continuation, provider request mapping, channel
concurrency and ordering, history separation, failure isolation and Unix HTTP
requests, immutable inspection snapshots and SSE updates/reconnection. Socket
and inspector tests require permission to open local listeners. No runtime
dependencies were added.

This first slice has no call limit, streaming, persistence, cancellation or
model timeout. A model or unexpected execution failure blocks that channel until
agent restart, avoiding reuse of an incomplete tool exchange; other channels keep
working. Tool errors are returned to the model. Disconnecting a client does not
cancel an accepted turn. New shared events are visible at the next ordinary
inference; they do not wake idle channels or extend a turn. Notices are not yet
implemented. Stopping the agent loses the shared store.

## Documents

- [Architecture](ARCHITECTURE.md): boundaries, extension points and intended layout.
- [Contribution rules](AGENTS.md): instructions for implementing and reviewing changes.
- Decision records belong in `.res/decisions/` within this directory; create them
  as decisions are made. Other working notes and experiments also belong in `.res/`.

The detailed design references remain in the repository's research directory:

- [Design and rationale](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-design.md)
- [Project organization](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-project.md)
- [V1 scope and acceptance](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-v1.md)
- [Host protocol](../../.res/somelogs.md/11-11+/11-12-SPEC-harness-protocol.md)
- [Library integration](../../.res/somelogs.md/11-11+/library/11-11-SPEC-native-harness-integration.md)

These references describe the intended system, not implemented behavior. The
owner's later instruction places decision records in `.res/decisions/` rather
than the top-level `decisions/` shown in the original project spec.
