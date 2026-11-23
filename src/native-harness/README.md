# Native harness

One agent entity, with a stable identity, talking on many channels. Consumers
configure its instructions, tools and policy. This directory lives inside acp-client but
is intended to become a separate package: it must not import acp-client modules.

## Current state

The harness runs one agent session with a shared timeline and concurrent
channels. Each channel runs one turn at a time. Use memory for a temporary
session or SQLite for durable receipt, restart recovery, and session files.
The public client supports stdio and in-process transports. Development chat
uses HTTP over a Unix socket and has a separate inspector.

The current harness supports channel and session controls, managed
configuration, tool policies and approvals, and streamed model calls with
recorded attempts and usage. Models can use OpenRouter or an offline script.
The [detailed architecture](.res/architecture/README.md) explains how these
parts fit together. The [work index](.res/docs/WORK.md) tracks remaining v1
work. Experiments live in [.res/sandbox/](.res/sandbox/).

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

Each plain `bun run start` creates a new durable session under
`~/.harness/sessions/<session-id>/session.sqlite`. Startup prints its ID and
database path. To reopen it, use the ID or the path. Use `--create` when you want
to choose the ID or file for a new session.

```sh
bun run start --session <session-id>       # reopen a saved session
bun run start --session project-a --create  # create with a chosen ID
bun run start --db ./dev.sqlite --create   # first run: the file must not exist
bun run start --db ./dev.sqlite            # later runs: the file must exist
bun run start --db ./dev.sqlite --resume   # also resume a suspended session
bun run status                             # lifecycle, active turns, pending input
bun run suspend                            # pause cleanly; waits for running tools
bun run resume                             # continue a suspended session
```

Opening a database restores its timeline. The development command starts
eligible work when the session is running and preserves a committed suspension.
Turns a previous process left unfinished are marked interrupted and are not
retried; input that was accepted but never taken runs. A suspended session
stays paused, and refuses new messages, until `bun run resume` or `--resume`.
Ctrl+C stops at once: running turns are recorded as interrupted, so run
`bun run suspend` first to pause without losing work in progress. `status`,
`suspend` and `resume` talk to the running agent over its Unix socket; they are
not available from the LAN chat. `--script <file>` replaces the provider with
a scripted model for offline runs without a key; the file is one script, or
`{ "channels": { "<id>": script }, "default": script }`.

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

The CLI recovers a stale Unix socket owned by the current user. If a server
is listening there, connect with `bun run chat` or use a different
`HARNESS_SOCKET`. Unavailable default browser ports fall back to available
ports. Explicit port settings are honored, and 0 requests an available port.
Use the URLs printed at startup. The
phone needs network access to that port. The inspector stays local-only on port
3000. Its Live Context tab shows a bounded preview across the session. Timeline
pages older events on request, and Channels shows recent captured requests
and can load recent durable model-call summaries. For an offline capture run,
use `HARNESS_CAPTURE_SCRIPT_REQUESTS=1 bun run start --script ./test-script.jsonl`.
New messages and notices have an 8 KiB UTF-8 text limit. Web chat currently shows future
replies, without replay or persistent browser history. Browser connections do not
automatically reconnect after a network loss; press Connect again.

Open the printed URL for the read-only context inspector. It starts with
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
Snapshots remain unchanged as later turns run. Each channel also shows durable
model-call outcomes, attempts and provider-reported usage, including after reopen.

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
Ctrl+C in the agent terminal stops it. Reopen the session to continue its history. Ask for the current
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
`src/capabilities/tools/builtin/current-time.ts`. The startup command selects the
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

A model call has a 120-second deadline, including streaming and one eligible
retry; tool execution and approval waits have separate limits. A model or unexpected
execution failure ends that turn as failed; its channel accepts and runs new
work, as do other channels. Tool calls of a failed or interrupted turn that
have no recorded result are listed as uncertain, described to the model in later
context, and never executed again by the harness. Tool errors are returned to
the model. Disconnecting a client does not
cancel an accepted turn. New shared events are visible at the next ordinary
inference; ordinary shared events do not wake idle channels or extend a turn.
Explicit notices do. The development CLI saves the session across restarts.

## Development instructions and notices

Live development defaults to the general-purpose [agent instructions](src/capabilities/context/instructions/agent.md)
and offers `current_time` and `notify_channel`. The harness rules and scripted
agent demo each have their own Markdown file in the same directory. To
override the agent instructions with your own Markdown, run
`bun run start --instructions ./my-instructions.md`. For a saved session, add
`--db <path>`. The explicit file replaces the selected config's `system` text
for that open. SQLite saves the resolved text with the session, and a present
`config.json` still supplies the configuration on subsequent opens without the
flag. Restart the harness to load edits. A changed prompt or tool list can make
a suspended turn incompatible with the new configuration.

