# Native harness in acp-client

Status: agreed, not started; reviews 1–2 done 2026-11-12 (against the controller-interface spec, reviews 1–7, and the
code on `beta`). No implementation plan or briefs yet. Implemented in two stages (2a, 2b) alongside the two parts of
harness v1; see Stages and the overview. The harness seen from the library: what acp-client needs from it
and what changes in acp-client. How the harness works inside is `../harness/11-11-SPEC-harness-design.md` and
`../harness/11-11-SPEC-harness-v1.md`.

## Why the library needs a harness of its own

The 10-17 note (`../../9-22+/10-17-NOTE-model-call-controller.md`) proposed a controller that calls a model API with
no harness. It grew into a harness of our own, for reasons that show from acp-client's side:

- **Resources.** Every conversation owns a harness process (hundreds of MB). Many conversations, few processes is the
  pool (`11-11-SPEC-orchestrator.md`); the many conversations need a backend that isn't a process each.
- **One agent across conversations.** The checkpoint-backed identity (`src/identity/checkpoint-backed.ts`) copied raw
  messages from other conversations into a preamble (`maxContextChars` 32,000, `maxSourceChars` 8,000) and proved
  unreliable.
- **Control.** Through ACP the system prompt goes in as a first prompt, some models refuse it, and the harness's own
  prompt can override ours; context, compaction and tool descriptions aren't ours. With our own loop they are; the
  tuning harness prompts gave for free is ours to write.
- **Talking to work needs tools,** and a model calling tools in a loop is a harness. Building inside an existing
  harness is impossible (no API inside their loop).

Rejected: a plain HTTP controller with the model client as a library layer; the harness in acp-client's process (it
breaks isolation, below); speaking ACP (it has no agent-started turns, no injection into a running turn, no policy per
prompt, no non-prompt items, no member identity calls; the core of the design would live in extensions); one harness
per conversation.

## Isolation: the harness runs as its own process

Today an ACP conversation's whole harness runs as its own process started through the launcher (`src/launcher.ts`,
`AcpLauncher.prepare` → command, cwd, complete env): its loop, credentials, session files and every operation it
performs live in the agent's environment (a container, say), while acp-client may run elsewhere. The native harness
gives the same guarantee, from v1:

- **One `Agent` is one harness session** (one entity), served by one process: every native conversation of the
  `Agent` is a channel of that session, multiplexed over one connection (Sessions and channels, below).
- **Started through the launcher,** generalized from `AcpLauncher` to a `ProcessLauncher` (same `prepare` shape; the
  `kind` gains `"native-harness"`), so `docker exec`, cwd and env work unchanged; the default is the one conversations
  already use (`conversationDefaults.launcher`, `src/agent.ts:229`). `AcpLauncher` stays as an alias.
- **`harness serve --stdio`:** the harness's server mode. Its protocol is the harness's public API made
  serializable: JSON-RPC over stdio, defined and versioned by the harness, with the client exported by the harness
  package (`./client`). acp-client doesn't write protocol code; it launches the process and uses the client.
- **Everything the agent does runs there:** model calls (API keys in that environment), `http` and `command` tools,
  MCP servers, the session's files.
- **Callbacks from the harness to the host,** like ACP's fs and terminal requests to the client: function tools, the
  delegation backend (the orchestrator stays in acp-client), history sources, and permission requests. Identity for
  ACP conversations goes the other way: acp-client asks the harness (`member/prepare`, `member/delivered`).
- **In-process transport** exists too (same client interface), for tests and the standalone CLI; with acp-client the
  process is the default.
- **One process for many conversations** means a crash affects all of them: the host restarts the process
  (bounded retries; Process lifecycle, below), each native conversation's running turn ends with an error, and the
  orchestrator's restart rules apply to workers it was running. For the same reason, nothing a single conversation
  does stops the process: a conversation's `stop` and `forceStop` act on its channel only.

## What acp-client sees

```
AgentConversation ── AgentSession ── NativeController ── HarnessClient ══ stdio ══ harness serve
                                          │ translation only                   (agent's environment)
                                          └─ one NativeHarnessHost per Agent: launches, holds the client,
                                             serves callbacks (functions, delegation, history)
```

### Sessions and channels in acp-client

A harness session is the entity; a channel is one line into it (`../harness/11-11-SPEC-harness-v1.md`, Sessions and
channels). In acp-client:

