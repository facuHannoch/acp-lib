# Native harness v1

Status: agreed, not started. Written 2026-11-11. What the first version builds, in two parts (harness line in `../11-11-NOTE-overview.md`, Order of work).
The why is `11-11-SPEC-harness-design.md`; folders, rules and build order are `11-11-SPEC-harness-project.md`.

## Scope

In: the kernel and turn state machine; the contracts; JSON configuration and policies; configured tools and the MCP
client; the delegation and messaging tools; an OpenAI-compatible model client; the context pipeline with tool
placement and basic compaction; the timeline v1 (positions, digests from host summaries, shared state as a projection);
storage; managed member channels (identity delivered to conversations a host runs elsewhere, and their reports);
the public API; **server mode** (`harness serve --stdio`, the protocol and host callbacks) and the execution
port, because the harness must run isolated in the agent's environment from v1; the `harness` CLI.

Out (phase 2): long-term memory and consolidation; digests at several granularities; the MCP server that lets
members read and write the identity through tools, and unmanaged members; native subagents (not in the first or second pass); watches (`todos/11-11-TODO-watches.md`); reminders; skills; deferred tool loading; file and shell capabilities;
model profiles.

## Two parts

v1 is built in two parts, each a self-contained implementation run. Part 1 is what acp-client's integration stage 2a
needs; part 2 is the rest of v1 and unblocks stage 2b.

**Part 1: the core and a test mode.**

- All of `contracts/`, reviewed as a whole (part 2 implements against the same contracts).
- The kernel: sessions (entity, lock), channels (actor, inbox, reset, settings), the turn machine and runner, turn
  events with the items each turn took.
- A minimal context pipeline: the system prompt verbatim, history, inbox items rendered as tagged blocks, sender tags,
  cache order. No compaction yet (a call over the window fails with a typed error).
- Config: schema, loading and validation for the part-1 keys (model, system, policies with `permissions` only,
  `defaultPolicy`, limits).
- Policies, minimal: the three layers resolved per item and the one permission setting with its gate (`ask` raises
  `permission_requested` / `permission/request`). Capabilities (`memory`, `messaging`, `delegation`) come in part 2.
- The OpenAI-compatible model client, and the **test mode**: a scripted model selectable at launch
  (`"model": { "protocol": "scripted", "script": "<file>" }`, or `harness serve --model scripted:<file>`) that replays
  answers, tool calls included, and records the requests it received; plus one built-in test tool (`echo`) available
  only in test mode, so permission and tool paths can be exercised without real tools.
- Storage: the session's SQLite (session record, config, channel inboxes) and whole-session export and import.
- Usage events with their purpose (the ledger comes in part 2).
- Server mode: the protocol, `HarnessClient`, the stdio and in-process transports.
- CLI: `harness new`, `harness chat`, `harness serve`.

**Part 2: the actual harness.** Policy capabilities and most-restrictive resolution; configured tools (`http`,
`command`, `function` via callbacks), the MCP client, the harness's own tools (delegation over callbacks, messaging,
state, timeline); the timeline, positions, digests, shared state and managed member channels; compaction; history
sources; the usage ledger; the execution port; the rest of the CLI (`sessions`, `config`, `usage`).

## Sessions and channels

- **A session is one entity:** its config (system prompt, policies, tools, model), its timeline, shared state and
  memory, and its channels. Two sessions are two different agents. A harness home (`~/.harness/` by default) stores
  many sessions, as other harnesses store theirs; opening one wakes that entity.