Scripted development uses the generic test-agent instructions. A fixture
defines the model responses for a particular check.

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

## Tool layout

- `tools/builtin/` contains standard tools for time and channel notices.
- `tools/debug/` contains the opt-in tools for interactive debugging.
- `tools/testing/` contains offline fixture tools such as echo, record and hold.
- `tools/runtime/` contains catalog validation and availability, execution of
  host callbacks, and invocation inspection. It also implements
  `read_tool_result` for paged reads of a host tool's stored result.

## Debug tools

Run `bun run start --debug` to use the bundled test-agent prompt and expose
three development tools. The prompt override applies only to the running
process. Use `--debug-tools` to keep your usual prompt with the same tools,
or `--debug --instructions <path>` to select custom instructions. Ask the
agent to call `test_echo` with short text, `test_wait` to hold a turn for up to
30 seconds, or `test_fail` to return a deliberate failure and observe how the
agent continues. Tool policies still apply. Pass the flag again when reopening
a session to enable the tools for that process.

In the inspector’s Channels tab, expand **Request evidence** to see included
timeline positions, trimmed candidates, offered tools and the model-call ID.
Use **Load recent model calls** to see that request’s outcome and attempts.

## Offline scripted model

Run the real in-memory store, context builder, scheduler and tool loop without a
model provider or API key:

```sh
bun run test:scenario test/fixtures/echo-scenario.jsonl "Echo hello"
```

The command prints the answer, committed entries and unused response count.
Set `HARNESS_CAPTURE_SCRIPT_REQUESTS=1` to include the full requests in this
command or the scripted development inspector.

Script files use JSONL. The first record names and versions the scenario.
Model records can specify a channel and one of a response, provider failure,
or cancellation wait. With no channel record, a channel uses its own
position in the default sequence.

```jsonl
{"type":"scenario","version":1,"name":"echo"}
{"type":"model","content":"I'll echo that.","calls":[{"id":"echo-1","name":"echo","arguments":{"text":"hello"}}]}
{"type":"model","content":"The tool returned hello."}
```

Records can include an initial delay, timed text chunks and synthetic usage.
A malformed line fails before execution with its line number. Each attempt
consumes one durable position, including retries and crash-abandoned attempts.
Reopen checks the model sequence digest before recovering the session.
Old scripted stores without a digest need a fresh test session. See
[the scenario contract](.res/decisions/0023-long-running-mock.md).

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
      model: { protocol: "scripted", script: "test/fixtures/echo-scenario.jsonl" },
      defaultPolicy: "default",
      policies: { default: { fallback: "allow", tools: {} } },
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
requests are `initialize`, `config/validate`, `session/create`, `session/open` (durable servers
only), `channel/observe`, `channel/reconcile`, `channel/messages`, `session/timeline`, `session/message/read`, `session/model-calls`, `session/status`, `session/suspend`,
`session/resume`, `session/stop`, `channel/push`, `channel/notify` and `session/idle`, plus
`channel/create`, `channel/edit`, `channel/suspend`, `channel/resume`,
`channel/delete`, `channel/withdraw`, `channel/interrupt` and
`approval/respond`, plus
`session/export`, `session/import` and `transfer/{open,write,read,close}` on
durable servers.
Initialize reports an experimental subset and whether this server's acceptance
is `memory` or `durable`. It supports `final` or `stream` text and
none/summary/full tool events;
the `callbacks` list must be empty. Full tool events retain JSON argument
and result strings; a completed tool event means execution returned, which can
include an actionable `{ ok: false }` result. Thrown execution errors emit failed.

Text defaults to `final`, which delivers one `message_completed` for each
committed response containing text. With `stream`, `text_delta` events carry a
stable `messageId`; completion uses the same ID. `text_incomplete` ends an
uncommitted draft, and `text_gap` signals dropped deltas when a consumer falls
behind. Drafts are not durable: after reconnect, reconcile the ID against
committed messages. Large completions carry `reference: true` instead of parts;
use `client.readMessage({ messageId, offset })` to read base64 UTF-8 byte pages
of up to 524288 bytes, concatenating bytes before decoding. `client.modelCalls()`
returns paged durable call summaries and per-attempt provider usage;
`aggregateUsage` sums reported fields without inventing missing counts.