| acp-client | Harness |
| --- | --- |
| an `Agent` with a native harness configured | one session, created on the harness's first start and loaded afterwards. Its id is the `Agent`'s own stable id (`agent_identity.agent_session_id`), so acp-client stores nothing to find it |
| a native `AgentConversation` (`agc-…`) | a channel of that session; the channel id is the conversation id, passed through. Channels always exist: there is no "open" step a conversation must take before the harness can use it |
| the conversation's provider-session row (`provider_sessions`) | `internal_session_id` = the harness session id = the `Agent`'s id, the same for every native conversation of the `Agent` (the index on it isn't unique); the channel id in the row's metadata |
| a cleared transcript or a handoff into native | a fresh context on the same channel (`channel.reset()`), the old row deactivated, a new one active |
| deleting the conversation | closing the channel; its timeline events stay (they are the entity's history) |
| participants (`ParticipantRef { id, kind, name }`, shared by all of an `Agent`'s conversations) | senders: `id` → sender id, `name` → label, `kind` → person, agent or other; the same id in two conversations is the same person |
| the conversation's `policy` (stored, current value only) | the channel's policy |
| the conversation's `title` (set at creation; `conversation.setTitle()` added) | the channel's label, shown to the agent |
| model settings changed on the conversation (`setConfig`: model, reasoning, temperature) | the channel's settings (`channel.setSettings`), overriding the session's for that channel only |
| an ACP conversation, when a harness is configured | a managed member channel (`member/register`): its messages and summaries are reported, and it receives what the harness prepares |

**One session id, many conversations.** Like one phone number with many extensions: the session id says which agent,
the channel id says which line. Code that assumes one conversation per `internal_session_id` must not run for native
conversations or must look up by session id and channel id together: adoption and transcript import, provider-session
delete, `listSessions` (all absent for native, by capability), and per-session metering queries
(`metering_records_internal_session_idx`), which for native aggregate the whole entity.

**Where the session lives:**

- **In the harness home,** which the consumer can set (`harness.home`); by default a home inside acp-client's own
  data location (`<persistence root>/harness/`). The harness's own default, standalone, is `~/.harness/`. The path is
  passed to `harness serve`, so it is a path in the harness's environment.
- **No sync in v1.** acp-client can't tell whether the harness runs isolated (the launcher is opaque), so it keeps no
  copy. A path the harness can't reach fails; an isolated harness on an ephemeral home loses the entity when its
  environment goes away unless the consumer mounts a durable volume. Both are the consumer's to manage.
- **Manual export and import:** `agent.harness.export()` returns the whole session as a bundle (`session/export`;
  it starts the process if needed). `agent.harness.import(bundle)` restores a session into a home that doesn't have
  it yet, renamed to the `Agent`'s id; importing where the session already exists fails, so a live entity is never
  overwritten by accident. Restoring after a lost container (a fresh volume) works naturally; replacing an existing
  entity means deleting it first, explicitly. A consumer may export on close.
- Continuous copies, delegated writing and periodic export are in `../harness/todos/11-12-TODO-session-sync-and-backup.md`.
- **The config** belongs to the session, and acp-client holds it while hosting (Configuration known before start,
  below): the `Agent` config's `harness.config` is the starting point, changes made through the API are stored by
  acp-client as overrides on top of it, and the result is sent each time the harness starts. Edits made with the
  standalone `harness config` command are overwritten the next time acp-client starts that session.
- **The session is locked** while acp-client has it open; another host (the standalone CLI) can't open it meanwhile.
  A lock left by a crashed process is reclaimed by the harness (the lock records the process id); acp-client only
  reports "locked by another host".

### Sender and policy

Three layers, first match wins: the message, the channel, the session.

```ts
const conv = await agent.conversations.create({ adapterId: "main", policy: "owner", title: "Owner, private chat" });
await conv.prompt({ text: "hi", participantId: "bob", policy: "trusted" }); // this message only
await conv.setPolicy("guest");                                               // the channel from now on
```

- **Message:** an optional `policy` on `prompt`, for that message only.
- **Channel:** the conversation's `policy`, set at creation (else seeded from the native adapter's `defaultPolicy`)
  and changed with `setPolicy`. Stored in a `policy` column on `conversations`, current value only (no history), so
  the consumer sets it once and acp-client can send it to the harness even if the harness isn't running when it is
  set (Channel changes, below). A change applies from the next item; it is not an exclusive operation.
- **Session:** the harness config's `defaultPolicy`.
- **Only the consumer's code sets policies;** nothing reads them from message text. Names are checked when they are
  set, against the stored config through `describe` (below), so an unknown name fails at once, even before the
  harness runs; the harness checks again on use.
- **Recorded:** the user-message record notes the policy that applied (one metadata field), so "why did the agent
  refuse that?" has an answer. Nothing else is versioned.
- **Senders** are participants as they exist today (`resolveParticipant`, `src/agent/persisted-lifecycle.ts:387`),
  passed through unchanged; `user:default` passes as a sender with no name. No notes and no per-participant policy
  for now; if testing shows the agent needs more about people, participants are where it goes.
- **ACP conversations** get a `policy` too: the scope their messages carry when reported to the timeline, and what
  identity they receive as member channels.

### Adapters

`Adapter` stays what it is: the `HarnessController`'s adapter, an external harness command
(`{ command, ptyCommand?, cancelGraceMs?, displayName? }`, `src/adapters.ts`; validated in
`src/agent-adapter-registry.ts`; exported and used by agents-core). The native adapter is a separate type:

```ts
interface NativeAdapter {
  kind: "native";            // a conversation on this adapter is a channel of the Agent's harness session
  defaultPolicy?: string;    // seeds a new channel's policy when the conversation sets none
  displayName?: string;
}
type AgentAdapter = Adapter | NativeAdapter;   // what Agent configs take

interface AgentHarnessConfig {                 // AgentConfig.harness: one per Agent, because one Agent is one entity
  config: string | NativeHarnessConfig;        // path or the JSON object; the base of the effective config, every start
  home?: string;                               // the harness home, a path in the harness's environment
  command?: string[];                          // how to start `harness serve --stdio`; defaults to the package bin
  launcher?: ProcessLauncher;                  // else conversationDefaults.launcher
  idleStopMs?: number;                         // stop the process after this long idle; off by default
}
```

The harness itself is configured on the `Agent`, not on the adapter: two native adapters with different harness
configs would be two entities in one `Agent`. Native adapters differ only in channel defaults.

`AgentConfig.adapters` takes `AgentAdapter`; the registry stores either and validates each with its own rules. A
conversation's controller is chosen by the adapter's type. Existing code passing `Adapter` keeps working unchanged.

### The `NativeController`

Implements the `ConversationController` interface (`11-11-SPEC-controller-interface.md`) over the harness client:

| Controller member | Native |
| --- | --- |
| `start` / `startFresh` | make sure the host's process is running (starting it lazily; Process lifecycle) / the same, then reset the channel to a fresh context. The channel's policy, label and settings are already in force (Channel changes, below). Result: `{ sessionId: <the Agent's id>, resumed: <the channel already had a context> }` |
| `send` | push each message as an item on the channel, with sender, policy and a delivery hint; resolves when the harness has accepted it, which ends the message's queue operation; promises no turn |
| `subscribeTurns` | the harness's `turn_started` (with the items it took) and `turn_took` (items folded into a turn already running); never an end of turn (the end is the prepared turn's `prompt()`) |
| `prepareTurn` | a prepared turn whose `prompt()` replays the turn's held output, usage and supervision signals, then streams the rest into the session's handlers and resolves at the harness's end of turn; ignores the content's input (the harness built the context) |
| `abandonTurn` | drops what is held for the turn; interrupts the channel's turn if it is still running |
| `cancel` | `channel/interrupt` for the channel's running turn |
| `forceStop` | interrupts the channel and gives up on its turn locally: open prepared turns reject. Never stops the shared process; only the host restarts it, on a crash or when it stops answering |
| `stop` | the conversation is done with its channel for now; the process keeps running for the others |
| `subscribeOutput` | supervision signals only, as for ACP (the stream goes to the turn's handlers) |
| `configOptions` / `setConfig` | model, reasoning, temperature as `ConfigOption`s, known before start from the stored config and `describe`; `setConfig` stores the channel's settings and sends them (Channel changes, below) |
| `subscribeUsageUpdate` | usage events, one per model call, with their purpose |
| `conversationCapabilities` | `nativeSteering: true`; `backend` filled from the config at once (the model's media; no load, fork or session listing); the optional methods (modes, bridge, reconnect, authenticate, `listSessions`, `prepareInternalPrompt`) are absent |

- **The internal event model stays.** Messages, tool calls, usage and permissions cover the native side; the record
  kind `protocol` is generic enough for model-call details.
- **Stale supervision fits unchanged,** per turn: each prepared turn carries its own output signals and cancel, so
  supervising a held turn never sees or cancels the next one (`supervisedPrompt`, `src/agent-session.ts:4037`;
  controller-interface spec).
- **Native conversations are `Agent`-only** (no detached `AgentSession`, no `SessionManager`).
- **Breaking change in stage 2a:** the public `capabilities` getter (the raw ACP shape) becomes `Capabilities | null`,
  `null` for native conversations; consumers read `conversationCapabilities` for both.

### Process lifecycle

The process is what costs (and, isolated, a container per agent); channels are cheap and always exist.

- **Started lazily, on activity:** when a native conversation first needs the harness (a message, an item pushed by
  the orchestrator or the consumer, an operation that needs the harness such as export), like an ACP provider is
  started on first use today. Starting happens inside that operation (the conversation is busy meanwhile, as when an
  ACP provider connects); start progress behaves as for ACP. `agent.harness.start()` starts it ahead of time for
  consumers who want to.
- **Started once:** several conversations, the orchestrator or the consumer may need the process at the same moment;
  the host starts it once and the others wait for that start.
- **`isBusy` and the queue are unchanged.** A native conversation is busy exactly while acp-client runs an operation
  for it, as with ACP: a turn being run and recorded (the first one also starts the process), an exclusive operation.
  A turn the harness starts on its own makes it busy while that turn runs, which is real activity. Nothing else (a
  stored setting, a report, the process running) makes a conversation busy, so idle eviction stays the consumer's
  concern, as today.
- **Optionally stopped when idle:** `harness.idleStopMs` (off by default). Idle means both sides agree: acp-client
  has no turn running or held, no pending permission request and no channel held, and the harness, asked before the
  stop (`session/idle`), has no turn running and nothing in its inboxes. The next activity starts it again (started
  once, as above, also when it races the stop). The harness home must be durable for this (no sync in v1; the
  consumer mounts it).
- **Stopped with the `Agent`.** Not when its last native conversation closes.
- **Restarts on a crash:** bounded (3 within 60 s, with a pause between); running turns end with an error. When the
  retries run out the host is failed: native conversations' operations fail with `HarnessUnavailableError` until
  `agent.harness.restart()`.
- **Turns for conversations not loaded:** when the harness reports a turn on a channel whose conversation acp-client
  hasn't loaded in this process, acp-client loads it from persistence and records the turn there.
- **No background work in v1:** a stopped harness never needs to wake itself. Waking it, and a harness that starts
  cheaply and loads lazily, are in `../harness/todos/11-12-TODO-background-work-and-lazy-harness.md`.

### Configuration known before start

With ACP, models and commands exist only inside the running harness, so a consumer must start it to learn them and
handle "initialized or not". With native the config is ours, so acp-client knows it without starting anything, and a
native conversation always looks ready.

- **acp-client stores the config:** the `Agent` config's `harness.config` is the starting point; changes through
  `agent.harness.updateConfig(patch)` are stored as overrides on top of it (`agent.harness.resetConfig()` drops them);
  `agent.harness.config()` reads the effective config. The effective config is sent each time the harness starts, and
  an update while it runs is also sent at once (`config/update`). Your code's config stays the base: a later change
  to it applies, under the stored overrides.
- **Channel settings** set through `setConfig` (model, reasoning, temperature) are stored per conversation and sent
  when the channel is next used.
- **Models and reasoning options** come from the config, which lists the allowed models with what each supports
  (`../harness/11-11-SPEC-harness-v1.md`, Configuration).
- **Commands, capabilities and validation** come from `describe(config) → { configOptions, commands, capabilities,
  errors }`, a pure function the harness package exports (`./client`). It runs in acp-client's process and launches
  nothing, so a bad config fails before any container starts.
- **The live description wins after start:** the protocol's version check at start catches a harness version that
  differs from the installed package; the running harness's own description then replaces the static one, and a
  change is emitted if they differ.
- **Cost:** the first message after a cold start waits for the process (and container) to start; consumers show
  progress through the start events.

### Channel changes

A channel's policy, label and settings, and its deletion, can change while the harness is stopped. They must be in
force before the harness runs any turn on that channel.

- **acp-client is the truth:** it stores each conversation's current policy, title and settings.
- **While the harness runs,** a change is sent at once (`channel/setPolicy`, `channel/setSettings`, the label,
  `channel/close` for a delete).
- **While it is stopped,** the conversation is marked as having pending changes (a `harness_pending` flag on the
  conversation). This is a queue of changes, coalesced: only the latest value of each field is sent, however many
  times it changed.
- **At start, the pending changes go inside the start call itself** (`session/load`, or `session/create` the first
  time): the harness applies them before it can start any turn, so no message or waiting item can run under an old
  policy. Flags are cleared once the harness confirms. Deleting a conversation while stopped closes its channel at
  that start, so a delete never starts a container on its own.

### agents-core

agents-core runs on `SessionManager` and `AgentSession` (the managed path), not `Agent`. Native conversations and the
orchestrator are `Agent`-only by design, so agents-core gets them only after it moves to `Agent`. Its pinned 0.10.2
is unaffected.

### Turns the harness starts

The harness decides when a native channel runs a turn: because of a message, a worker reply pushed by the
orchestrator, another channel (`trigger_response`), later its own background work. It reports each turn (`turn
started`, with the items it took, then the stream, then the end). The `NativeController` reports it as
`turn_started` with its cause (`11-11-SPEC-controller-interface.md`), and `AgentSession` runs it like any turn: it
records, meters and supervises it through `prepareTurn`, and emits it on the conversation's turn events. acp-client never schedules a native turn and the
harness never asks it for permission to run one (overview, decision 41). Exclusive operations on a native
conversation (a handoff out, a stop, a delete, a reset) first hold the channel (`channel/hold`, then `channel/release`); every
such operation must hold, and stage 2a tests each one. Budgets are the harness's guard.

- **A prompt's promise resolves with the turn that took its message.** The harness reports which items each turn took:
  at its start (`turn_started`), and as it folds more in (`turn_took`). A message folded into a running turn settles
  with that turn's result.
- **Steer or queue, through the existing system.** acp-client's queue and steering work as today. A steer message
  that arrives during a turn would normally make the steering controller cancel the turn and resend; for native the
  steering host pushes it to the harness instead (`delivery: "steer"`), which folds it into the running turn at its
  next model call. Queued (non-steer) messages wait in acp-client's queue as today and are pushed when the queue
  reaches them (`delivery: "queue"`), which starts a turn. Items other than messages get a default per kind, set in
  the harness. The consumer sees the same meaning as with ACP. Pushing queued messages to the harness earlier, so they
  are durable sooner, is an option for later.
- **Interrupt and the harness inbox.** What an interrupt does to items waiting in the channel's inbox is the
  harness's decision (harness v1); when it drops messages it reports them (`messages_dropped { ids }`), and acp-client
  settles their prompts with the cancelled result, as for ACP.
- **Withdraw** of a message the harness already accepted asks the harness to remove it from the inbox; it succeeds
  only if the harness confirms the message wasn't taken yet. Before the push is accepted, withdraw is local, as today.
- **Exclusive operations hold the channel first:** handing the conversation off out of native, stopping it, deleting
  it, and resetting it (a cleared transcript). Handoff out and reset wait for a running turn to end; stop and delete
  interrupt it. `setPolicy` and `setConfig` are not exclusive: they apply from the next item or model call.
- **Native admission** (what the session's pre-turn checks mean when the harness already started the turn; overview,
  decision 41; controller-interface spec, Appendix A):
  - a metering preflight that would reject a turn the harness started can't stop it: the turn is recorded and metered
    as executed, flagged `over_budget`, and the budget is enforced by the harness's guard;
  - a settings change applies from the next model call; it doesn't hold the channel;
  - while acp-client's persistence is unhealthy, it holds its native channels, and releases them when it recovers;
  - acknowledged turns (the harness waiting for acp-client to finish recording before the next turn) are not adopted
    in v1.
- **Usage and supervision signals of a held turn** are held with its output and filed when the session runs the turn,
  under that turn's metering.
- Turns the harness starts carry no prompt handler; permissions reach the user as events instead (Permissions,
  below).

### Permissions

Today a permission request is answered only through the callback of the prompt that started the turn
(`handlers.onPermissionRequest`, `src/agent-session.ts:3536`), else `defaultPermission` (which refuses by default);
the request and its answer are recorded (`permission` records, requested and resolved). A turn nobody prompted has no
callback, so a request in it was silently refused. Permissions now go the same way as everything else the agent does:
out on the conversation's events.

```
harness: "may I send_email?"  →  acp-client  →  event: permission_requested { id, turnId, tool, title, options }
user answers                  →  conversation.answerPermission(id, optionId)  →  acp-client  →  harness continues
```

- **The request is an event** on the conversation, for every turn (prompted or started by the harness). Native: the
  harness's gate decides `ask` and sends `permission/request` over the protocol; ACP: the harness's
  `session/request_permission`, as today.
- **The answer is a method,** `conversation.answerPermission(id, optionId)`, callable at any time while the request is
  open.
- **The per-prompt handler stays as a shortcut:** if the running turn's prompt brought one, it is called and nothing
  waits on events. When a turn took several messages, the first message in its cause that brought a permission
  handler provides it, the rule steering's combined runs use today (`src/steering/combine.ts:23`). A message folded in
  mid-turn (`turn_took`) receives the rest of the turn's stream, but doesn't change its permission handler.
- **When nobody will answer:** a conversation says whether its consumer answers permissions (`answersPermissions:
  true` on `CreateAgentConversationConfig`, with a default in `conversationDefaults`). If so, acp-client waits up to
  `permissionTimeoutMs` (default 5 minutes), then refuses; if not, the permission setting's `default` applies at once,
  so a consumer that never listens doesn't stall every `ask`. The harness's own gate timeout is longer than
  acp-client's, so acp-client's always decides first.
- **A request in a held turn waits with the turn** (it reaches the consumer when the session runs the turn). For
  native the wait is short in practice: only while another operation on that conversation runs, and the long ones
  hold the channel first. **Known risk, open to change:** if waits turn out long (slow persistence, an operation we
  didn't anticipate), permission requests would bypass the wait and go out at once.
- **Forwarded worker requests** at Ask me arrive the same way: as `permission_requested` on the conversation that gave
  the work (marked with the worker), answered with the same method (`11-11-SPEC-orchestrator.md`, Permissions).
- **Records** are unchanged: requested and resolved, with the outcome.
- **One permission setting, everywhere.** The harness's policies use `permissions: { default, rules }` (rules by
  pattern; levels deny, ask, ask the agent, allow; `../harness/11-11-SPEC-harness-v1.md`, Policies). acp-client's own
  ACP conversations use the same shape, replacing today's `defaultPermission: "approve" | "cancel"` (a breaking
  change): `"approve"` becomes `default: "allow"`, `"cancel"` becomes `default: "deny"`. Ask the agent doesn't apply
  there (no agent above an ACP conversation).
- **Matching an ACP request.** An ACP permission request (`src/types.ts:245`) has no stable tool name: a tool call
  id, a free-text title, its options, and in the raw request the tool call's kind (read, edit, delete, move, search,
  execute, fetch, other) and raw input. Rules match two fields only:
  - `kind:<acp kind>`, for example `kind:read`;
  - `command:<exact command>` for execute requests, matched **exactly** after normalization (unwrapping
    `bash -lc "…"`, joining argument lists), never as a substring or prefix.

  When several rules match, the most restrictive level wins; when none matches, `default` applies. A command that
  can't be normalized matches no `command:` rule. Allow picks the request's `allow_once` option (never `allow_always`
  automatically: it would leave a lasting grant in the provider); deny picks `reject_once`; ask goes to the handler or
  the event. Titles aren't matched, and MCP tools over ACP (kind `other`) can't be targeted yet.
- **The same matcher serves the orchestrator:** workers are ACP harnesses, so the policy's `worker:` rules are these
  rules with a prefix (`worker:command:bun test`, `worker:kind:read`). One matcher, tested per adapter's raw input
  shape, used in both places.
- **An optional function** for consumers who want more: `permissionRule(request) => level | undefined` in
  `conversationDefaults`, consulted before the rules for ACP conversations (`undefined` means no opinion). It can't
  replace `worker:` rules, which live in the harness's JSON config.

### Messages from another channel

When the agent, in one channel, uses `message_participant` on another, the harness reports a message on the target
channel outside any turn. acp-client records it on that conversation as an assistant message appended without a turn
(the existing shape of `appendAssistantMessage`, origin `out_of_band`), marked with the channel it came from, and emits
it on that conversation's events so the consumer shows it to that channel's user. `trigger_response` needs nothing
new: the target channel takes a turn of its own, reported like any harness-started turn. In v1 only native channels
of the same session are targets; ACP conversations can become targets as members in phase 2.

## Two logs of one native conversation

The harness keeps the context the model sees, in its store and format. The library keeps its records as an
observation and audit log, as for ACP. The library never rebuilds a native context from its records (continuation,
recovery and adoption are gated off by capability).

## Usage

Exact: each model call reports input, output and cached tokens (cost where the provider reports it), normalized by the
harness's model client, with a **purpose** (`turn`, `compaction`, later others), the channel and the running turn if
any. acp-client files each call by where it happened, not by its purpose:

- **inside a turn:** part of that turn's operation metering on the conversation, tagged with its purpose (compaction
  mid-turn is part of the turn's cost);
- **no turn running** (background work): an entity-level record in `agent_metering_records` (already used for
  internal inference without a conversation, `beginInternalInferenceMetering`), with the purpose as its kind.

A new kind of harness call needs only a new purpose name. The session also keeps its own usage ledger, for standalone
use. acp-client's own conversation summaries (checkpoints) stay acp-client's internal inference, now able to run on
the `http` runtime.

## The inbox

A conversation's **inbox** is what waits to reach the agent in that conversation, other than the host's own prompt
calls: worker replies, failures, redirects, permission requests, items the consumer pushes. Where it lives depends
on who runs the conversation's loop:

- **Native conversations: the harness's.** An item is pushed onto the conversation's channel; the harness keeps it in
  that channel's inbox in its own store (so it survives a restart), starts a turn if the channel is idle, or puts it
  into the context at the next model call. acp-client stores nothing for items; the turn that takes one is recorded
  like any turn.
- **A native user message is recorded when the harness accepts it,** keyed by the message id (not by a turn), and is
  durable from then on; the turn that takes it links to it through its cause. So native messages don't share ACP's
  "durable only once its turn starts" (`findings/11-12-FINDING-acp-message-durability.md`), and `accepted` on the
  prompt handle resolves at that moment (for ACP, when queued).
- **ACP conversations: acp-client's out-of-band messages,** as today (`src/out-of-band-messages.ts`: records with
  `origin: out_of_band` plus the `out_of_band_delivery` cursor), delivered into the next prompt. ACP harnesses can't
  be woken by an item; a wake needs a prompt the consumer allows (later). For these, out-of-band records gain a kind
  and a sender in their metadata.