- **A channel is one line into the entity,** like a phone number into one person: its own model context, the
  participants talking on it, and a position on the session's timeline. A host's conversations are channels of one
  session (acp-client: every native conversation of an `Agent` is a channel of that `Agent`'s session).
- **Channel ids are supplied by the host** (opaque strings; acp-client passes its `agc-…` conversation ids) and
  generated only when the host gives none (the CLI).
- **Participants** are who talks on a channel. Each message carries its sender and policy; who someone is to the
  agent is learned from the timeline, not from a registry. A group chat is one channel with several senders.
- **One session is open in one process at a time,** locked while open. Several hosts on one session may come later.

## The kernel

The kernel owns the session's channels and the turn loop. A channel's turn state and context live in its actor; the
session holds the shared parts (config, model client, tools, timeline).

- **One actor per channel:** a mailbox (the inbox) processed one item at a time; channels run in parallel. A
  sequential queue per channel, no framework.
- **An explicit turn state machine:** `idle → building → calling → running_tools → building → … → idle`, plus
  `interrupting`. A pure function `(state, event) → (state, actions)`; a separate runner executes the actions through
  the extension points.
- **Steering** is an item arriving while the channel isn't idle: it waits in the mailbox and is drained at the next
  `building`. It waits only for what is in flight: a streaming model call or a running tool (the item goes in right
  after its result).

```ts
async function runTurn(channel, trigger) {
  emit("turn.start", { channel, trigger });
  while (true) {
    if (channel.aborted) return end("interrupted");
    channel.append(await sources.drain(channel));             // inbox items: steering, wakes
    const request = await pipeline.build(channel);            // context pipeline, incl. compaction
    if (!guards.allowCall(channel)) return end("limit");
    const answer = await modelChain.call(request, channel.signal);
    channel.append(answer);
    if (answer.toolCalls.length === 0) return end(answer.stopReason);
    for (const call of answer.toolCalls) channel.append(await toolChain.run(call, channel));
    await store.save(channel);
  }
}
```

**The kernel does:** start and end turns; call each extension point in order; enforce that tool results pair with
their calls; save after each step; emit lifecycle events; honour abort signals; report outcomes (finished,
interrupted, limit, error). **It never contains:** prompt text or rendering, provider formats, compaction logic, any
specific tool, permission rules, retry logic, knowledge of policies, workers or the orchestrator.

## Public API

| Call | Meaning |
| --- | --- |
| `createSession({ home?, config })` / `loadSession({ home?, id })` | Create an entity with its config / wake an existing one; locks it |
| `session.channel(id, { policy?, label? })` | Open or resume a channel (created on first use); `channel.setPolicy(name)` changes it |
| `channel.push(item)` | Add an inbox item: starts a turn if idle, injected at the next call if busy |
| `channel.interrupt()` | Abort the running turn |
| `channel.reset()` / `channel.close()` | Start the channel on a fresh context (a cleared transcript, a handoff in) / close it; its timeline events stay |
| `channel.setSettings({ model?, reasoning?, temperature? })` | Per-channel overrides of the session's model settings |
| `channel.events` | `turn_started` (with the items the turn took), text deltas, tool calls, usage, model-call log, `turn_ended`; `message` for text placed on the channel outside a turn (`message_participant`); `permission_requested` |
| `channel.answerPermission(id, option)` | Answer an `ask` from the gate (in process; over the protocol it is the reply to `permission/request`) |
| `session.member(id, { policy, label })` / `prepare({ member, context })` / `delivered(receipt)` | Managed member channels: a conversation a host runs elsewhere; what it should be told since its position, and the receipt that moves the position |
| `session.prompt({ channel, from, policy?, content })` | Host shorthand: push a user message with sender and policy |
| `session.report({ channel, from, policy, kind, ... })` | A host reports a conversation it runs elsewhere: `message` or `summary` |
| `session.registerFunction(name, fn)` | Implement a config tool with `run.type: "function"` |
| `session.setDelegationBackend(backend)` / `addHistorySource(source)` | Host-provided contracts |
| `session.config.get()` / `update(patch)` | Read and change the session's config (versioned) |
| `session.usage()` | The session's own usage ledger |
| `session.export()` / `importSession(bundle)` | Move or back up the whole entity |
| `session.close()` | Finish running turns as interrupted, release the lock |

**The API is serializable.** Every call takes and returns JSON-shaped data (items, events, config, receipts), so the
same API is served over the protocol unchanged. The only things that can't cross a process boundary as values, a
host's function handlers, delegation backend and history sources, are host callbacks: in process they are
registered objects; over the protocol they are requests from the harness to the host (Running as a process).

## Core data model

```ts
type Entry =
  | { kind: "message"; role: "user" | "assistant"; parts: Part[]; sender?: SenderRef; policy?: string; at: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; callId: string; content: Part[]; isError?: boolean }
  | { kind: "reasoning"; provider: string; opaque: unknown }       // sent back unchanged, same provider only
  | { kind: "compaction"; summary: Part[]; replaces: [from: string, to: string] };

type Part = { type: "text"; text: string } | { type: "media"; ref: string; mime: string };
type SenderRef = { id: string; label?: string; kind?: "person" | "agent" | "worker" | "harness" | "host" };

interface InboxItem {
  kind: "user_message" | "worker_reply" | "permission_request" | "timeline_digest" | string;
  sender: SenderRef;
  content: Part[];
  policy?: string;              // asserted by the host; a turn takes the most restrictive
  delivery: "wake" | "quiet";
  data?: unknown;               // kind-specific facts for renderers
}

interface ModelRequest { system?: string; tools: ToolDefinition[]; entries: Entry[]; options: ModelOptions;
                         allowedTools?: string[] }
type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "reasoning"; opaque: unknown }
  | { type: "usage"; input: number; output: number; cachedInput?: number; cost?: number }
  | { type: "stop"; reason: "end" | "tool_calls" | "max_tokens" | "refusal" | "error" };
```

- Inbox item kinds are open; each needs a renderer, checked at registration.
- Senders are references; renderers resolve them, so names match what the host described.
- Compaction is an entry: the store keeps what was replaced.

## Configuration

Each session has one JSON config, given when the session is created and changed through the session's API or the
CLI. There is no config shared across sessions. Each prompt reads the current version (cached by version). Code adds
only what JSON can't hold: function handlers and backends.

- **Standalone,** the stored config (`<home>/sessions/<id>/config.json`) is the source of truth.
- **Hosted,** the host is: it creates the session with its config and saves changes made through the API.
- **Per-channel settings** (model, reasoning, temperature) override the session's model settings for one channel;
  they are the channel's, not config edits (`channel.setSettings`).

```json
{
  "version": 1,
  "model": { "protocol": "openai-compatible", "baseUrl": "https://openrouter.ai/api/v1",
             "apiKeyEnv": "OPENROUTER_API_KEY", "model": "...", "reasoning": "low" },
  "system": "You are ...",
  "tools": [
    { "name": "lookup_order", "description": "...", "input": { "type": "object" },
      "run": { "type": "http", "url": "https://api.example.com/orders", "method": "POST" } },
    { "name": "deploy", "description": "...", "run": { "type": "command", "argv": ["./deploy.sh"] } },
    { "name": "crm_search", "description": "...", "input": { "type": "object" }, "run": { "type": "function" } }
  ],
  "mcpServers": [ { "id": "gmail", "url": "...", "headers": {} } ],
  "policies": {
    "owner": {
      "memory":     { "read": "all", "write": true },
      "messaging":  { "send": ["*"], "trigger": ["*"] },
      "delegation": { "use": true, "scope": "all", "redirect": true },
      "permissions": { "default": "allow",
                       "rules": { "send_email": "ask", "mcp:gmail/*": "allow",
                                  "worker:bun test": "allow", "worker:*": "ask" } }
    },
    "guest": {
      "memory":     { "read": "none", "write": false },
      "messaging":  { "send": ["policy:owner"], "trigger": [] },
      "delegation": { "use": true, "scope": "none", "redirect": false, "maxOpen": 1 },
      "permissions": { "default": "deny", "rules": { "worker:*": "deny" } }
    }
  },
  "defaultPolicy": "guest",
  "toolPlacement": "superset-hint",
  "limits": { "callsPerTurn": 50, "unattendedTurns": 5 },
  "compaction": { "at": 0.8 }
}
```

- **The system prompt is the consumer's, verbatim.** The harness adds no layer to it; what it renders (sender tags,
  digests, the per-turn tool hint) goes into the conversation, not the system prompt.