A transient failure may retry the identical request once after one second,
within the original 120-second deadline. The first accepted nonempty text delta
closes retry in both subscription modes. Timeout or output limit fails the turn;
partial text is not added to the timeline and tools from an incomplete response
are not dispatched. Interrupt and stop fence late output; suspension lets the
current call and iteration finish within the same deadline. Both transports
bound live delivery; a fully blocked connection closes and stops the session,
while already committed records remain recoverable.

Configuration contains `version: 1`, `system`, `model`, `defaultPolicy` and a
`policies` map. A model is `{ protocol: "scripted", script }` or
`{ protocol: "openrouter", model, apiKeyEnv }`. The default OpenRouter model is
`deepseek/deepseek-v4.1-flash` and its default credential reference is
`OPENROUTER_API_KEY`. `apiKeyEnv` names a variable in the destination process;
its value is resolved on open and never saved. OpenRouter runs require that
variable; a custom name does not fall back to `OPENROUTER_API_KEY`. The
`OPENROUTER_MODEL` environment variable selects a development model only when
there is no saved model; it does not override saved configuration. Scripted
runs need no provider key. Ports and the socket remain
process settings. `client.validateConfig(config)` checks the structure without
opening a session or starting inference.

Each named policy has a `fallback` of `allow`, `ask` or `deny` and exact tool
name overrides in `tools`; the default must name a defined policy. A trusted
consumer can set a policy on a channel or a message. The message policy wins,
then the channel policy, then the default. The resolved name is saved at
acceptance, so a retry keeps it after a channel edit. Reusing an ID with a
different explicit policy fails with `item_conflict`. When a turn takes inputs,
their policies combine for each tool: deny wins over ask, which wins over allow.
Notices carry the source turn's restrictions, including inherited restrictions.
This governs tool execution, not access to shared history.

To handle `ask`, initialize with `approval: true`, listen for the always-on
`approval_requested` channel event, and pass its `requestId` to
`client.respondApproval(requestId, "allow_once" | "deny")` after the consumer
decides. A grant covers only that exact call. Without a declared consumer, or
after denial, timeout (ten minutes by default) or disconnect, the call is
skipped with a paired tool result. Suspension closes an undispatched request
with `approval_cancelled_by_suspension`; interrupt and stop use
`approval_cancelled_by_interrupt` and `approval_cancelled_by_stop`. A late or
duplicate answer fails `not_found`. A `tool_call` started event means dispatch
occurred; it is not emitted for a skipped call. An unanswered request or grant
cannot be reused after restart.

Participants support IDs and kinds, without labels. Initial `channels`
must be empty; channels are created on push. Push supports text-only user messages
with queue delivery and wake=true. Unsupported fields, configurations and methods
fail explicitly. The push response is sent after the item is committed to the
inbox and reports it as `received`; it never carries a reply. Storage
deduplicates item IDs, across restarts on a durable server: the same ID and
content returns the original item's current milestone and turn, and different
content fails with `item_conflict`. Unknown senders are recorded as IDs.

The owning host can submit `channel/notify` with a stable notice ID, text,
optional source label, and an explicit inherited policy-name array. New
notices require an existing open channel and a running session. An identical
retry returns the original receipt even during suspension or an incompatible
inspection open. Accepted notices appear in the timeline and enter the
receiving turn as attributed external input. Conversation pages count only
participant and assistant messages.

`session/open` opens an existing session and returns its lifecycle, revision,
and any startup channel-change results. Opening recovers unfinished turns
without replaying them. Pending input becomes eligible after the open response.

Use `channel/observe` for revisioned channel state, the session blocker, and
pending approvals visible to the approval consumer. Use `channel/reconcile`
for outcomes and committed reply identities tied to outstanding item or turn
IDs. `channel/messages` pages participant and assistant messages, and
`session/timeline` pages activity, including notices and tool results. Live
message IDs and channel positions match the paged records. A large assistant
message is returned by reference and can be read with `session/message/read`.
A large timeline record keeps its attribution and position.

`session/create` and `session/open` accept `channelChanges`
([decision 0020](.res/decisions/0020-startup-channel-changes.md)): the newest
name, policy, suspension, resume or deletion a host decided for each channel
while the harness was stopped. The batch is validated as a whole, applied
after recovery and before any pending or recovered work can run, and answered
with one `applied` or `blocked` result per entry. A deletion that finds pending
input or a checkpoint suspends that channel instead and reports `channel_busy`.
A repeated open on the same connection reports the recorded results without
applying anything; a new connection can resend the same desired state safely.
Servers advertise this as `capabilities.startupChannelChanges`.

