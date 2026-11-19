# Native harness

One agent entity, with a stable identity, talking on many channels. Consumers
configure its instructions, tools and policy. This directory lives inside acp-client but
is intended to become a separate package: it must not import acp-client modules.

## Current state

An agent with durable sessions, terminal clients and a tool loop is
implemented. A session can live in memory or in a SQLite file, survive restarts
and crashes, be suspended and resumed, and be exported and imported. A separate agent process accepts messages over HTTP on a Unix socket.
All channels share one session timeline held by a storage adapter. Each channel
runs one turn at a time; different channels execute concurrently. It uses OpenRouter native tool calls and includes one harmless
`current_time`, `dashboard_work` and `notify_channel` tools. An experimental
client/protocol subset is implemented over in-process and stdio transports.
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

That session lives in memory. To keep it in a SQLite file, name one:

```sh
bun run start --db ./dev.sqlite --create   # first run: the file must not exist
bun run start --db ./dev.sqlite            # later runs: the file must exist
bun run start --db ./dev.sqlite --resume   # also resume a suspended session
bun run status                             # lifecycle, active turns, pending input
bun run suspend                            # pause cleanly; waits for running tools
bun run resume                             # continue a suspended session
```

Opening a database restores its timeline and never continues work by itself.
Turns a previous process left unfinished are marked interrupted and are not
retried; input that was accepted but never taken runs. A suspended session
stays paused, and refuses new messages, until `bun run resume` or `--resume`.
Ctrl+C stops at once: running turns are recorded as interrupted, so run
`bun run suspend` first to pause without losing work in progress. `status`,
`suspend` and `resume` talk to the running agent over its Unix socket; they are
not available from the LAN chat. `--script <file>` replaces the provider with
a scripted model for offline runs without a key; the file is one script, or
`{ "channels": { "<id>": script }, "default": script }`. The simulated
dashboard job is process state and starts over in each process.

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
The inspector binds only to `127.0.0.1` and stops with the agent. Its header
shows the session's lifecycle and storage, and each channel shows whether a
turn is running or checkpointed, its pending input, and a latest turn that
ended failed or interrupted with any tool calls left uncertain. With a
database, the shared timeline, Live context and channel messages are restored
at startup, before any new message. Captured inference requests are in memory,
grow during the run, and are lost on restart. It is a local
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
Messages sent to a channel while it is working join the turn in progress, and
their requests all complete with that turn's last reply.
A request still waiting when its turn is checkpointed by suspension is answered
with an explanation; the reply arrives through the subscription after resume.
Ctrl+C in the agent terminal stops it; without `--db` all history is lost. Ask for the current
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

