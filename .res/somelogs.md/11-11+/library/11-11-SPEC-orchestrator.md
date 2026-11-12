# Orchestrator and worker pool

Status: agreed, not started. Written 2026-11-11, model restated and grounded in code the same day. Lines of work L2
and L3 in `../11-11-NOTE-overview.md`. Buildable first: tested through the consumer API with real or fake workers,
with no harness and no provider key.

## Problem

Today every conversation owns a whole harness process (`AgentSession` creates its controller, which creates an
`AcpClient`, which launches a process). Ten conversations are ten Codex or Claude processes, and nothing limits live
processes or evicts idle ones.

The design (overview, decisions 1, 8, 9): many cheap native conversations talk; a fixed number of workers, usually
external harnesses, do the environment work. Between them sits one library module, the orchestrator, which holds the
pool and applies every rule about workers.

## What it is, and what it isn't

The orchestrator turns "the agent wants work done" into worker conversations and keeps every rule about them in one
place. It does not:

- decide whether to delegate, what to say or when to check (judgment, in the model);
- render anything into a context (the harness);
- speak to users (nobody in the library does: it records facts, never lines such as "Delegated · running");
- know about the harness (it implements a backend shape that `src/native/` wires to the harness).

## Roles and the entity

- An **agent** conversation is one run by the native harness. A **worker** is an ordinary conversation the pool runs
  for the entity, usually on an external harness (Codex, Claude), possibly native. Whether the agent's tool
  descriptions call it a worker or "an agent working for you" is wording in the harness's default prompts.
- **Workers belong to the entity, not to a conversation.** Two conversations with the same agent are the same agent
  talking twice, so every conversation of the entity sees and can use every worker unless its policy says otherwise.
  Two conversations sharing two workers is better than each holding one.
- **The agent owns the conversation and the decisions taken with the user; the worker owns the execution.** Nobody
  steers the worker step by step.
- **No task model.** No lifecycle, structured brief or library-decided "done". The only soft structure is a short
  description the agent writes (`about`, below), kept for `check`, `list` and the busy answer.

## Placement and dependencies

```
consumer API  ──┐
harness tools ──┼──> orchestrator ──> pool ──> worker conversations
MCP tools     ──┘    (rules, routing)
(later)
```

| It uses | For |
| --- | --- |
| The `Agent`'s conversation manager (`create`, `open`, `list`, `delete`, stop; `src/agent/conversation-manager.ts`) | creating, reloading and deleting workers; nothing new in the manager |
| A persistence extension `orchestrator` (the existing versioned extension mechanism, `persistence_extensions`, `src/persistence/sqlite-backend.ts:375`) | its own tables, without touching the core schema |
| A delivery port (an interface it defines) | the way back into agent conversations |
| The `Agent` event bus | events for the consumer |

Today an extension can only create its tables (`migrate`, with `execute`) and be told about committed records
(`recordsCommitted`); it has no way to read or write its tables afterwards (`src/persistence/backend.ts:805`). The
orchestrator needs one, so step 1 adds a runtime handle: `scope.extension(id)` inside `persistence.transaction`,
with `execute` and `query`, only for installed extensions and only on tables prefixed with the extension's id. A
persistence backend without extensions (`capabilities.extensions: false`) can't host the orchestrator; the `Agent`
rejects that configuration.

`conversations.metadata` is not used: it is the consumer's own string (`CreateAgentConversationConfig.metadata`).
Nothing imports the orchestrator except the `Agent` (which constructs it when `orchestrator` is configured) and
`src/native/delegation-backend.ts`. An `Agent` with no orchestrator configured behaves as today.

## Data model

`orchestrator_workers`, one row per worker:

| Field | Meaning |
| --- | --- |
| `handle` | the short id the agent sees (`w1`), unique per `Agent` |
| `conversationId` | the worker's ordinary conversation |
| `adapterId`, `kind` | where it runs; `kind` for limits per kind (native workers count apart) |
| `openedBy`, `openedAt` | provenance only: the conversation (or `consumer`) where the work started |
| `about` | short free text written by the agent ("debugging the 403 on /path"); updatable on any send |
| `lastConversation`, `lastSender`, `lastSenderPolicy`, `lastInstructedAt` | where and by whom it was last instructed: the conversation that gave the running work |
| `residency` | `live` or `evicted` |
| `activity` | `idle`, `busy`, `awaiting_permission`, `failed`, `interrupted` |
| `currentPrompt` | start of the running prompt's text, started at |
| `lastUsedAt` | LRU eviction |
| `unreadReply` | a reply whose target conversation is gone |
| `droppedAt` | soft delete until the conversation and provider session are gone |

`orchestrator_permission_requests`: id, handle, the neutral request, target conversation, status, deadline.

