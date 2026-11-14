# Native harness

One agent entity, with a stable identity, talking on many channels. Consumers
configure its instructions, tools and policy. This directory lives inside acp-client but
is intended to become a separate package: it must not import acp-client modules.

## Current state

An initial in-memory agent, channel queues, terminal clients and tool loop are
implemented. A separate agent process accepts messages over HTTP on a Unix socket.
Each channel has its own history and sequential queue; different channels execute
concurrently. It uses OpenRouter native tool calls and includes one harmless
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
sessions, participant policies, shared identity context, persistence, MCP and the
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
the agent and shows channels, participants, pending turns, execution status and
live message history, including tool calls and results. Expand an inference
request to see the exact JSON body sent to OpenRouter, including context and tool
definitions. Authorization headers are not captured. Snapshots remain unchanged
as later turns run. Provider response details can also be expanded in history.

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

`cli/main.ts` assembles the agent with a `systemPrompt` variable, model and tools.
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

`kernel/agent.ts` owns channels and queues; `kernel/loop.ts` coordinates turns;
`model/openrouter.ts` translates provider messages. Tool definitions and execution
are configured at the CLI entry point. Only `current_time` is permitted. New
transport code follows the grouped layout at `src/interfaces/protocol/local.ts`;
earlier files have not been relocated yet.

Offline tests cover loop continuation, provider request mapping, channel
concurrency and ordering, history separation, failure isolation and Unix HTTP
requests, immutable inspection snapshots and SSE updates/reconnection. Socket
and inspector tests require permission to open local listeners. No runtime
dependencies were added.

This first slice has no call limit, streaming, persistence, cancellation or
model timeout. A model or unexpected execution failure blocks that channel until
agent restart, avoiding reuse of an incomplete tool exchange; other channels keep
working. Tool errors are returned to the model. Disconnecting a client does not
cancel an accepted turn. Channels do not yet share experience or memory.

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