Execution runs on the storage contract in `src/contracts/storage.ts`
([decision 0013](.res/decisions/0013-durable-delivery-contract.md)).
`src/state/storage/engine.ts` implements it once, over row access provided by
`memory.ts` (maps) and `sqlite.ts` (`bun:sqlite`, one file per session,
exclusive ownership through SQLite's file lock, `synchronous=FULL`).
`archive.ts` validates and restores logical session archives. Both adapters
pass the shared suite:

```sh
bun test test/storage-memory.test.ts test/storage-sqlite.test.ts
```

An accepted message or notice is first committed to a pending inbox and
acknowledged (`send` returns synchronously; it never waits for a reply). The
channel takes pending items into its timeline when it can: an active turn takes
them before its next inference, otherwise they start the channel's next turn.
One turn can hold several inputs. Assistant responses and tool results are
recorded with channel, turn and sender attribution before their events are
published. `createSession` uses memory storage unless given a storage handle,
and runs nothing until `start()`. `bun run start --db <file>` and the scripted
stdio server (`serve --stdio --home <directory>`) both use the SQLite adapter.

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

This slice has no call limit, streaming or model timeout. A model or unexpected
execution failure ends that turn as failed; its channel accepts and runs new
work, as do other channels. Tool calls of a failed or interrupted turn that
have no recorded result are listed as uncertain, described to the model in later
context, and never executed again by the harness. Tool errors are returned to
the model. Disconnecting a client does not
cancel an accepted turn. New shared events are visible at the next ordinary
inference; ordinary shared events do not wake idle channels or extend a turn.
Explicit notices do. Stopping the agent loses the dashboard job, and the
session too unless it was started with `--db`.

## Startup scenario and notices

The development system prompt describes a startup preparing its dashboard and
launch. `dashboard_work({})` advances a single shared dashboard job by one of five
steps. Each step waits five seconds in code, not in model narration. Only one
dashboard call per inference can advance work. Concurrent attempts return busy;
after five steps, additional calls report completion without advancing. No work
runs between calls. A running step is not interrupted; the model decides whether
to request another step after reading updated context.

`notify_channel({ channelId, text })` requests attention from an existing channel.
The source channel is supplied by the executor. Notices and messages share one
delivery rule: a busy turn takes them before its next inference, and if the
model returns no tools while items are pending, the loop continues. Otherwise
they start the channel's next turn. The pending check and the turn's completion
are one storage transaction, so an item arriving as a turn finishes joins that
turn or starts the next one, exactly once. There is no notice-pass limit.

The receipt acknowledges acceptance, not completed action.
Notices have a distinct `channel_notice` kind and source channel in the shared
store. Busy and idle delivery use the same internal-notice renderer; neither
impersonates a human participant. The API role remains `user`. In channel context
cards, notices are highlighted violet and participant prompts orange. Tool
definitions are collapsed under Tools in both Live context and Channels.
Notice-generated idle responses appear in the inspector and in subscribed
terminal clients for the target channel.
A notice to a channel that has never received a message is refused with an actionable tool result.

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

## Experimental protocol and in-process client

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
requests are `initialize`, `session/create`, `session/load` (durable servers
only), `session/messages`, `session/status`, `session/suspend`,
`session/resume`, `session/stop`, `channel/push` and `session/idle`, plus
`session/export`, `session/import` and `transfer/{open,write,read,close}` on
durable servers.
Initialize reports an experimental subset and whether this server's acceptance
is `memory` or `durable`. It supports final text and none/summary/full tool events; no
callbacks or other subscription fields yet. Full tool events retain JSON argument
and result strings; a completed tool event means execution returned, which can
include an actionable `{ ok: false }` result. Thrown execution errors emit failed.

Supported config is `{ version: 1, system, model: { protocol: "scripted", script } }`.
Participants support IDs and kinds, without labels or policy. Initial `channels`
must be empty; channels are created on push. Push supports text-only user messages
with queue delivery and wake=true. Unsupported fields, configurations and methods
fail explicitly. The push response is sent after the item is committed to the
inbox and reports it as `received`; it never carries a reply. Storage
deduplicates item IDs, across restarts on a durable server: the same ID and
content returns the original item's current milestone and turn, and different
content fails with `item_conflict`. Unknown senders are recorded as IDs.

`session/load` opens an existing session and returns one view at a storage
revision: status, turns, items with their last confirmed milestone, and
committed assistant messages with stable IDs (paged with `session/messages`).
Opening interrupts turns a previous process left unfinished; it never replays
them. Pending input becomes eligible only after the load response is written,
so live events for recovered work follow it, and every event carries the
revision of the commit it reports. A view that cannot fit one frame fails with
`transfer_limit`.

`session/suspend` refuses new messages at once, lets each active turn finish
its current inference and the tools it requested, then completes turns that are
naturally finished and checkpoints the rest. It responds when the session is
`suspended`, which can take as long as a running tool. Notices from finishing
work are still accepted and wait. A suspended session, including one loaded in
a new process, runs nothing until `session/resume`; resumed turns take their
pending input and continue at the next inference without repeating recorded
tool calls. Resume fails with `incompatible`, changing nothing, if a checkpoint
was saved under a different system prompt or script. `session/stop` is
immediate: it cancels inference and tools, reports active turns `interrupted`,
leaves pending input pending, and makes this process refuse further work with
`stopped`. Lifecycle changes arrive as `session/event` notifications
(`HarnessClient.onSessionEvent`).

`session/export` writes the whole session as a `.harness` archive: exactly
one UTF-8 JSON document of the logical session (metadata, channels, turns,
timeline, pending input, deduplication records, checkpoints and ID counters),
versioned separately from the SQLite schema. It is allowed only when the
session is cleanly suspended, or running with nothing active or pending;
otherwise it fails `busy`. The reported length and SHA-256 are those of the
file bytes. `session/import` validates the whole document and then publishes
it atomically as a new session, optionally under a new session ID, without
opening or resuming it; an existing destination or an invalid archive leaves
nothing behind. Both take a file path when host and harness share a
filesystem, or a transfer when they do not: `HarnessClient.exportArchive()`
and `importArchive(bytes)` move the bytes in 512 KiB chunks, so an archive can
exceed the 1 MiB frame. One transfer may be open per connection, archives are
limited to 256 MiB, and a transfer's temporary file is removed when it is
closed, imported, idle for 60 seconds, or its connection ends. To relocate a
session, stop the source before resuming the copy: import makes a copy, and
both would otherwise run the same pending work.

Events are `turn_started`, `turn_took`, `items_receipt`, `tool_call`,
`message_completed`, `turn_suspended`, `turn_resumed` and `turn_ended`. `turn_started` and `turn_took` list the
item IDs that turn took, which is how an accepted input is matched to its
outcome. `turn_ended` reports `completed`, `failed` or `interrupted`. Completed assistant text is published immediately after recording,
including text before tool calls, even if notices extend the turn. Each message
has an ID and is delivered once; clients no longer republish the final return.
Only turn lifecycle IDs are strings at the protocol boundary; the experimental
store still uses numeric turn IDs internally. Per-channel order is guaranteed,
not ordering across channels. Subscriptions deliver future events, without replay.

Client requests time out after 30 seconds by default (configurable in its
constructor); closing a client rejects pending requests and removes subscriptions.
It does not cancel already accepted work. Model exhaustion produces a failed turn
event after acceptance, not a failed push. Idle includes pending and running work.

This is not full protocol v1 conformance: holds, permissions, usage,
streaming and progress heartbeats remain unimplemented. Protocol version 1
identifies these experimental message shapes, not a full compatibility claim.

## Stdio server and client transport

Start the protocol-only process with:

```sh
bun run serve --stdio
```

It waits for JSON-RPC requests, one UTF-8 JSON message per line. It starts no web
servers or REPL and requires no API key. Select the scripted model in
`session/create`, exactly as in the in-process example above. Relative script
paths resolve against the child process's working directory. Stdout contains
only protocol responses/events; diagnostics go to stderr.

The consumer owns launching and terminating the child. From this package's working
directory, connect the same public client like this, then use the initialize,
createSession, push and event methods in the preceding example:

```ts
import { HarnessClient, createStdioTransport } from "./src/client.ts";

const child = Bun.spawn([
  process.execPath, "src/interfaces/cli/main.ts", "serve", "--stdio",
], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });

const client = new HarnessClient(createStdioTransport({
  readable: child.stdout,
  exited: child.exited,
  async write(bytes) {
    child.stdin.write(bytes);
    await child.stdin.flush();
  },
  async end() { await child.stdin.end(); },
}));

// Drive client.initialize(), createSession(), push(), and onChannelEvent().
// When done:
client.close(); // rejects pending calls, flushes queued writes, closes stdin
const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
try { await child.exited; } finally { clearTimeout(deadline); }
```

Unexpected EOF, malformed server messages, write failure or nonzero process exit
close the connection and reject pending/future calls with `transport_closed`,
rather than waiting for the normal request timeout. Explicit client close uses
`closed`. Both transports expose closure notifications. The transport does not
restart or kill the process, capture stderr, or retry accepted requests.

Frames are limited to 1 MiB and queued writes to 4 MiB. UTF-8 characters and JSON
lines may span chunks. Blank lines are ignored; a partial line at EOF is an error.
Malformed client JSON produces a parse-error response and later valid lines still
work. Malformed server output is fatal to its client connection.

Stdin EOF is stop: the server cancels inference and tools, records active turns
as interrupted, leaves pending input pending, flushes protocol output and exits.
It does not wait for work to finish. A host that needs completed work waits for
idle, or suspends, before closing. The five-second grace period only bounds
requests already read and the final flush; exceeding it exits nonzero with
stderr diagnostics. With `--home <directory>` each session is a SQLite file named
after its ID in that directory, and work the process did not finish is reported
as interrupted when the session is next loaded. Hosts retain a process termination deadline.

Run `bun test test/protocol.test.ts test/stdio.test.ts` for transport parity and
framing/process lifecycle checks. Child stdin in Bun uses IPC and may require
local IPC permissions in sandboxed environments. All scenarios are offline.

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
