# The harness protocol: how a host talks to the native harness

Status: first design, written 2026-11-12. The boundary between the native harness (`src/native-harness/`) and
its hosts (acp-client's `src/native/`, the standalone CLI, any other host). Both sides are built against this spec in
parallel: the harness implements it (`harness/11-11-SPEC-harness-v1.md`), acp-client builds against a fake that
implements it first and swaps in a real `harness serve` last (`library/11-11-SPEC-native-harness-integration.md`).
It collects what those two specs say about the protocol; where they disagree, this spec wins and they are corrected.

**How it was designed, and how it will be refined.** Top-down with the owner: decisions, who it's for, priorities,
non-goals and delivery first, then this first design of the messages, meant to cover the bases rather than to be
reviewed to perfection. It isn't walked through scenario by scenario now: once both sides are built, the scenarios
(Scenarios, at the end) are walked through and stress-tested (`11-12-SPEC-end-to-end-robustness.md`), and the weak
points the tests show change this spec.

## Decisions

1. **Our own protocol, shaped like ACP.** ACP is the shared protocol for driving coding harnesses (Codex, Claude
   through its adapter, Gemini CLI, OpenCode, Grok), but it is built on "one prompt in, one turn out": the agent
   can't start a turn, a session takes one prompt at a time (so steering means cancel and resend), and it has no
   items other than user prompts, no policy per message or channel, no holds, members or our callbacks. About two
   thirds of what we need would live in extensions no other ACP client understands, while we'd carry ACP's
   constraints and its schedule. So the protocol is ours, but it borrows ACP's conventions wherever the meaning is
   the same: JSON-RPC 2.0 with one message per line, update events shaped like `session/update`, permission requests
   shaped like `session/request_permission`. Later, an optional second mode (`harness serve --acp`) lets any ACP
   client use the harness in a reduced form (prompt and turn only). When ACP v2 (a draft that adopts messages in,
   turns out) is stable, we revisit. MCP (tools) and A2A (agents talking to agents, remote, task-based) don't fit;
   A2A may matter later for outside agents joining as participants.
2. **The host subscribes to what it wants.** ACP sends a client everything (every chunk, tool update, thought),
   whether it wants it or not. Here the host subscribes per channel (with a connection default) to classes of
   events, with levels: assistant text `stream`, `stream` coalesced, or `final` only; tool calls `none`, `summary`
   or `full`; reasoning `none`, `summary` or `full`; the model-call log on or off. Always on, whatever the
   subscription: usage (metering needs it; per call or per turn), turn boundaries, permission requests, and a small
   periodic `progress` signal on every running turn, so stall detection works even when no text streams.
   Subscriptions can change mid-session. acp-client subscribes to the union of what it persists and what its
   consumer asked for, so "chats only" persistence with a non-streaming consumer means the extra traffic is never
   sent, instead of being sent and discarded.
3. **Channels and participants are first-class.** ACP has a session with one implicit user. Here channels are real
   objects (state, events, the participants on them) and participants are a registry per session (id, kind, label),
   which the host maintains; items reference their sender by id, so the agent sees who's who across channels. Small
   in v1 (the registry, references, labels); designed so group channels, per-participant defaults, addressing a
   person rather than a channel, and outside agents as participants come later without changing its shape.

## Who it is for

**Only between our two components:** a host (acp-client's `src/native/`, the harness's own CLI) and the harness.
**No stability guarantees of any kind:** breaking it in any way is free, as long as both sides change together (one
commit, since they live in the same repo). The version number still exists, only to detect a mismatch (a harness
installed in a container from a different release than acp-client) and fail clearly. It may later be treated as
public, even split out and published; then stability promises, fuller documentation and conformance tests for
outside hosts come with that decision, not before. Outside tools that want the harness today use the optional ACP
mode (Decisions, 1).

## Priorities

When two goals conflict, the higher one wins:

1. **Correctness of conversation state.** No message lost or applied twice, every prompt settles exactly once,
   events of a channel in order, nothing runs under the wrong policy or setting.
2. **Robustness to failure.** Crashes, hangs and slow or failing persistence are expected; every wait is bounded and
   every state is recoverable.
3. **Selectivity.** Each side receives only what it asked for, at the level of detail it asked for (Decisions, 2).
4. **Evolvability.** It will grow with phase 2: versioning and optional fields from the start.
5. **Performance.** Last: it is a local pipe and the model is always the slow part. The only heavy traffic is the
   token stream, which subscriptions already reduce.

Simplicity is not a goal that wins arguments but the baseline of a good design: no concept, message or option
without a scenario that needs it.

## Non-goals

- **Not a network protocol in v1.** The transport is stdio: the harness runs as the host's child process, locally or
  in a container through the launcher (`docker exec`), as ACP harnesses do today. A broken connection always means
  the process died, which is why reconciliation at start is enough (Delivery). Nothing in the messages assumes
  stdio, so a socket or network transport later is a new way to carry the same messages, bringing with it sequence
  numbers and replay, authentication, reconnects and the question of several hosts.
- **Not several hosts on one session at once.** The session is locked to one host.
- **Not a public or stable API** (Who it is for).
- **Not optimized for throughput** (Priorities, 5).
- **Not a way to run the agent without a host.** The harness's CLI is its own host, using the same protocol or the
  in-process transport, not a separate mode.

## Delivery

How messages survive loss and repetition, borrowed from messaging protocols (MQTT's delivery levels, idempotency keys
as in Matrix transaction ids or Stripe, durable acknowledgements, XMPP stream management and Matrix sync for
recovery):

- **Host → harness: at least once, with idempotency keys, so exactly once in effect.** Every push carries an item id
  chosen by the host; a push whose id the harness has already stored is acknowledged again, not stored twice. A
  channel update carries the full state of what changed, so sending it twice changes nothing. A timeout always means
  "send again"; retrying is always safe.
- **Acknowledgements mean "stored durably."** `channel/push` returns `accepted` only once the item is in the
  harness's store, so the host can stop holding it.
- **Harness → host, by kind of event:**
  - **text deltas and progress signals: at most once.** Losing one changes nothing; the final message and the turn's
    end carry the truth.
  - **state events (`turn_started`, `turn_took`, `turn_ended`, usage, `messages_dropped`, out-of-turn messages):
    reliable through reconciliation.** The connection only breaks when the process dies (the harness is the host's
    child; Non-goals), so the only gap is around a crash. At start, `session/load` returns each channel's recent
    turns (their ids, the items each took, how they ended, their usage) and the items still waiting; the host
    compares that with its own records and settles what it missed. One comparison at the only moment a gap can
    appear, instead of acknowledging every event.
  - **later, with a network transport** (connections dropping while both sides live): per-channel sequence numbers
    on state events, host acknowledgements, and replay from the last acknowledged number after a reconnect.
- **Ordering:** within a channel, always; across channels, never promised.

## Principles

- **The harness's public API, made serializable.** Every call takes and returns JSON-shaped data; the same calls
  work in process (direct method calls, for tests and the CLI) and over stdio (JSON-RPC). Hosts never write protocol
  code: they use `HarnessClient` from `src/native-harness/client.ts`.
- **One process per session (entity), all its channels multiplexed** over one connection.
- **The host owns policy and lifecycle; the harness owns the agent's work.** The host starts, stops and restarts the
  process, decides policies and what may happen on each channel; the harness decides when a channel takes a turn and
  what it does in it (overview, decision 41).
- **Nothing waits forever.** Every request that can wait has a bound (Timeouts, below).
- **Part 1 and part 2.** Each method is marked with the harness part that implements it (`harness/11-11-SPEC-harness-v1.md`,
  Two parts). Part 1 is what integration stage 2a needs.

## Transport and framing

- **JSON-RPC 2.0** over the process's stdin and stdout, one JSON message per line (newline-delimited, as ACP does).
  stderr is the harness's log, never protocol.
- **Three kinds of message:** host → harness requests; harness → host notifications (events, no reply); harness →
  host requests (callbacks, the host replies).
- **The in-process transport** carries the same messages as values, with no serialization; contract tests run every
  scenario through both transports.
- **Start:** `harness serve --stdio [--home <path>]`, launched by the host through its own launcher (for acp-client,
  `ProcessLauncher`, so `docker exec`, cwd and env work as for ACP harnesses).
- **Stop:** closing stdin. The harness finishes running turns as interrupted, writes its store, releases the lock and
  exits. A crash is the host's to detect (the process exits or stops answering) and restart.

## Versioning

- `initialize` exchanges `protocolVersion` (an integer, starting at 1). The harness refuses a host with a version it
  doesn't support (`version_mismatch`); the host refuses a harness the same way. This only detects mismatched
  releases; there is no compatibility promise across versions (Who it is for).
- Any change may bump the version; both sides support exactly one version at a time.
- `initialize` also returns the harness's own version, which acp-client uses to check the static `describe` it ran
  from its installed copy (integration spec, Configuration known before start).

## Shared types

```ts
type SessionId = string;       // the entity; acp-client uses the Agent's id
type ChannelId = string;       // a line into it; acp-client uses the conversation id (agc-…)
type ParticipantId = string;   // chosen by the host; acp-client uses its participant ids
type ItemId = string;          // chosen by the host for items it pushes (acp-client: the message id); the idempotency key
type TurnId = string;          // chosen by the harness
type Part =
  | { type: "text"; text: string }
  | { type: "media"; mime: string; data: string };            // base64; size-limited (Open)

interface Participant {          // first-class: a registry per session, maintained by the host
  id: ParticipantId;
  kind: "person" | "agent" | "worker" | "host";
  label?: string;                // what the agent sees
}

interface Item {
  id: ItemId;
  kind: "user_message" | "worker_reply" | "worker_failed" | "worker_redirected" | "worker_interrupted"
      | "permission_request" | string;                       // open; each kind has a renderer in the harness
  sender: ParticipantId;         // an id not yet registered is registered with no label
  content: Part[];
  policy?: string;               // asserted by the host for this item only; a turn takes the most restrictive
  delivery?: "steer" | "queue";  // default per kind (user_message: from the host; worker_reply: steer)
  wake?: boolean;                // default true; false: waits for the next turn without starting one
  data?: unknown;                // kind-specific facts for the renderer
}

interface ChannelState {         // what the host holds as the truth for a channel; every field optional
  policy?: string;
  label?: string;
  settings?: { model?: string; reasoning?: string; temperature?: number };
  subscription?: Subscription;
  reset?: true;                  // start the channel on a fresh context
  closed?: true;                 // the conversation was deleted
}

interface Subscription {         // what the host wants to receive (Decisions, 2)
  text: "stream" | "coalesced" | "final";      // coalesced: deltas batched every coalesceMs (default 100)
  coalesceMs?: number;
  tools: "none" | "summary" | "full";          // summary: name, start, end, status; full: inputs and outputs
  reasoning: "none" | "summary" | "full";
  modelLog: boolean;
  usage: "per_call" | "per_turn";
}
// Always sent whatever the subscription: turn_started, turn_took, turn_ended, message_completed, usage (at the
// chosen grain), progress, messages_dropped, permission requests.

interface Usage {
  purpose: "turn" | "compaction" | string;
  turnId?: TurnId;               // when the call happened inside a turn
  model: string;
  input: number; output: number; cachedInput?: number;
  cost?: number;                 // when the provider reports it
  latencyMs: number;
  calls?: number;                // per_turn: how many model calls the record sums
}

interface TurnRecord {           // for reconciliation at start (Delivery)
  turnId: TurnId;
  items: ItemId[];               // every item the turn took, in order
  outcome: "completed" | "interrupted" | "failed" | "running_at_crash";
  usage: Usage[];
  messages: { messageId: string; parts: Part[] }[];   // the assistant messages it produced
}
```

## Host → harness requests

**Lifecycle (part 1)**

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | `{ protocolVersion, host: { name, version }, callbacks: string[], subscription: Subscription }` (the callbacks the host serves; the connection's default subscription) | `{ protocolVersion, harness: { version }, description: { configOptions, commands, capabilities, policies } }` |
| `session/create` | `{ sessionId, config, participants: Participant[], channels: Record<ChannelId, ChannelState> }` | `{ sessionId }`; fails with `already_exists` |
| `session/load` | `{ sessionId, config, participants: Participant[], channels: Record<ChannelId, ChannelState>, since?: string }` | `{ sessionId, channels: Record<ChannelId, { hasContext, turns: TurnRecord[], waiting: ItemId[] }> }`; fails with `not_found`, `locked` |
| `session/idle` | `{}` | `{ idle: boolean }`: no turn running, no inbox holding items, no hold active |
| `session/export` | `{}` | `{ bundle }` |
| `session/import` | `{ sessionId, bundle }` (before any create or load on this process) | `{ sessionId }`; fails with `already_exists` |

- **The config, participants and pending channel changes go inside `session/create` and `session/load`.** The
  harness applies them before it can start any turn, so nothing runs under an old policy or setting (integration
  spec, Channel changes). `channels` lists only channels with changes; each entry carries the latest value of each
  field.
- **Reconciliation:** `session/load` returns, for every channel with activity after `since` (the host's last known
  record time), the turns that ended or were running at a crash, and the items still waiting. The host compares them
  with its records and settles what it missed (Delivery).
- **The session is locked** by `session/create` and `session/load`; a lock whose process is gone is reclaimed.

**Channels (part 1)**

| Method | Params | Result |
| --- | --- | --- |
| `channel/push` | `{ channel, item }` | `{ accepted: true }` once the item is stored in the channel's inbox (durable). Idempotent: a push with an id already stored is acknowledged again, not stored twice |
| `channel/withdraw` | `{ channel, itemId }` | `{ withdrawn: boolean }`: false when the item was already taken (or never stored) |
| `channel/interrupt` | `{ channel, dropWaiting?: boolean }` | `{ interrupted: boolean, dropped: ItemId[] }` |
| `channel/update` | `{ channel, state: ChannelState }` | `{}`: policy and label apply from the next item; settings from the next model call; a subscription at once; `reset` and `closed` wait for a running turn unless the channel is held with interrupt. Idempotent |
| `channel/hold` | `{ channel, leaseMs, interrupt?: boolean }` | `{ holdId }` once no turn runs on the channel (waiting for it, or interrupting it) |
| `channel/renew` | `{ holdId, leaseMs }` | `{}`; fails with `hold_expired` |
| `channel/release` | `{ holdId }` | `{}` (releasing an expired hold is not an error) |

- **Channels always exist:** a channel is created the first time it is named (in a push, an update or a start's
  `channels`).
- **One update call** carries whatever changed (policy, label, settings, subscription, reset, closed), the same shape
  as a pending change at start.
- **Holds are leases:** a hold expires on its own after `leaseMs` unless renewed, and ends when the host disconnects
  or the process restarts. While held, the harness starts no turn on the channel; items keep arriving in its inbox.

**Participants, config and usage (part 1)**

| Method | Params | Result |
| --- | --- | --- |
| `participants/update` | `{ participants: Participant[] }` (added or changed) | `{}`; idempotent |
| `config/update` | `{ config }` (the full effective config) | `{ description }`; applies from the next model call; fails with `invalid_config` |
| `usage/get` | `{ since?: string }` | `{ records: Usage[] }` (the session's own ledger; part 2) |

**Members and reports (part 2)**

| Method | Params | Result |
| --- | --- | --- |
| `member/register` | `{ member: ChannelId, policy, label }` | `{}`; idempotent |
| `report` | `{ member, reportId, kind: "message" \| "summary", from: ParticipantId, policy, content: Part[], at }` | `{}`; idempotent by `reportId` |
| `member/prepare` | `{ member, context: string }` | `{ preamble: Part[] \| null, receipt: unknown }` |
| `member/delivered` | `{ receipt }` | `{}`; idempotent |

## Harness → host notifications

One notification method, `channel/event`, with `{ channel, event }`. Events for a channel arrive in order. Which
optional events a host gets follows the channel's subscription.

| Event | Fields | When sent | Meaning |
| --- | --- | --- | --- |
| `turn_started` | `turnId, items: ItemId[]` | always | the channel started a turn, taking these items |
| `turn_took` | `turnId, items: ItemId[]` | always | more items folded into the running turn (steer) |
| `progress` | `turnId, stage: "model" \| "tool" \| "waiting"` | always, every few seconds while a turn runs | liveness for stall detection, even when nothing else streams |
| `text_delta` | `turnId, messageId, text` | `text: stream` or `coalesced` | assistant text, streamed (at most once) |
| `message_completed` | `turnId, messageId, parts: Part[]` | always | a complete assistant message: the truth for records |
| `tool_call` | `turnId, id, name, status, input?, output?` | `tools: summary` (no input or output) or `full` | a tool call starting, updating, ending |
| `reasoning` | `turnId, text` | `reasoning: summary` or `full` | the model's reasoning, where the provider exposes it |
| `usage` | `Usage` | always, per call or per turn as subscribed | model calls' usage |
| `model_call` | `turnId?, request: summary, stopReason, latencyMs` | `modelLog: true` | the model-call log |
| `turn_ended` | `turnId, outcome: "completed" \| "interrupted" \| "failed", error?` | always | the turn ended |
| `messages_dropped` | `items: ItemId[]` | always | items an interrupt removed from the inbox |
| `message` | `messageId, from: ChannelId, parts: Part[]` | always | text placed on this channel outside a turn (`message_participant`; part 2) |
| `description_changed` | `description` | always | the live description changed (after a config update) |

- **Order per channel:** `turn_started` comes before any event of its turn; `turn_took`, `progress`, the stream,
  `message_completed`, `tool_call`, `reasoning` and `usage` come between it and `turn_ended`; `turn_ended` is the last
  event of its turn. Per-turn usage comes just before `turn_ended`.
- **Usage outside a turn** (compaction between turns) has no `turnId`.
- **Text deltas are a convenience;** `message_completed` always follows with the whole message, so a host that lost a
  delta, or subscribed to `final`, still records the exact text.

## Harness → host requests (callbacks)

Only the callbacks the host declared in `initialize`; for any other, the matching tools are unavailable, not broken.

| Method | Params | Result | Part |
| --- | --- | --- | --- |
| `permission/request` | `{ channel, turnId, requestId, tool: { name, input }, title, options: { id, label, kind }[] }` | `{ optionId }` or `{ outcome: "refused" }` | 1 |
| `functions/call` | `{ channel, turnId, callId, name, input }` | `{ output }` or `{ error }` | 2 |
| `delegation/open\|send\|check\|stop\|list` | `{ channel, sender, delegation, workerPermissions, ... }` | per orchestrator spec | 2 |
| `history/search\|read` | `{ channel, query \| ref }` | `{ results }` | 2 |

## Errors

JSON-RPC errors with a stable `data.code`:

| Code | When |
| --- | --- |
| `version_mismatch` | `initialize` with an unsupported protocol version |
| `locked` | the session is open in another live process |
| `not_found` / `already_exists` | load of a missing session / create or import of an existing one |
| `invalid_config` | a config that fails validation, with paths to the bad fields |
| `unknown_policy` | an item or update naming a policy the config doesn't have |
| `hold_expired` | renewing a hold that already expired |
| `channel_closed` | a push or update on a channel closed by a delete |
| `too_large` | an item or media part over the size limit |
| `not_ready` | a request before `session/create` or `session/load` |

## Timeouts

Every wait has a bound (integration spec, Nothing waits forever).

| Who waits | For | Bound |
| --- | --- | --- |
| host | `initialize` and `session/load` after launch | the host's start timeout (acp-client: 60 s) |
| host | any other request | 30 s by default, longer for `session/export` and `session/import` |
| harness | a `permission/request` reply | the gate timeout (default 10 min), longer than any host's permission timeout; then refused |
| harness | other callbacks | per callback (functions: the tool's timeout; delegation: 30 s) |
| harness | a hold | its lease; expiry releases it |

## Scenarios

Walked through step by step and stress-tested once both sides are built (`11-12-SPEC-end-to-end-robustness.md`),
each with its failure cases (a message lost, repeated, late, or a side dying at each step); what they show changes
this spec.

1. The first message to a cold agent: lazy start, `initialize`, `session/load` with pending changes, push, turn.
2. A steer during a turn.
3. A queued message while a turn runs.
4. A worker reply while the conversation is idle, and with the harness stopped.
5. A permission request: answered, timed out, arriving in a held turn.
6. A policy changed while the harness is stopped, with an item already waiting.
7. An interrupt that drops waiting messages.
8. A crash mid-turn, and the reconciliation at restart.
9. An exclusive operation (a delete, a handoff out) with a hold lease, including a holder that disappears.
10. An idle stop racing a new message.
11. Two channels busy at once, with a held turn on one.
12. A consumer that only wants final messages (subscriptions), and one that changes its subscription mid-turn.
13. Export and import.

## Open

- [ ] Media: inline base64 with a size limit (this design), or a host callback (`media/read`) for large files.
- [ ] Batching several pushes in one request.
- [ ] Whether `progress` should carry more (the tool running, tokens so far) for richer UIs.