- **Tools say how they run.** `http` and `command` work from the CLI with no code (`command` takes an argv, never a
  shell string). `function` tools need `registerFunction`; one declared but not registered is listed as unavailable,
  not a crash.
- **MCP servers** (stdio and HTTP, through the official SDK) are listed at startup; their tools are namespaced
  `mcp:<server>/<tool>` and may change at runtime (the provider emits a change event).
- **Validation:** unknown keys and unknown policy names are errors with a path; a config that fails validation is
  not applied.

## Policies

- **Capabilities** have fixed names: `memory` (`read`: none, own, all; `write`), `messaging` (`send`, `trigger`:
  target patterns), `delegation` (`use`; `scope`: none or all, the workers it sees; `redirect`: may redirect work given from
  another conversation, stop and drop; optional `maxOpen`), later `files`, `shell`.
- **One permission setting** covers every call that may need approval: `permissions: { default, rules }`, rules by
  pattern over the harness's own tools (`web_search` later), tools declared in the config (`send_email`), MCP tools
  (`mcp:server/tool`) and requests from workers (`worker:<tool or command>`); levels deny, ask, ask the agent, allow.
  Ask the agent applies to `worker:` rules only (the agent can't approve its own calls). acp-client uses the same
  shape for its ACP conversations.
- **Messaging targets:** `*`, a channel id, or `policy:<name>` for channels whose policy is `<name>`.
- **Presets** ship as named examples: `readOnly`, `guest`, `trusted`, `owner`. With no policies configured a
  permissive single-user default applies; once policies exist, `defaultPolicy` is required.
- **Three layers, resolved per item:** the item's own policy (asserted by the host for that message; worker replies
  carry the policy of whoever gave the work), else the channel's policy, else the session's `defaultPolicy`. A turn
  triggered by several items takes the most restrictive, capability by capability.