## Worker states

```
residency:  live ⇄ evicted                  slots; only an idle worker is evicted
activity:   idle → busy → idle              a prompt, then its turn ends
                   busy → awaiting_permission → busy
                   busy → failed | interrupted        idle again on the next send
dropped:    terminal; from any state (stops first if busy)
```

Only `live` counts against slots.

## Policy limits

The policy is the harness's; the orchestrator receives the `delegation` part of the calling turn's policy:

```ts
interface DelegationPolicy {
  use: boolean;          // may open workers and send to them
  scope: "none" | "all"; // which workers it sees: check, list, send
  redirect: boolean;     // may redirect a worker busy with work from another conversation; may stop and drop
}
```

- Owner and trusted presets: `use`, `scope: "all"`, `redirect: true`. Guest: `scope: "none"` (it may still be
  allowed to `use`, opening work it then can't see from other conversations), `redirect: false`.
- No per-conversation cap: the pool limit is the entity's capacity. A guest policy may add `maxOpen`.
- Workers run under a worker policy: no messaging the entity's participants, delegation off by default; if the
  consumer turns it on, a depth limit stops workers delegating without end.
- No trust hierarchy. Urgency is judgment (an agent reporting a compromised package may matter more than an owner's
  colour change); the code only says who may redirect at all.

## Busy work: warn, don't decide

`send` to a busy worker:

| Sender | Effect |
| --- | --- |
| the conversation that gave the running work (`lastConversation`) | steer, as today (`busyDelivery: "steer"`) |
| any other conversation | nothing sent; the answer is `busy` with the context: `about`, started in another conversation with whom, how long ago |
| any other conversation, with `redirect: true` and a policy that allows it | steer anyway; `lastConversation` and `lastSender` move to the sender; the previous conversation gets a `worker_redirected` inbox item |

- Queueing a prompt behind someone else's work is not offered: it suits users rarely and agent-to-agent never.
- The agent tells its user in the entity's own voice ("I'm in the middle of the 403 you asked about in our other
  chat; should I drop that and do this?"). Renderers say "another conversation with Bob", never "another agent".
- The redirected conversation's item says what the worker was redirected to, from which conversation and by whom.
  Delivery is `wake`: that conversation takes a turn and may tell its user, or say nothing.
- **No worker free** is the same answer for the whole pool: every worker with `about`, conversation, sender, elapsed.
  Taking one over is a `redirect` on it; there is no separate preemption path.

## Operations

```ts
interface Orchestrator {
  open(actor: Actor, input: { text: string; about?: string }): Promise<OpenResult>;
  send(actor: Actor, handle: string, input: { text: string; about?: string; redirect?: boolean }): Promise<SendResult>;
  check(actor: Actor, handle: string): Promise<WorkerStatus>;
  stop(actor: Actor, handle: string): Promise<void>;
  drop(actor: Actor, handle: string): Promise<void>;
  list(actor: Actor): Promise<WorkerSummary[]>;
}
type Actor =
  | { kind: "consumer" }
  | { kind: "conversation"; conversationId: string; sender: SenderRef; policy: DelegationPolicy };
type OpenResult = { status: "sent"; handle: string } | { status: "no_worker_free"; workers: WorkerSummary[] };
type SendResult =
  | { status: "sent" | "steered" }
  | { status: "busy"; worker: WorkerSummary }
  | { status: "no_worker_free"; workers: WorkerSummary[] };
```

| Operation | Checks | Effect |
| --- | --- | --- |
| `open` | `use`; depth if the actor is a worker | acquire a slot; create the worker conversation on the pool adapter; write the row; prompt without awaiting |
| `send` | `use`, `scope`; not dropped; busy rules above | acquire a slot if evicted (reload); prompt (idle) or steer (owner of the running work, or redirect) |
| `check` | `scope` | none: activity, elapsed, `about`, last conversation and sender, current plan, last tool call titles, latest message, unread reply, pending permission |
| `stop` | `scope`, `redirect` (unless it is the conversation that gave the running work) | `interrupt()` on the worker with `clearQueue` |
| `drop` | `scope`, `redirect` | stop, delete the conversation and provider session, mark dropped |
| `list` | `scope` | summaries |

`open` and `send` return at once. Awaiting the worker's `prompt()` inside a tool would hold the agent's turn open for
the whole job. Records store facts at the primitive level ("conversation X sent this to worker w1"), never tool calls
with arguments, so harness tools can be renamed or merged without touching stored data.

**The consumer API** is the same operations with `actor: consumer`, which bypasses policy: `agent.workers.list()`,
`check(id)`, `stop(id)`, `delete(id)`. This is what makes delegated work stoppable through the product (agents-core:
"a looping Agent must be stoppable through the product"). Whether end users see workers is the consumer's decision.

## Slots and scheduling

- `workers.limit` counts live workers; optional limits per kind; native workers count apart (API calls, no process).
- An `open`, or a `send` to an evicted worker, acquires a slot. Full pool: evict the least recently used idle worker
  (stopped, handle kept, reloaded on the next send, losing the provider cache). None idle: `no_worker_free`.
- Eviction only under pressure in v1; no idle timer.
- Pool operations (acquire, evict, drop) run one at a time per `Agent`, so two conversations can't race for the last
  slot. Prompts to one worker are serialized by that worker conversation's own queue.
- Reload cost depends on the adapter: where it can load a session, context is kept and only the cache is lost;
  otherwise context is rebuilt from the transcript.
- No wait queue and no retries by the orchestrator.

## Prompting a worker

Through the worker conversation's ordinary `prompt` (`src/agent-session.ts`), with:

- `participantId` set to the sending conversation's sender, so the worker's records say who instructed it;
- `delivery: "steer"` when steering, otherwise a plain prompt on an idle worker;
- `handlers.onPermissionRequest` set to the orchestrator's forwarding handler (below);
- the result awaited in the background, never in the caller.

The worker sees none of the agent's conversation: decisions agreed with the user reach it only if the agent writes
them into the prompt. The library never attaches transcripts.

## The way back

```ts
interface DeliveryPort {
  deliver(to: ConversationId, item: InboxItemInput): Promise<"delivered" | "target_gone">;
}
```

| When | Item | To |
| --- | --- | --- |
| a worker's turn ends normally | `worker_reply`: its final message | `lastConversation` |
| a turn fails (stalled, crashed, error) | `worker_failed` with the error kind | `lastConversation` |
| a forwarded permission needs an answer (Ask the agent) | `permission_request` with the options | the target (below) |
| another conversation redirects the worker | `worker_redirected` | the previous `lastConversation` |
| restart finds a worker that was busy | `worker_interrupted` | `lastConversation` |

- A stop asked by the conversation itself produces no item: the tool result said "stopped".
- Several items arriving together are taken in one turn: the harness drains what waits at each model call.
- Pull stays available: `check` and `list`. Worker report tools (asking without ending the turn) come with the MCP
  extension. What a reply contains is tuned by the test run; v1 sends the final message.
- **Target gone:** the reply stays on the row as `unreadReply` and shows on `check` and `list`.
- The port's implementation is the inbox (`11-11-SPEC-native-harness-integration.md`): persisted first, then pushed.
  For an ACP conversation (later, with MCP) it becomes an out-of-band message delivered with the next prompt.

## Permissions

One system for the harness's tools, the consumer's tools and forwarded worker requests:

| Level | Who decides |
| --- | --- |
| Deny | refused without asking |
| Ask me | the human in the conversation |
| Ask the agent | the agent, on the user's behalf (worker requests only) |
| Allow | approved without asking |

The forwarding handler, passed per prompt as `handlers.onPermissionRequest(request, signal)` (today
`src/agent-session.ts:3536`):

1. resolves the level from the policy of the turn that gave the running work (`lastSenderPolicy`);
2. deny or allow: answer at once;
3. ask me: write a pending request and raise it as a `permission_requested` event on `lastConversation` (marked
   with the worker), or, when that conversation can't approve (a guest), on a consumer-chosen conversation; the
   answer comes through that conversation's `answerPermission` (`11-11-SPEC-native-harness-integration.md`,
   Permissions); ask the agent: deliver a `permission_request` inbox item to `lastConversation`, answered by the
   agent with a tool; mark the worker `awaiting_permission`;
