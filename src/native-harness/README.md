# Native harness

One agent entity, with a stable identity, talking on many channels. Consumers
configure its instructions, tools and policy. This directory lives inside acp-client but
is intended to become a separate package: it must not import acp-client modules.

## Current state

An initial in-memory agent, channel queues, terminal clients and tool loop are
implemented. A separate agent process accepts messages over HTTP on a Unix socket.
All channels use one shared in-memory context store. Each channel has a sequential
queue; different channels execute concurrently. It uses OpenRouter native tool calls and includes one harmless
`current_time`, `dashboard_work` and `notify_channel` tools. An experimental
in-process client/protocol subset is implemented; stdio is not implemented yet.
Experiments live in [.res/sandbox/](.res/sandbox/).

We are starting with a small, hands-on learning milestone before delegating the
broader implementation:

1. Send a message to a model and keep one conversation's history in memory.
2. Add one harmless tool and run the inner loop: model call, tool execution,
   matching tool result, next model call, until the model answers without tools.
3. Show requests, tool calls, results and stop reasons; enforce a call limit.
4. Reproduce the behavior offline with a scripted model before expanding it.

This milestone is a slice of the design, not completion of v1 part 1. Richer
sessions, participant policies, persistence, MCP and the
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

`bun run start` also starts a browser chat on port 3001, bound to the LAN. Open
one of the printed Web chat pairing links on a phone connected to the same Wi-Fi
(choose the computer's LAN address, not `127.0.0.1`). Select a channel and name,
press Connect and send a message. It uses the same agent as the terminal clients
and receives notice-triggered replies through the same output subscriptions.
The pairing link changes on restart; it grants access to this development chat,
not a verified participant identity. No provider key is sent to the browser.

Set `HARNESS_CHAT_PORT` to change port 3001, or use 0 for an available port. The
phone needs network access to that port. The inspector stays local-only on port
3000; the LAN chat does not expose its snapshots. Web chat currently shows future
replies, without replay or persistent browser history. Browser connections do not
automatically reconnect after a network loss; press Connect again.

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

The chat clients do not need provider credentials. Type `/exit` to disconnect,
or `/clear` to clear the terminal screen and scrollback without resetting history.
Clients subscribe to future channel replies before accepting input, so turns
started by notices also reach connected terminals. Each answer prints once,
independently of the HTTP response. You can type while work runs; incoming replies
redraw the prompt and preserve your draft. A lost subscription closes the chat
with a reconnect instruction. Subscriptions do not replay old answers.
An animated spinner appears beside the terminal prompt while a submitted request
is pending. It clears on completion or error and does not print animation frames
to non-interactive output.
Replies render common Markdown as terminal emphasis, readable bullets and code
blocks, rather than printing prose delimiters. Non-TTY output and `NO_COLOR`
disable ANSI styling; code contents retain their literal Markdown symbols.
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
`src/capabilities/tools/current-time.ts`. The startup command selects the
development tools in `src/capabilities/tools/scenario.ts`. Transport code lives in
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
inference; ordinary shared events do not wake idle channels or extend a turn.
Explicit notices do. Stopping the agent loses the shared store and dashboard job.

## Startup scenario and notices

The development system prompt describes a startup preparing its dashboard and
launch. `dashboard_work({})` advances a single shared dashboard job by one of five
steps. Each step waits five seconds in code, not in model narration. Only one
dashboard call per inference can advance work. Concurrent attempts return busy;
after five steps, additional calls report completion without advancing. No work
runs between calls. A running step is not interrupted; the model decides whether
to request another step after reading updated context.

`notify_channel({ channelId, text })` requests attention from an existing channel.
The source channel is supplied by the executor. A busy accepting turn queues the
notice and drains it before its next inference. If the model returns no tools
while notices remain, the loop continues. An idle or finishing channel schedules
a new turn. Inbox checking and finish admission are synchronous, avoiding a gap
where an accepted notice could be missed. There is no notice-pass limit.

The receipt acknowledges acceptance and delivery mode, not completed action.
Notices have a distinct `channel_notice` kind and source channel in the shared
store. Busy and idle delivery use the same internal-notice renderer; neither
impersonates a human participant. The API role remains `user`. In channel context
cards, notices are highlighted violet and participant prompts orange. Tool
definitions are collapsed under Tools in both Live context and Channels.
Notice-generated idle responses appear in the inspector and in subscribed
terminal clients for the target channel.
Unknown or failed channels reject notices with an actionable tool result.

To try the scenario, open `channel1 alice` and ask Alice's channel to finish the
dashboard for launch. During a step, tell `channel2 bob` that the design is not
approved, work must stop, and it should notify channel1. Inspect the notice and
subsequent iterations. Whether the model recognizes the update and chooses to
stop is behavior to evaluate, not hard-coded cancellation.

## Offline scripted model

Run the real in-memory store, context builder, scheduler and tool loop without a
model provider or API key:

```sh
bun run test:scenario test/fixtures/echo-scenario.json "Echo hello"
```

The command prints JSON containing the final answer, captured model requests,
recorded context entries and count of unused responses. It starts no servers.
This is the first test-mode increment, not the stdio protocol implementation.
Normal `start` still uses the live model and does not register `echo`.

Scenario format:

```json
{
  "version": 1,
  "responses": [
    {
      "content": "I'll echo that.",
      "calls": [
        { "id": "echo-1", "name": "echo", "arguments": { "text": "hello" } }
      ]
    },
    { "content": "The tool returned hello.", "calls": [] }
  ]
}
```

Each response consumes one model invocation. `content` is a required string or
null; `calls` defaults to an empty array when omitted. Calls require nonempty
names, IDs unique within that response, and JSON object arguments. The adapter
serializes those arguments to the existing neutral tool-call contract. Unknown
fields and malformed scripts fail before execution. Tool arguments are still
validated by the executor: for example, `{ "text": 42 }` reaches `echo` and
returns a tool error that the next model invocation can inspect.

`createScriptedModel(script)` in `src/capabilities/model/scripted.ts` returns
`{ model, requests(), remaining() }`. `loadScriptedModel(path)` loads the same
format from disk. Both use the existing `Model` interface. Captured messages and
tool definitions are copied at invocation time; inspection returns fresh copies.
Exhausted invocations are captured too. Script errors carry stable codes:
`invalid_script`, `script_load_failed`, or `script_exhausted`.

Responses are predetermined: the final answer does not prove the model interpreted
a tool result. Offline tests separately assert that `echo` executed and its actual
result reached the next captured request. No inference or API calls occur.
Each scripted instance has its own sequential position; use separate instances
when independent channel scripts are needed. No channel routing, delays or
conditional script steps are implemented yet.

## Experimental in-process protocol

Run the acceptance scenarios with `bun test test/protocol.test.ts`. They use the
real session assembly with one independent scripted model per channel and no API
keys. A host can drive the same setup through public entry points:

```ts
import { createInProcessHarness } from "./src/testing.ts";

const harness = createInProcessHarness();
const { client } = harness;
try {
  await client.initialize();
  await client.createSession({
    sessionId: "example",
    config: {
      version: 1,
      system: "You are a test assistant.",
      model: { protocol: "scripted", script: "test/fixtures/echo-scenario.json" },
    },
    participants: [{ id: "alice", kind: "person" }],
    channels: {},
  });
  const done = new Promise<void>(resolve => {
    client.onChannelEvent(({ channel, event }) => {
      console.log(channel, event);
      if (event.type === "turn_ended") resolve();
    });
  });
  await client.push({ channel: "channel1", item: {
    id: "message-1", kind: "user_message", sender: "alice",
    content: [{ type: "text", text: "Echo hello" }],
  } });
  await done;
  console.log(await client.idle());
} finally { harness.close(); }
```

`src/client.ts` exports `HarnessClient`, `HarnessClientError`, the in-process
transport factory and host types. `src/index.ts` exports host-independent
`createSession`, with injected model/tool implementations. Development startup
uses the same session assembly with OpenRouter, its tools and inspector wrappers.

The protocol carries JSON-RPC-shaped values with a JSON copy boundary. Supported
requests are `initialize`, `session/create`, `channel/push` and `session/idle`.
Initialize explicitly reports an experimental subset, memory-only acceptance and
no persistence. It supports final text and none/summary/full tool events; no
callbacks or other subscription fields yet. Full tool events retain JSON argument
and result strings; a completed tool event means execution returned, which can
include an actionable `{ ok: false }` result. Thrown execution errors emit failed.

Supported config is `{ version: 1, system, model: { protocol: "scripted", script } }`.
Participants support IDs and kinds, without labels or policy. Initial `channels`
must be empty; channels are created on push. Push supports text-only user messages
with queue delivery and wake=true. Unsupported fields, configurations and methods
fail explicitly. IDs deduplicate within the in-memory session; reusing an item ID
for different input fails with `item_conflict`. Unknown senders are recorded as IDs.

Events are `turn_started`, `turn_took`, `tool_call`, `message_completed`, and
`turn_ended`. Completed assistant text is published immediately after recording,
including text before tool calls, even if notices extend the turn. Each message
has an ID and is delivered once; clients no longer republish the final return.
Only turn lifecycle IDs are strings at the protocol boundary; the experimental
store still uses numeric turn IDs internally. Per-channel order is guaranteed,
not ordering across channels. Subscriptions deliver future events, without replay.

Client requests time out after 30 seconds by default (configurable in its
constructor); closing a client rejects pending requests and removes subscriptions.
It does not cancel already accepted work. Model exhaustion produces a failed turn
event after acceptance, not a failed push. Idle includes queued and running work.

This is not full protocol v1 conformance: durable acceptance, session loading and
restart reconciliation, holds, steering, interruption, permissions, usage,
streaming, progress heartbeats and stdio remain unimplemented. Protocol version 1
identifies these experimental message shapes, not a full compatibility claim.

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