- **Live prompts and steering** go through the conversation's queue (`AgentConversationQueue`) and the steering
  controller (`src/steering/controller.ts`), as today.
- **Item kinds:** `worker_reply`, `worker_failed`, `worker_redirected`, `worker_interrupted`, `permission_request`
  (only a worker's request forwarded at the ask-the-agent level; requests for the user are events, Permissions
  above), consumer kinds. The harness renders each kind.
- **Native steering:** the steering controller cancels a running turn through `SteeringHost.cancelProviderTurn`. With
  `nativeSteering`, the native host pushes the steer item onto the channel instead; nothing is cancelled and
  `endedBy: "steer"` doesn't occur for native turns. Interrupt stays a separate action.
- **What comes out of a wake:** a turn the agent takes on its own produces events and records like any turn; it
  reaches a user only if the host delivers it.
- **The orchestrator's delivery port** is implemented on this.

## Identity becomes injection

The harness owns the entity (the timeline; harness design spec). How it keeps it doesn't matter to the library;
identity reaches ACP conversations by injection.

ACP conversations are **managed member channels** of the session (v1): registered when a harness is configured
(`member/register`, with the conversation's policy and title), their messages and summaries reported, and their
identity prepared by the harness. The harness's MCP server, through which members could read and write the identity
themselves, is phase 2.

**The existing interface already fits.** `AgentIdentityRuntime` (`src/identity.ts`):

| Method | Called | For the harness adapter |
| --- | --- | --- |
| `load(input)` | before every prompt, with participant and target provider context (`src/agent/persisted-lifecycle.ts:96`) | `member/prepare`: the digest since the member's position, as `promptPreamble`, plus a receipt |
| `update(input)` | after every committed batch of records (`src/agent/record-capture.ts:44`) | `report`: append the conversation's messages to the timeline |
| `delivered(receipt)` | once the provider has the prompt | `member/delivered`: advance the member's position |
| `synchronize` | optional | not needed |

So no new interface: `harnessIdentityRuntime(host)` implements `AgentIdentityRuntime`. Changes:

- **Native conversations are skipped** in `load` and `update` (the harness has them already).
- **With lazy start (stage 2b decision, recommended):** `update` reports lazily: acp-client keeps a report cursor per
  ACP conversation, and when the harness next starts it reports everything since, so saving records never starts the
  harness. `load` runs inside the prompt's own operation, as today, and starts the harness if needed (`prepare` needs
  it), adding start time to that prompt only. Neither changes `isBusy`.