- **The channel's policy** is set by the host when the channel is opened and can be changed (`channel.setPolicy`);
  the change is a timeline event.
- **The agent knows where it is:** each turn renders the channel's label and what its policy allows (with the tool
  hint), so the model can explain a refusal ("I can't do that in this conversation") instead of only hitting the
  gate.
- **Read-only** writes no memory and gets no tool that carries content into other conversations, or a guest's words
  reach the agent through the back door.
- **The policy engine is the permission gate.** It decides allow, deny or ask for every call under the turn's
  policy. Ask raises `permission_requested` on the channel (over the protocol, a `permission/request` to the host) and
  waits for the answer with a timeout, then refuses. The `worker:` rules of the turn's policy travel with each
  delegation callback, so the host applies them to that worker's requests; at ask the agent, the request comes back as
  an inbox item and the agent answers with a tool.

## Tools

- **Registry and providers.** Providers list definitions for a channel under the turn's policy and execute calls:
  `configured/` (http, command, function), `mcp/`, and the harness's own (`delegate`, `check`, `list`, `stop`,
  `message_participant`, `trigger_response`, `state_read`, `state_write`, `timeline_since`, `timeline_search`).
- **The tool chain** wraps every execution: schema validation (errors go back as tool results so the model fixes the
  call), the permission gate, timeout, result truncation, usage.