`session/suspend` refuses new messages at once, lets each active turn finish
its current inference and the tools it requested, then completes turns that are
naturally finished and checkpoints the rest. It responds when the session is
`suspended`, which can take as long as a running tool. Notices from finishing
work are still accepted and wait. A suspended session, including one loaded in
a new process, runs nothing until `session/resume`; resumed turns take their
pending input and continue at the next inference without repeating recorded
tool calls. Resume fails with `incompatible`, changing nothing, if a checkpoint
was saved under incompatible execution settings or contributing policy rules.
An individually suspended channel is checked only when it is resumed.
`session/stop` is
immediate: it cancels inference and tools, reports active turns `interrupted`,
leaves pending input pending, and makes this process refuse further work with
`stopped`. Lifecycle changes arrive as `session/event` notifications
(`HarnessClient.onSessionEvent`).

`session/export` writes a binary `.harness` file: a versioned `HARNSESS`
header and CBOR payload containing the logical session (metadata, channels,
turns, timeline, pending input, deduplication records, checkpoints and ID
counters) and the exact active portable configuration. Its version is separate
from the SQLite schema. Old standalone JSON exports are not accepted. The
scripted model path is preserved as a reference; the destination must supply
the script at that path when opening the session. OpenRouter credentials must
likewise be supplied through the named destination environment variable. Import
stores the config with the snapshot; a managed session can reopen from that
saved config without an inline config or sidecar. It is allowed only when the
session is cleanly suspended, or running with no active or checkpointed turn,
no pending input, and no channel suspending; otherwise it fails `busy`. The
reported length and SHA-256 are those of the
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
`message_completed`, `turn_suspended`, `turn_resumed`, `channel_state`,
`item_withdrawn`, `approval_requested` and `turn_ended`. Channel controls are available as
`createChannel`, `editChannel`, `suspendChannel`, `resumeChannel`,
`deleteChannel`, `withdrawItem` and `interruptTurn` on `HarnessClient`. Channel
suspension closes admission and waits for the current iteration; resume preserves
its checkpoint. Interrupt targets a turn and does not wait for a tool. Withdrawal
is durable and reports the owning turn if the input was already taken. Deletion
requires no pending input or unfinished turn and permanently reserves the ID.
Status reports channel lifecycle, pending input and `waitingForResume` separately.
`turn_started` and `turn_took` list the
item IDs that turn took, which is how an accepted input is matched to its
outcome. `turn_ended` reports `completed`, `failed` or `interrupted`. Completed assistant text is published immediately after recording,
including text before tool calls, even if notices extend the turn. Each message
has an ID and is delivered once; clients no longer republish the final return.
Only turn lifecycle IDs are strings at the protocol boundary; the experimental
store still uses numeric turn IDs internally. Per-channel order is guaranteed,
not ordering across channels. Subscriptions deliver future events, without replay.

Client requests time out after 30 seconds by default (configurable in its
constructor); closing a client rejects pending requests, removes subscriptions,
and closes that consumer's outstanding approvals. Accepted input remains durable.
Model exhaustion produces a failed turn
event after acceptance, not a failed push. Idle includes pending and running work.

This is not full protocol v1 conformance: broader permission features and
progress heartbeats remain unimplemented. Protocol version 1
identifies these experimental message shapes, not a full compatibility claim.

## Stdio server and client transport

Start the protocol-only process with:

```sh
bun run serve --stdio
```

It waits for JSON-RPC requests, one UTF-8 JSON message per line. It starts no web
servers or REPL. Select the scripted model in `session/create`, exactly as in
the in-process example above, to run without a provider key; OpenRouter sessions
use the configured credential environment variable. Relative script
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
stderr diagnostics. The default managed home is `~/.harness`; `--home <directory>`
overrides it. Each session uses `<home>/<sessionId>/session.sqlite` and an
optional `config.json` beside it. At creation an inline config wins over the
sidecar. On open, a present sidecar wins over inline config; otherwise the
saved config is used when inline config is absent. File edits apply at the next
open, and an invalid file does not replace the saved config. The old flat
managed database layout is not migrated; the explicit development `--db` path
remains supported. Work the process did not finish is reported
as interrupted when the session is next loaded. Hosts retain a process termination deadline.