- **MCP servers for members** are attached at session creation, not per prompt: a new optional
  `mcpServers(conversation)` on the runtime, read where `CreateAgentConversationConfig.mcpServers` is applied. Phase 2,
  with the harness's MCP server.
- **Summaries:** when the checkpoint coordinator (`src/checkpointing/coordinator.ts`) completes a checkpoint, the
  runtime reports it (`report(kind: "summary")`). A new optional `checkpointed(input)` hook on the runtime.
- **Receipts** change shape: `IdentityDeliveryReceipt` names source conversations and sequences; the harness's receipt
  is `{ member, context, through }`. Make the receipt opaque to the library (`unknown` carried back), which also
  retires `identity_delivery_cursors` for harness-backed identity.
- **Delivery is at least once:** a failed prompt is delivered again; a crash after the provider got it repeats a
  slice, harmlessly. acp-client stores nothing identity-related for harness-backed identity.
- **Deprecation.** With no harness, ACP conversations get no cross-conversation identity unless the consumer keeps
  `CheckpointBackedIdentityRuntime`, deprecated and removed in a breaking release.

## MCP for ACP conversations (phase 2)

The harness's MCP server (`./mcp-server`) gives ACP conversations identity tools as members, and later delegation
tools. One endpoint per member, scoped by a token. ACP requires stdio MCP; HTTP and SSE only where advertised (send
`mcpServers` only to agents that advertise them, as `68d7af0` did for `additionalDirectories`). With the harness in its
own process, a stdio bridge stub connects to it. Workers never get delegation tools by default. Approve the server's
tools by exact server and tool name.