- **Descriptions are the main lever on behaviour.** Boundaries as capability ("you can't read files yourself; a
  delegated agent can"); errors that say how to fix the call ("`to` must be an id returned by `delegate`; open ones:
  w1, w2").
- **Delegation tools** call the delegation backend; with none registered they are absent. There is no built-in
  backend in v1 (native subagents are not in the first or second pass), so a standalone session has no delegation
  tools. Each call carries the channel, the sender and the turn's policy (its `delegation` part and its `worker:`
  permission rules). Workers belong to the entity, not to a channel, so the tools see every worker the turn's policy
  allows:
  - `delegate(text, about?, to?)`: no `to` opens a worker; with `to` sends to it. `about` is a short description the
    agent writes ("debugging the 403 on /path"), kept for `check`, `list` and the busy answer.
  - Sending to a worker busy with work given from another conversation returns `busy` with that work's `about`,
    conversation, sender and elapsed time, and sends nothing. The agent may tell its user ("I'm in the middle of what
    you asked in our other chat…") or call again with `redirect: true`, which the policy gates.
  - `check(to)`, `list()`, `stop(to)`. The rules live in the backend (the library's orchestrator,
    `../library/11-11-SPEC-orchestrator.md`); the tools only describe and call.
- **Messaging tools** (names provisional): `message_participant(to[], text)` puts the agent's text in each target
  channel with no model call there (reported to the host as a message on that channel, outside any turn);
  `trigger_response(to[], text)` pushes a wake item into each, and that channel takes its own turn. Both record a
  "told" event.
  - **Targets** in v1 are channels of the same session. The agent tells channels apart by their labels (the host's
    titles); how exactly it addresses them (labels, short handles, a listing tool) is left to be settled after real
    use.
  - **Code checks who may message whom** (`messaging.send`, `messaging.trigger` of the sending turn's policy). It
    does not check what the text says: confidentiality of information is not guaranteed in v1
    (`todos/11-12-TODO-information-confidentiality.md`).

### Tool placement

Tool definitions sit at the start of the request, so changing them breaks the cache. A placement stage decides:

| Strategy | How | Cache |
| --- | --- | --- |
| `superset-hint` (default) | The union of the channel's tools; a per-turn note of what this sender may use, appended | Kept |
| `provider-subset` | Full list plus a per-call restriction where the client advertises it (OpenAI's allowed-tools option, to verify) | Kept |
| `deferred` | Names or a search tool; full definitions fetched on demand (phase 2) | Kept |
| `rebuild` | Exactly this turn's tools; for single-policy channels | Breaks on change |

The gate enforces the turn's policy at call time in every strategy: placement guides the model and keeps costs down;
the gate guarantees.

## Model client

- **`ModelClient`:** neutral request in, stream of neutral events out, abortable. Provider translation is two pure
  functions (render, parse), golden-testable without a network.
- **v1: OpenAI-compatible** with a configurable base URL: OpenRouter from day one, plus direct compatible endpoints
  (OpenCode Zen and Go, DeepSeek, xAI, Gemini's compatibility endpoint, Ollama, vLLM). A native Anthropic client only
  if explicit cache marks or thinking blocks require it. A provider library (the Vercel AI SDK) may implement the
  contract if it keeps the features we need; confirm caching, reasoning passback and usage fields first.
- **The model chain:** retries with backoff on rate limits and outages, a call log event per call (model, request id,
  usage, cached tokens, latency, stop reason).
- **Reasoning** is kept opaque and sent back unchanged only to the same provider.
- **Usage** normalized: `prompt_tokens_details.cached_tokens` (OpenAI format), `cache_read_input_tokens` /
  `cache_creation_input_tokens` (Anthropic); cost where the provider reports it.
- **Exported** as `./openai-compatible` so the library's `http` internal-inference runtime can import it.

## Context pipeline

Ordered pure stages from the channel view to the neutral request:

1. **Layers:** the system prompt verbatim; tool definitions by the placement strategy.
2. **History:** entries since the last compaction marker.
3. **Inbox rendering:** each drained item through its renderer as tagged blocks
   (`<message from="Bob" policy="trusted">…</message>`, `<worker_reply from="w1">…</worker_reply>`,
   `<since_last_turn>` digests).
4. **Sender tags** on user messages; the per-turn tool hint last.
5. **Cache order:** nothing before the end changes between calls; deltas are appended once and become prefix.

**Compaction** at `compaction.at` of the window: first clear old tool results, then summarize old turns into a
`compaction` entry; the channel's timeline position is rebased (current state plus a digest). Rare and good: it loses
detail and breaks the cache.

## Timeline v1

```
timeline      append-only events: { seq, at, kind, channel, from, scope, content }
positions     per channel: the seq its context has been brought up to
projections   shared state (facts, commitments) · "told" events
delivery      digest(position..now, the turn's policy) → appended to the channel → position advances
```

- **What appends:** native channels automatically (each user message, assistant answer, delegation fact, messaging
  call); hosts through `report` (messages; summaries when they checkpoint).
- **Scope** on every event, from the policy it was written under; slices are filtered by the receiving turn's policy.
  A guest's words carry guest scope and never become owner facts.
- **Digests in v1** are stitched: host summaries for spans they cover, raw events (truncated) for the rest, newest
  last, under a size budget. Several granularities are phase 2.
- **Delivery to native channels:** on each turn the pipeline takes the slice since the channel's position, leaves out
  the channel's own events, filters it by the turn's policy, digests it and appends it as a `<since_last_turn>` block;
  the position moves to now when the block is appended (it is part of the context from then on).
- **Shared state** is a projection: `state_write` appends a fact or commitment event with provenance;
  `state_read` returns current facts the policy can see.
- **Managed member channels:** a host registers a conversation it runs elsewhere (`session.member`), reports its
  messages and summaries (`report`), and before each of its prompts asks what to deliver (`prepare`: the digest since
  the member's position for that provider context, filtered by the member's policy, plus a receipt); `delivered(receipt)`
  moves the position (never back; at least once).

## Storage

| Data | v1 |
| --- | --- |
| Identity core: config, timeline, positions, shared-state projection, usage ledger, channel inboxes (items not yet taken) | Required. SQLite through `bun:sqlite` |
| Channel contexts | In memory; optional JSONL snapshots |
| Transcripts | Not kept; hosts supply them as history sources |

```
<home>/                       ~/.harness/ by default; HARNESS_HOME or --home overrides; a host may choose
  sessions/<session-id>/
    config.json
    session.sqlite            timeline, positions, shared state, usage ledger, channel inboxes
    channels/<channel-id>.jsonl   optional context snapshots
    lock
```

The store is event-sourced: a channel's context is an append-only log with the context as a projection; compaction
is an event.

## Usage

Every model call the harness makes reports usage with a **purpose** (`turn`, `compaction`, later `digest` and
others), the channel it served if any, and the turn that was running if any. The session keeps its own ledger (counts
per purpose, model and day; `session.usage()`, `harness usage`), so it works standalone. A host files each call by
where it happened, not by its purpose: inside a turn it is part of that turn; with no turn running it is entity-level
usage. A new kind of call needs only a new purpose name.

## Guards

Calls per turn (`limits.callsPerTurn`); the unattended-turn budget (`limits.unattendedTurns`: turns with no human
input, which stops agent–worker and agent–agent ping-pong); a usage budget (`limits.budget`, set by the host), which
refuses model calls over the limit, in turns and outside them (the host can't refuse a turn before it starts; overview,
decision 41).

**Holds.** A host can hold a channel (`channel/hold`) before an operation that needs it to itself: the harness
starts no turn on it until `channel/release`; a running turn is waited for, or interrupted when the hold asks for it.
Items keep arriving in the inbox meanwhile.

## Running as a process

The harness must run isolated in the agent's environment, as external harnesses do today: its loop, credentials,
tools, MCP servers and storage live there, while the host (acp-client) may run elsewhere.

- **`harness serve --stdio`** serves the public API as JSON-RPC 2.0 over stdio, one process per session (entity), all
  its channels multiplexed. The protocol is the harness's, versioned (`protocol.version` in an `initialize` exchange).
- **Host → harness:** `initialize`, `session/create`, `session/load`, `session/export`, `session/import`,
  `channel/open` (with policy and label), `channel/push`, `channel/interrupt`, `channel/reset`, `channel/close`,
  `channel/setPolicy`, `channel/setSettings`, `channel/hold`, `channel/release`, `prompt`, `report`, `member/register`, `member/prepare`,
  `member/delivered`, `config/get`, `config/update`, `usage/get`.
- **Harness → host notifications:** `channel/event`: `turn_started` (turn id and the items it took), text deltas,
  tool calls, usage, model-call log, `turn_ended`, and `message` (text placed on a channel outside a turn).
- **Harness → host requests (callbacks):** `functions/call`; `delegation/open|send|check|stop|list` (each with the
  channel, the sender and the turn's delegation policy and `worker:` rules); `permission/request` (an `ask` from the
  gate; the host's reply is the answer); `history/search|read`. Declared by the host in `initialize`; a callback the host didn't declare makes the matching
  tools unavailable, not broken.
- **The client** (`HarnessClient`) is exported by the package (`./client`) with two transports: process (spawn a
  prepared command, stdio) and in-process (direct calls, for tests and the CLI). Hosts never write protocol code.
- **Lifecycle:** the host starts the process (through its own launcher), the harness opens its root and answers
  `initialize`; on stdin close it finishes running turns as interrupted and exits. A crash is the host's to restart.
- **Contract tests** run the same scenarios through both transports.

### Where the session is written

The harness writes its session to its home (`--home`, `HARNESS_HOME`, or what the host passes), a path in its own
environment. v1 keeps no copy elsewhere: a home the harness can't reach fails, and an ephemeral home loses the entity
with its environment. `session/export` returns the whole entity as a bundle and `session/import` creates a session from
one, so hosts and users can back up by hand. Continuous copies and delegated writing are in
`todos/11-12-TODO-session-sync-and-backup.md`.

## Execution port

Every process the harness starts (`command` tools, stdio MCP servers) goes through one port:

```ts
interface ExecutionPort {
  prepare(request: { purpose: "command_tool" | "mcp_server"; command: string[]; cwd?: string; env?: Record<string, string> }):
    Promise<{ command: string[]; cwd?: string; env: Record<string, string>; dispose?(): Promise<void> }>;
}
```

The default spawns locally, in the harness's own environment (which, when a host launched it in a container, is the
container). A config entry (`execution.prefix`) covers simple cases standalone. Same shape as acp-client's launcher.

## CLI

`harness new [--config FILE]` creates a session; `harness sessions` lists them; `harness chat --session S [--channel C]
[--as ID] [--policy NAME]` talks on a channel and prints text, tool calls and wakes, with `--log` for the model-call
log; `harness config get|set|validate --session S`; `harness usage --session S`; `harness serve --stdio --session S`
for hosts. `--home` everywhere. It drives the public API only.

## v1 code plan

How v1 fills the layout of `11-11-SPEC-harness-project.md`. Folders not listed are empty in v1.

| v1 part | Folders and files | v1 contents | Left for later |
| --- | --- | --- | --- |
| Contracts | `contracts/` all files | every type and interface, doc-commented | `memory`, member types beyond the receipt |
| Kernel | `kernel/session.ts` (entity, lock), `channel.ts` (actor, settings, reset), `turn-machine.ts`, `turn-runner.ts`, `lifecycle.ts` | full | — |
| Config | `config/schema.ts`, `load.ts`, `versions.ts` | schema, validation with paths, versions | migrations between versions |
| Policy | `policy/engine.ts`, `resolve.ts`, `permissions.ts`, `presets.ts` | capabilities, the permission setting and its patterns, three-layer and most-restrictive resolution, presets | `files`, `shell` |
| Model | `model/clients/openai-compatible/{render,parse,client}.ts`, `model/chain/{retry,call-log}.ts` | one client, retries, call log | profiles, native Anthropic client |
| Context | `context/pipeline/{layers,history,inbox,senders,placement,cache-order}.ts`, `context/renderers/*` | the five stages; renderers for user messages, worker replies, failures, redirects, permission requests, digests | deferred tool loading |
| Compaction | `context/compactors/{clear-tool-results,summarize}.ts` | both | smarter summaries |
| Store | `context/store/{log,memory,file}.ts` | event-sourced log, in-memory, JSONL snapshots | — |
| Tools | `tools/registry.ts`, `tools/chain/*`, `tools/providers/configured/{http,command,function}.ts`, `tools/providers/mcp/` | all | MCP resources and prompts |
| Own tools | `tools/providers/own/{delegation,messaging,state,timeline}.ts` | delegate, check, list, stop; message_participant, trigger_response; state_read, state_write; timeline_since, timeline_search | memory tools |
| Safety | `permissions/allow-all.ts`, `guards/{call-limit,unattended-turns}.ts` | gate via the policy engine; two guards | cost budget |
| Identity | `identity/{timeline,positions,digest,shared-state,delivery,members}.ts` | append, positions, stitched digests, projection, native delivery, managed members | digests at several granularities; the members' MCP server |
| Storage | `storage/sqlite.ts`, `storage/schema.ts`, `storage/bundle.ts` | identity core in `bun:sqlite`; whole-session export and import | — |
| Delegation | `delegation/remote.ts` | the backend that forwards to host callbacks | native subagents |
| History | `history/own-channels.ts`, `history/remote.ts` | own channels; host callback source | — |
| Usage | `usage/ledger.ts` | purposes, ledger, `usage()` | — |
| Execution | `execution/local.ts`, `execution/prefix.ts` | local spawn, prefix | — |
| Protocol | `protocol/{messages,server,client,transport-stdio,transport-inproc}.ts` | server mode, client, both transports | — |
| CLI | `cli/{new,sessions,chat,config,usage,serve}.ts` | the commands above | TUI |
| Testing | `testing/{scripted-client,golden}.ts`, `testing/conformance/*` | per contract | — |

**Build order for v1,** each step with its check. Steps 1–3, 5 and the part-1 subset of 4 and 6 are part 1; the rest
is part 2:

1. `contracts/` reviewed as a whole. Check: types compile; no imports.
2. Conformance skeletons, scripted client, golden harness. Check: suites run (empty implementations fail as expected).
3. Kernel with in-memory store and empty pipeline. Check: a scripted tool loop, steering mid-turn, interrupt, limit.
4. In parallel: model client (conformance + golden provider JSON); context pipeline and renderers (golden requests);
   compaction (scenario over budget); tools and MCP (validation errors fed back; an MCP stdio server in a test);
   config and policy (policy tests without a model); identity and storage (two channels share a fact; a guest slice
   excludes owner events); delegation (a round trip through a fake host backend); execution (a `command` tool through a prefix).
5. Protocol: server and client, both transports. Check: the kernel scenarios pass through the process transport.
6. CLI. Check: `harness chat` against a real endpoint when a key exists; `harness serve` driven by the client in a
   test.

## Steps

The build order for v1 is in the v1 code plan above (the general one is in the project spec). Acceptance per step is
its check; v1 as a whole:

- A whole conversation runs offline on the scripted client with golden requests: tool loop, steering, interrupt,
  compaction, limits.
- Policy tests (no model): the gate refuses by capability and tool pattern; the most restrictive policy wins on
  combined turns; a guest slice never contains owner-scoped events.
- Two channels of one session: a fact told in one is delivered to the other; `message_participant` and
  `trigger_response` reach the other channel.
- Two sessions are two entities: nothing told in one reaches the other.
- A member channel's position moves only on `delivered`, and its prepared digest respects its policy.
- An exported session imported into a fresh home is the same entity.
- The same scenarios pass in process and through `harness serve --stdio`.
- `harness chat` works against a real OpenAI-compatible endpoint (when a key exists).

## Open

- [ ] Does steering abort an in-flight model call and resend, or always wait for it to finish?
- [ ] Digests: granularities, how and when produced (memory findings).
- [ ] Config versioning and the shape of validation errors.
- [ ] Whether the Vercel AI SDK keeps caching, reasoning passback and usage well enough to implement `ModelClient`.