4. wait for the answer, the deadline (refusal) or the abort signal (cancelled);
5. return the outcome; the worker's harness continues.

- **Ask the agent:** the agent answers with a tool, picking one of the worker's options; where Ask me is also possible
  it can pass the request up. Never the default: the default is Ask me, or Deny where no human can answer.
- **Allow always outlives the request** (the worker's harness keeps it for later work from others), so it is stripped
  from what non-owner conversations are offered.
- **Today's default refuses everything** (`defaultPermission` defaults to `"cancel"`, `src/agent-session.ts:625`), so
  forwarding is needed before workers can do real work.
- Approve by exact tool or command, never by substring.
- The request shape is made neutral by the controller-interface work (`11-11-SPEC-controller-interface.md`, Records).

## Events

`worker_opened`, `worker_busy`, `worker_idle`, `worker_replied`, `worker_failed`, `worker_redirected`,
`worker_permission_requested`, `worker_permission_resolved`, `worker_evicted`, `worker_reloaded`, `worker_dropped`.
Each carries the handle, the conversation id, `openedBy` and `lastConversation`. Facts, never user-facing text.

## Failure modes and restart

| Case | Behaviour |
| --- | --- |
| The worker process crashes mid-turn | existing crash handling ends the turn with an error; `failed`; `worker_failed` item |
| The worker stalls | the stale supervisor cancels, then force-stops; `failed`; item |
| A reload fails (session gone, adapter missing) | `send` returns an error the tool turns into a fixable message; `failed` |
| A permission request goes unanswered | refused at the deadline; `worker_permission_resolved` with `timeout` |
| The agent conversation's turn is interrupted | workers keep running; stop on an agent conversation stops only its own turn |
| The agent conversation is deleted | workers stay (they are the entity's); replies become `unreadReply`; retention cleans up |
| The `Agent` closes | `stopAll` stops live workers; busy ones come back `interrupted` |
| Restart | rows read back, none live; busy ones marked `interrupted` with an item each; pending permissions refused |

## Configuration

```ts
new Agent({
  // ...
  orchestrator: {
    workers: { adapterId: "codex", cwd: "/work", limit: 2 },  // the pool adapter, else the Agent's default
    retention: { idleDays: 30 },                              // off by default
  },
});
```

- Workers are ordinary conversations, so they keep the adapter, the launcher (`src/launcher.ts`) and `cwd` exactly as
  today. A consumer running each agent in its own container gives the pool a launcher that targets it.
- ACP harnesses send filesystem and terminal requests back to the client (`src/client.ts`, `src/terminals.ts`);
  workers inherit that behaviour unchanged.
- The agent never chooses adapters or paths. Later: consumer-defined worker kinds ("coder" on Codex, "reviewer" on
  Claude) and named workspaces the agent may pick by name.

## Accepted risk: workers sharing a workspace

The agent is not a coding harness, so the pool isn't tied to git or worktrees. `about`, `check` and the busy answer
show what each worker does, so the agent can avoid overlap; the consumer can configure one workspace per worker
kind.

## Code plan

```
src/orchestrator/
  contracts.ts      Orchestrator, Actor, DelegationPolicy, DeliveryPort, results, statuses, events
  orchestrator.ts   the operations: checks first, then pool and workers
  pool.ts           slots, serialization, LRU eviction, limits per kind
  workers.ts        prompting a worker (participantId, steer, handlers), reading status from its state and records
  busy.ts           the busy rules: owner of the running work, redirect, the busy answer
  permissions.ts    the forwarding handler, levels, deadlines, answer routing
  delivery.ts       turn ends → reply, failure, redirected and interrupted items
  persistence.ts    the persistence extension: tables, migrations, queries
  restart.ts        rebuild on start
  consumer-api.ts   agent.workers.*
  index.ts
```

- **Touches existing code in three places only:** `src/agent.ts` (construct when configured, expose
  `agent.workers`); `src/agent/config.ts` (the `orchestrator` option); `src/index.ts` (exports). The conversation
  manager is used through its public methods; `agent-session.ts` is not edited.
- Each file under ~400 lines; the module under ~2,000.
- Tests: `test/orchestrator/` with a fake worker conversation (scripted turn ends, permission requests, crashes) and
  an in-memory or temp-file SQLite.

## Steps

1. The runtime handle for persistence extensions; the orchestrator's extension and rows; `open`, `send` (idle), `check`, `list` over fake workers; slots and LRU eviction;
   consumer API and events.
2. Busy rules: steer from the owner of the running work, `busy` answer, `redirect` with the redirected item.
3. Policy checks (`use`, `scope`, `redirect`) and the worker depth limit.
4. Delivery port and the way back (reply, failure, interrupted), with a test delivery port.
5. Permission forwarding: levels, deadline, stripping allow-always.
6. `stop`, `drop`, restart rebuild, retention.
7. One run with real throwaway ACP workers on a cheap model: a reply reaches the delegating conversation, a forwarded
   permission is answered, a redirect is reported. Sessions deleted afterwards.

## Acceptance

- The fake-worker suite covers slots, eviction and reload, `no_worker_free` with the listing, busy and redirect,
  policy refusals, restart with a busy worker, forwarded permissions at each level and on timeout. No provider key.
- A consumer lists and stops every worker.
- No edit to `src/agent-session.ts`.

## Open

- [ ] The default target for an Ask me request that the conversation which gave the work can't answer.
- [ ] Whether only the pool may wake a worker (recommended), or the consumer may prompt one directly.
- [ ] Eviction preferring adapters that reload cheaply.
- [ ] Linking worker usage to the conversation that gave the work, for cost roll-up.
- [ ] Whether the redirected item always wakes, or wakes only when the previous work came from a human.
- [ ] Measurement: does reloading a harness session keep cache reads (Codex, Claude, OpenCode; throwaway sessions).