## Configuration

```ts
new Agent({
  adapters: {
    main:   { kind: "native", defaultPolicy: "owner" },
    codex:  { command: ["codex-acp"] },                 // an Adapter, as today (or ADAPTERS.codex)
    claude: ADAPTERS.claude,
  },
  defaultAdapterId: "main",
  harness: { config: "./harness.json" },               // the entity; `home`, `command`, `launcher`, `idleStopMs` optional
  conversationDefaults: { launcher, cwd },             // as today; also starts the native harness
  persistence: { ... },
  functions: { crm_search: async (input) => { ... } }, // served to the harness for run.type "function" tools
  orchestrator: { workers: { adapterId: "codex", cwd: "/work", limit: 2 } },
  internalInference: {                                 // "http" when a model is configured, else "harness"
    runtime: "http",
    model: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", model: "..." },
  },
});
```

What the library provides to the harness, all through its protocol:

| The library | Through |
| --- | --- |
| Where the session lives | `harness.home` (a path in the harness's environment) |
| The configuration | the effective config (`harness.config` plus stored overrides), on every start and on each update |
| Function tools | callback `functions/call` for each name in `functions` |
| Workers for delegation | callback `delegation/*`, served by the orchestrator (its spec) |
| ACP transcripts for history tools | callback `history/*` over its records |
| Sender and policy | on each push (the message's sender and policy), plus each channel's stored policy; chosen by the consumer, never by the end user |

## Internal inference over HTTP

Checkpoints, summaries and recovery seeds are one prompt and one answer, today run in a disposable ACP session
(`src/internal-inference/runtime/harness-runtime.ts`, `disposable-session-env.ts`).

- **A new `http` runtime** implementing `InternalInferenceRuntime.run(request, signal, lifecycle)`: one model call,
  no process, structured output.
- **Its own minimal client.** Internal inference is one call with structured output: no tools, no streaming, no
  channels. acp-client keeps a small OpenAI-compatible client of its own for it instead of importing the harness's,
  so internal inference doesn't need the harness package; the duplication is small. It runs in acp-client's process
  (internal inference is the library's own work, not the agent's), with its own model config and key
  (`internalInference.model`), since the harness's key lives in the harness's environment.
- **The lifecycle is ACP-shaped** (`stageChanged("creating_session" | "prompting")`, `sessionStarted({
  internalSessionId })`): the runtime reports `prompting` only and no session; records that expect an
  `internalSessionId` must accept none.
- Used when a valid key is configured; the disposable session stays as the fallback.

## Code plan

```
src/native/
  adapter.ts             NativeAdapter, AgentHarnessConfig, validation, AgentAdapter union helpers
  host.ts                NativeHarnessHost: one per Agent = one session; launches `harness serve`, holds the client,
                         restarts on crash, serves callbacks
  callbacks.ts           functions, history (→ records); routes `delegation/*` to the orchestrator (added by its spec)
  config-store.ts        stored config overrides; effective config; describe() for options, commands, capabilities
  lifecycle.ts           lazy start (started once), optional idle stop, bounded restart, failed state
  channel-changes.ts     pending channel changes (coalesced), sent at once or inside the start call
  native-controller.ts   ConversationController over the client; send ends at acceptance
  translate-events.ts    harness events → the agc update model
  steering-host.ts       native steering: push instead of cancel
  inbox-delivery.ts      pushing items onto native channels (the orchestrator's delivery port uses it)
  identity-runtime.ts    harnessIdentityRuntime (AgentIdentityRuntime)
  index.ts
src/permissions/matcher.ts   the ACP permission matcher (kind, exact normalized command), shared with the orchestrator
src/internal-inference/runtime/http-runtime.ts
src/internal-inference/runtime/openai-compatible.ts   the minimal client (one call, structured output, usage)
src/launcher.ts          AcpLauncher → ProcessLauncher (alias kept), kind "native-harness"
```

- **`src/native/` is the only place that imports the harness package.** The acp-client core depends on contracts
  (`ConversationController`, `AgentIdentityRuntime`, `DeliveryPort`).
- **Touches existing code:** `src/agent.ts` and `src/agent/config.ts` (the `AgentAdapter` union, constructing the host,
  `functions`); `src/agent-adapter-registry.ts` (store either adapter type); the controller factory
  (`createController`, `src/agent-session.ts:733`, via the controller-interface work) chooses `NativeController` for a
  `NativeAdapter`; `src/out-of-band-messages.ts` (kind and sender in metadata); `src/identity.ts` (optional
  `mcpServers`, `checkpointed`; opaque receipt); the checkpoint coordinator (call `checkpointed`); the permission
  setting replacing `defaultPermission` (`src/agent/config.ts` and where `defaultPermission` is read in
  `src/agent-session.ts`, a replacement, not new code); `permission_requested` and `answerPermission` on conversations
  (stage 2a).
- **Storage** (schema changes, no migrations needed): a `harness_config` table (the `Agent`'s id, the overrides as
  JSON, updated at); on `conversations`, a `policy` column and a `harness_pending` flag; channel settings reuse the
  conversation configuration persistence `setConfig` already uses for ACP; native user records keyed by message id.
- **`agent-session.ts` does not grow.** Steering already goes through `SteeringHost`; the controller choice is the
  factory; anything else needed there is extracted first.

## Stages

This spec is implemented in two stages, each against the matching part of harness v1
(`../harness/11-11-SPEC-harness-v1.md`, Two parts). End-to-end tests run through a real `harness serve` process with
the harness's scripted model (its test mode), so they need no provider key.

**Stage 2a, with harness part 1: native conversations end to end.** The work, not yet a plan:

- `NativeAdapter`, `AgentHarnessConfig` and the registry change; the `NativeHarnessHost` with the in-process
  transport; the `NativeController` passes the controller conformance suite on the harness's scripted model.
- The process transport and lifecycle: launch through the launcher, lazy start, optional idle stop, crash and bounded
  restart, `HarnessUnavailableError`; a real `harness serve` process in tests; `harness.home`.
- Configuration known before start: stored config and overrides, `describe`, channel settings stored per
  conversation; `agent.harness.config()`, `updateConfig`, `resetConfig`.
- Turns the harness starts reach `runTurn`, also for conversations not loaded; `turn_took` extends a cause; steer
  and queue hints; dropped messages settled; withdraw through the harness; held usage and signals; native steering
  behind `nativeSteering`; usage filed by purpose.
- Holds for the exclusive operations; the native admission rules.
- The native half of delivery: pushing items onto channels (the port the orchestrator will use).
- Native user records at acceptance; `accepted` on the prompt handle.
- Permissions as events: `permission_requested`, `answerPermission`, `answersPermissions`, `permissionTimeoutMs`; the
  one permission setting replacing `defaultPermission`, with the ACP matcher and the optional function; the harness's
  `permission/request` routed to the conversation.
- `setTitle`, `setPolicy` (the `policy` column), per-channel settings through `setConfig`.
- From the controller-interface spec: a neutral provider-session record (native: the `Agent`'s id plus the channel
  id), the neutral permission request shape, the model-call record, opaque provider data on messages; the
  `capabilities` getter becoming `Capabilities | null`.
- `agent.harness.export()` and `import()` (import renames the session to the `Agent`'s id).

**Stage 2b, with harness part 2: what needs the full harness.**

- Identity for ACP conversations: `harnessIdentityRuntime` (`load`, `update`, `delivered` over `member/*` and
  `report`), the `checkpointed` hook, opaque receipts; the checkpoint-backed runtime wrapped as a deprecated source.
- Callbacks: functions (`functions/call`) and history (`history/*` over records). Delegation callbacks belong to the
  orchestrator spec.
- Messages placed on a channel outside a turn (`message_participant`) recorded on the target conversation and
  emitted.
- The `http` internal-inference runtime with its own minimal client (independent of the harness; it can be done at
  any point).

## Acceptance

**Stage 2a:**

- A native conversation runs end to end against `harness serve` (scripted model) started through a launcher: prompt,
  steer injected without cancel, queue as a turn of its own, interrupt, usage in metering, records written. In a
  container: a manual or optional check (it needs Docker).
- Before any activity, a native conversation's config, models and commands can be read and changed with no process
  running; the first message starts the process; with idle stop on, it stops and starts again on the next message.
- A message folded into a running turn settles with that turn's result; a dropped message settles cancelled.
- `forceStop` on one native conversation leaves the others' turns running.
- A turn the harness starts on its own (an item pushed onto the channel) is recorded and emitted on the conversation's
  turn events with its cause.
- Killing the harness process ends running turns with an error, and the next prompt works after the restart.
- A permission `ask` from the harness reaches the consumer as `permission_requested` and `answerPermission` resolves
  it; with no answerer, `default` applies at once; an ACP conversation's permissions follow the same setting.
- Two native conversations of one `Agent` are channels of one session.
- An exported session imported into a fresh home is the same entity.
- With no native adapter configured, behaviour is unchanged and the existing suite passes.

**Stage 2b:**

- A fact told in one native conversation is known in another (timeline delivery).
- An ACP conversation with a harness configured receives a preamble from `load`, and its position advances only after
  `delivered`.
- A `function` tool runs through the callback; the history tools read acp-client's records.
- `message_participant` from one native conversation appears on the other conversation as an appended assistant
  message and on its events.
- Internal inference runs over `http` with a key, and over the disposable session without one.

## Open

- [ ] Whether acp-client hard-depends on the harness package or takes it as an optional peer (overview).
- [ ] Do Codex and Claude support HTTP MCP servers over ACP, or is the stdio bridge needed (phase 2)?
- [ ] Whether the consumer may wake an ACP conversation with an item (a prompt it allows), or ACP only gets next-prompt
      delivery.