Run `bun test test/protocol.test.ts test/stdio.test.ts` for transport parity and
framing/process lifecycle checks. Child stdin in Bun uses IPC and may require
local IPC permissions in sandboxed environments. All scenarios are offline.

## Consumer tools and host callbacks

A host can register functions for the model to call
([decision 0021](.res/decisions/0021-tools-and-host-callbacks.md),
[spec](.res/docs/tools-and-callbacks/0001-DESIGN/SPEC.md)). A server that
supports this advertises `capabilities.functions`.

```ts
client.serveFunctions(
  async (call, signal) => ({ output: await lookup(call.arguments, signal) }),
  read => readStoredResult(read),               // only if handlers return references
);
await client.initialize({ protocolVersion: 1, host: { name: "app", version: "1" },
  callbacks: ["functions/call"], functions: ["lookup_handler"],
  approval: true, subscription: { text: "final", tools: "full" } });
await client.openSession({ sessionId, tools: { catalog: [
  { name: "lookup", description: "...", parameters: { type: "object" },
    handler: "lookup_handler", group: "fixed" } ] } });
```

- **Catalog.** `tools` goes on every `session/create` and `session/open`.
  Definitions are not stored. `group` is `fixed`, `revocable` (`tool/revoke`
  and `tool/restore`, stored with the session and its archives) or `runtime`
  (`tool/enable` and `tool/remove`, in memory, listed in `tools.enabled`).
  An invalid catalog, a duplicate name or a clash with a built-in rejects the
  open and opens nothing.
- **Availability.** `session/tools` lists each tool with `available` and a
  reason: `revoked`, `not_enabled` or `handler_missing` (the connection did not
  name its handler at `initialize`). Policy is reported separately.
- **What the model sees.** Each inference offers the built-ins, then fixed
  entries, then `read_tool_result`, then changeable entries, each group by
  name. Unavailable tools and tools the turn's policy denies are left out. A
  retry of the same model call offers the same list.
- **Dispatch.** The existing permission gate decides. A catalog call must have
  been offered by its request, be available, and have arguments that match its
  schema; otherwise it is skipped with a paired result (`tool_unavailable`,
  `invalid_arguments`). Availability is checked again after an approval, and
  revoking a tool closes its pending approval.
- **Callback.** After dispatch evidence commits, the harness sends
  `functions/call` with an invocation ID (`<turnId>:<toolCallId>`). The answer
  is `{ output }`, `{ preview, reference }` or an error with a code. Answers
  are matched by request ID, so concurrent callbacks cannot be mixed up.
  `functions/cancel` tells the host the harness stopped waiting.
- **Deadlines.** `deadlineMs` per tool, else `tools.defaultDeadlineMs`, else
  none. On expiry the turn continues with one paired `tool_timeout` result
  whose effect is unknown. A late answer is ignored.
- **Records.** `session/tool-invocation` and `session/tool-invocations` return
  calls with their state: `requested`, `waiting_for_approval`, `started`,
  `succeeded`, `failed`, `skipped`, `interrupted`. A dispatched call with no
  committed result is `interrupted` with `effect: "unknown"` and is never
  repeated. `tool_call` events carry `invocationId`.
- **Phase.** `session/status` reports `activeTurn.phase`: `model`, `approval`
  or `tool`, since when, and the model call, approval request or invocation ID.
- **Large results.** Above 16384 bytes the handler stores the result itself
  and returns a preview and a reference. The model reads parts with
  `read_tool_result`; the harness accepts only IDs recorded for the requesting
  channel and forwards the read to the host as `results/read`.

Adjustable defaults are in
[BUSINESS_RULES.md](.res/docs/BUSINESS_RULES.md). The work log is
[here](.res/docs/tools-and-callbacks/0001-DESIGN/LOG.md).

## acp-client integration

On the `acp-client-integration` review branch, acp-client hosts one harness
process per agent, with each native conversation as a channel of one durable
session. The host and its controller
live in acp-client's `src/native/` and use only `src/client.ts` (the typed
client and stdio transport) and the `serve --stdio` command; they import no
harness internals. The contract is the
[integration spec](.res/docs/acp-client-integration/0001-DESIGN/SPEC.md) and its
[protocol profile](.res/docs/acp-client-integration/0001-DESIGN/PROTOCOL.md);
the work and its test evidence are in the
[log](.res/docs/acp-client-integration/0001-DESIGN/11-20-LOG.md). The harness
side of that contract is the startup channel-change batch described above
(decision 0020). From the repository root, `bun test ./test/native` runs the
host, controller, conformance and real-stdio checkpoint tests offline.

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
