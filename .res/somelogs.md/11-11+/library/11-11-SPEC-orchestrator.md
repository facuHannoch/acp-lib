# Orchestrator and worker pool

Status: agreed, not started. Written 2026-11-11; grounded in code 2026-11-12; review 1 and implementation plan
2026-11-13; revised 2026-11-21 against the built harness and integration; review 2 on 2026-11-22, with the harness's
decisions 0021–0025 as context (Decided in review 2, at the end): **the orchestrator stands; only its route
to the harness changed** (Delegation as registered tools, below). Starts after the integration's briefs R2 and
R3 (the permission matcher and permission events) and after two harness proposals are accepted and built: the
callback policy amendment (`policyNames` on `functions/call`) and external notices (`channel/notify`); its route uses
the harness's consumer-registered tools (`../../../../src/native-harness/.res/docs/tools-and-callbacks/0001-DESIGN/`,
built). Its core is tested
through the consumer API with workers on the offline fixture agents, with no harness and no provider key.

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
- speak to users (it records facts, never lines such as "Delegated · running");
- know about the harness: the harness reaches it only through tools acp-client registers with it, which call back
  into acp-client, and hears from it only through what is pushed onto its channels.

**Delegation as registered tools** (2026-11-21). The harness has no delegation subsystem, by design: it lets a
consumer register tools and set the system prompt, and then behaves as if it could delegate. So acp-client gives the
agent its delegation capacity from outside:

- **acp-client registers `delegate`, `check`, `list` and `stop`** (names provisional) in the tool catalog it supplies
  on every `session/create` and `session/load` (`tools.catalog`, group `fixed`, the harness's decision 0021), and
  declares their handler names in `initialize` (`functions`). Definitions are never stored by the harness, so they
  are always current. **How to use workers is said in the tool descriptions,** not in a system prompt section: the
  system prompt is part of the harness's own config, fixed for an open session and the consumer's; a consumer that
  wants more puts it in its own prompt.
- **The harness runs them like any tool:** through its permission gate (a harness policy that denies them hides them
  from that channel's model), then a `functions/call` to the host with the invocation id, channel, turn, tool name
  and arguments. acp-client routes the call to the orchestrator and returns the result (`sent`, `steered`, `busy`,
  `no_worker_free`, statuses) as the tool's output.
- **The harness never knows it is delegating.** The pool, the busy rules, the way back and permission forwarding
  are all acp-client's, as below.

```
harness (the agent)                        acp-client (orchestrator + workers table)
  delegate / check / list / stop  ───────► functions/call (tools acp-client registered)
  ◄──────────────────────────────────────  replies, failures, redirected, uncertain outcomes:
                                           external notices (channel/notify) on the agent's channel
```

Nothing about workers goes into the system prompt; the tool descriptions say how to use them (Delegation as
registered tools, above).

## Where it sits

```
                       consumer (agent.workers.list / check / stop / delete)
                                         │
┌────────────────────────────── acp-client (one Agent) ──────────────────────────────┐
│   native conversations (channels)                 orchestrator                     │
│   ┌──────────┐  ┌──────────┐                      ┌─────────────────────┐          │
│   │ agc-1    │  │ agc-2    │   delegate / check   │ rules: policy,      │          │
│   │ owner    │  │ trusted  │ ───────────────────► │ busy, redirect      │          │
│   └────┬─────┘  └────┬─────┘  (registered tools,  │ pool: N slots, LRU  │          │
│        │             │        functions/call)     │ the way back        │          │
│        │             │ ◄──── items: replies, ─────┴──┬───────────────┬──┘          │
│        │             │       permission asks         │ workers table │ prompt,     │
│        ▼             ▼                               └───────────────┘ steer,      │
│   ═══ harness process (the entity) ═══                                 interrupt   │
│                                                    worker conversations ▼          │
│                                                    ┌──────┐ ┌──────┐               │
│                                                    │ w1   │ │ w2   │               │
│                                                    │Codex │ │Claude│               │
│                                                    └──────┘ └──────┘               │
└────────────────────────────────────────────────────────────────────────────────────┘
```

| It uses | For |
| --- | --- |
| The `Agent`'s conversation manager (`create`, `open`, `list`, `delete`; `src/agent/conversation-manager.ts`) and the conversation's own `stop` | creating, reloading, stopping and deleting workers; nothing new in the manager |
| An optional `workers?` persistence repository | the little it must remember (What it keeps) |
| A delivery port (an interface it defines) | the way back into agent conversations |
| The `Agent` event bus | events for the consumer |

Nothing imports the orchestrator except the `Agent` (which constructs it when `orchestrator` is configured) and
`src/native/` (which serves the registered delegation tools' `functions/call` with it). An `Agent` with no orchestrator configured
behaves as today.

**What this spec owns beyond the pool:**

- **The delegation tools.** Their registration in the per-open tool catalog, with usage guidance in their
  descriptions (no system prompt section); the `functions/call` route from
  `src/native/` to the orchestrator; building the `Actor` from the call (the channel's conversation, the sender of
  the turn's input, and the call's contributing `policyNames`); mapping results back as tool output. Delegation calls
  aren't idempotent (`delegate` opens a worker): the harness never repeats an uncertain callback, which is what they
  need.
- **The delivery port's ACP half.** For an ACP conversation, items become out-of-band messages delivered with its
  next prompt, with a kind and a sender in their metadata (`src/out-of-band-messages.ts`).
- **Not owned here: the native durable handoff.** Persisting assignments, staging results and notices, delivering
  them through `channel/notify` and recovering after a restart is a small acp-client module built by the harness's
  external notices work (its plan's Gate 3, "acp-client durable handoff"; decided 2026-11-22). The orchestrator
  uses it: it creates assignments and reports their results. **Built so far (in `alpha`, `d403bf4`, approved):** the
  `workerDelivery?` repository (`src/persistence/worker-delivery-contract.ts`, SQLite schema 18, capability
  `capabilities.workerDelivery`): assignments reserved before dispatch (idempotent by `assignmentId`, bound to the
  worker's message id through the `beforeDispatch` hook), `redirect`, `addContributingPolicies`, the final and
  failure outcomes written by the lifecycle (`recordFinal`, `recordFailure`, in the turn's terminal transaction), and
  the staged notice with its delivery states. **Still to build (Gate 3):** the host flush through `channel/notify`,
  retries after a lost acknowledgement or a resume, explicit retry after `invalid_policy`, and recovery at open
  (the uncertainty notice). O3b's native delivery and O5b's restart gate need that remainder.

## Roles

- An **agent** conversation is one run by the native harness (a channel of its session). A **worker** is an ordinary
  conversation the pool runs for the entity, on an external ACP harness (Codex, Claude, OpenCode, Grok). **No native
  workers in v1;** later, the simplest path is probably the native harness speaking ACP (with a few extensions), so it
  runs as a worker like any other harness.
- **Workers are not part of the agent's identity** (provisional, 2026-11-13). They are tools the agent uses: a
  worker's transcript is never reported to the agent's timeline, and its prompts never get the agent's identity
  preamble. What reaches the agent from a worker is what comes back as items (replies, failures), recorded on the
  agent's own conversation. Worker conversations are marked (`role: "worker"`, name provisional), so identity
  reporting, preparing and member registration skip them, and consumers can tell them apart in
  `agent.conversations.list()`.
- **Workers belong to the entity, not to a conversation.** Two conversations with the same agent are the same agent
  talking twice, so every conversation of the entity sees and can use every worker unless its policy says otherwise.
- **The agent owns the conversation and the decisions taken with the user; the worker owns the execution.** Nobody
  steers the worker step by step.
- **No task model.** The only soft structure is a short description the agent writes (`about`).

## What it keeps

Everything about a worker's progress is already in the worker's own conversation (its state, operation, messages,
tool calls, records); `check` and `list` read it from there. The orchestrator stores only what nobody else knows and
what must survive a restart, in an optional `workers?` repository with a `capabilities.workers` flag (the same
pattern as `identity?` and the integration spec's `channels?`; SQLite implements it, schema version 19, after worker delivery's 18; a custom
backend without it, or without `workerDelivery?`, can't enable the orchestrator: creating the `Agent` fails with a clear
error):

```
workers
  handle             "w1": the name the agent uses; unique per Agent
  conversation_id    the worker's ordinary conversation
  opened_by          the conversation (or "consumer") where the work started
  about              the agent's short description; updated on any send that gives one
  last_conversation  the conversation that gave its latest work: only the default destination of its next
                     assignment; delivery reads the assignment's own destination, which redirect retargets
  created_at, dropped_at
```

**Assignments** (one piece of work on a worker) are persisted by the durable handoff module, not in this table: each
assignment's id, its link to the worker and the worker operation, its destination and its originating policy names,
written before dispatch; then its result and staged notice, written together (The way back). **The assignment id is
the `delegate` or `send` call's invocation id** (`<turnId>:<toolCallId>`, decision 0021): stable and unique, and the
harness never repeats an uncertain callback. A steer from the same conversation joins the running assignment and
adds its policy names; a redirect retargets it to the redirecting conversation, with that conversation's names
added; it ends when the worker's turn ends. In memory only: which slot a worker holds, the resolved worker rules of
the running assignment, pending permission requests (refused on restart). Busy or idle is read from the worker
conversation's state. No `agent_action` records in v1: the events and the `workers` row say what happened.

## Policy limits

The harness's policies are a `fallback` plus exact tool names (its decision 0016), with no delegation part. So the
delegation rules live in **acp-client's orchestrator config, keyed by harness policy name** (owner, trusted, guest,
…); `use` can also be enforced in the harness by denying the delegation tools in a policy, which hides them. The
harness supplies the names that contributed to each call (`functions/call`'s `policyNames`, the
[callback policy amendment](../../../../src/native-harness/.res/docs/tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md)). The shape:

```ts
interface DelegationPolicy {
  use: boolean;          // may open workers and send to them
  scope: "none" | "all"; // which workers it sees: check, list, send
  redirect: boolean;     // may redirect work given from another conversation; may stop and drop
  maxOpen?: number;      // optional cap, for guest-like policies
}
type WorkerPermissions = { default: Level; rules: Record<string, Level> };   // the policy's `worker:` rules
```

acp-client binds this worker-rule mapping to the harness's active policy configuration when it opens the session.
For a native callback, the orchestrator looks up each of the call's `policyNames` and applies the **most
restrictive** applicable rules (the `worker:` rules matched by acp-client's permission matcher, integration
brief R2). An empty list selects the orchestrator's configured defaults, which another harness integration can also
select by explicitly saying it has no policy context. A missing field on a native callback, or an unknown name,
declines the delegation operation. The resolved rules are kept with the assignment and applied to that worker's
later permission requests. Example: a turn that took an owner's message and a guest's notice carries both names, so
it can send work to an idle worker if both allow it, but guest restrictions prevent taking over a busy one.

- Owner and trusted presets: `use`, `scope: "all"`, `redirect: true`. Guest: `scope: "none"`, `redirect: false`.
- No per-conversation cap by default: the pool limit is the entity's capacity.
- No trust hierarchy. Urgency is judgment; code only says who may redirect at all.

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
  | { kind: "conversation"; conversationId: string; sender: SenderRef; invocationId: string;
      policy: DelegationPolicy; workerPermissions: WorkerPermissions };  // composed from the call's policyNames
type OpenResult = { status: "sent"; handle: string } | { status: "no_worker_free"; workers: WorkerSummary[] };
type SendResult =
  | { status: "sent" | "steered" }
  | { status: "busy"; worker: WorkerSummary }
  | { status: "no_worker_free"; workers: WorkerSummary[] };
```

`open` and `send` return at once; awaiting the worker's turn inside a tool would hold the agent's turn open for the
whole job. The consumer API is the same operations with `actor: consumer`, which bypasses policy:
`agent.workers.list()`, `check(id)`, `stop(id)`, `delete(id)`. This is what makes delegated work stoppable through the
product.

## Flow 1: opening a worker

```
owner (agc-1): "The /login page returns 403, fix it"
  agent (harness, agc-1) ── delegate(text, about: "403 on /login") ──► acp-client callback
  orchestrator:
    1. the turn's policy: may delegate?                  yes (owner)
    2. a slot free?                                      yes, or evict the least recently used idle worker
    3. create a worker conversation (pool adapter, cwd)  w1
    4. row: handle w1, opened_by agc-1, about, last_conversation agc-1;
       assignment (id = the call's invocation id, destination agc-1, policy names) persisted before dispatch
    5. prompt w1 with the text, sender = the owner (not awaited)
  ◄── { status: "sent", handle: "w1" }
  agent (agc-1): "On it."                                turn ends
```

## Flow 2: sending to a worker

```
send(w1, text) from conversation X:

  w1 idle ─────────────────────────────────────────► prompt it             → "sent"
  w1 busy, X gave its running work ────────────────► steer into it         → "steered"
  w1 busy, other work, no redirect ────────────────► nothing sent          → "busy" + about, where, for whom, how long
  w1 busy, other work, redirect: true ─────────────► policy allows?
                                                       yes → steer; assignment destination and last_conversation = X;
                                                             the previous conversation gets "w1 was redirected"
                                                       no  → refused
  w1 evicted ──────────────────────────────────────► take a slot, reload, then as above
```

- Queueing behind another conversation's work is not offered: it suits users rarely and agent-to-agent never.
- The agent turns "busy" into words for its user ("I'm in the middle of something you asked in our other chat; should
  I drop it?"). Renderers say "another conversation with Bob", never "another agent".
- **No worker free** lists every worker with its `about`, conversation, sender and elapsed time. Taking one over is a
  `redirect` on it; there is no separate preemption path.

## Flow 3: the way back

```
w1 (Codex) ends its turn: "Fixed, cookie domain was wrong, tests pass"
  orchestrator: reads w1's final message
  delivery port → the result recorded and an external notice "w1 finished: …" staged, then channel/notify to agc-1
  harness: keeps it in the channel's inbox (its own store), takes a turn, reads it, writes its own answer
  acp-client: records that turn on agc-1 and emits it → consumer → the owner sees the agent's answer
```

The user never sees the worker's text directly; the agent reads it and decides what to say.

| When | Item | To |
| --- | --- | --- |
| a worker's turn ends normally | `worker_reply`: its final message | the assignment's destination |
| a turn fails (stalled, crashed, error) | `worker_failed` with the error kind | the assignment's destination |
| another conversation redirects the worker | `worker_redirected` | the assignment's previous destination |
| restart finds an assignment with no reliable final record | an uncertainty notice: the assignment and worker, outcome uncertain; the work isn't repeated | its destination |

- **The port:** for a native conversation it delivers the result through `channel/notify`, as an external notice
  with a stable id, the text, a source label (the worker's handle) and the assignment's policy names; the harness
  commits it to the channel's inbox before acknowledging and deduplicates retries by id. For an ACP conversation
  (later, with MCP) it is an out-of-band message delivered with the next prompt.
- **Durable native completion** follows the harness's rules ([external notices spec](../../../../src/native-harness/.res/docs/channel-messaging/0001-DESIGN-external-notices/SPEC.md), Durable worker
  handoff; decision 0025), built by the durable handoff module:
  - the recovery source is the worker conversation's **committed final record** in the `Agent` database; after a
    restart, acp-client finds it through the persisted assignment and stages the notice, without redispatching;
  - if acp-client died before that record committed, the outcome is uncertain: an uncertainty notice is staged,
    never a repeat of the work;
  - a redirect committed before staging decides the destination; a notice already staged keeps its payload;
  - delivery: a suspension or an unresolved channel change keeps the notice pending; `invalid_policy` blocks it until
    an explicit retry; a missing or retired destination fails it, the result kept for `check` and `list`; a duplicate
    receipt counts as delivered.
- A stop asked by the conversation itself produces no item: the tool result said "stopped".
- Several items arriving together are taken in one turn: the harness drains what waits at each model call.
- Pull stays available: `check` and `list`. What a reply contains is tuned by the test run; v1 sends the final message.
- **Target gone:** the reply is kept on the worker and shows on `check` and `list`.

## Flow 4: a worker asks permission

```
w1 wants to run `bun test` → ACP request_permission → acp-client
  the orchestrator's handler (passed per prompt as handlers.onPermissionRequest):
    level from the WorkerPermissions of whoever gave the running work (rules by tool or command)
      deny / allow ──────► answered at once
      ask me ────────────► permission_requested event on agc-1 (marked "from w1");
                           the consumer shows it; agc-1.answerPermission(id, option)
    no answer before the deadline → refused
  w1 continues
```

- **When the conversation that gave the work doesn't answer permissions** (`answersPermissions: false`, for example
  one driven by an API integration with no human watching), an ask is refused at once, whatever its default says
  (decided in integration R3: an ask nobody can answer is never loosened to the default). No routing to another conversation; a headless
  conversation gets worker approvals through rules instead (the policy allows the specific commands). The levels are
  allow, deny and ask me; "ask the agent" (the agent approving its own worker) is not in v1 (Limitations).
- **Forwarded requests use the conversation's own events:** `permission_requested` on the giving conversation, marked
  with the worker, answered with its `answerPermission`, closed by `permission_resolved`. No separate worker
  permission events.
- **Allow always outlives the request** (the worker's harness keeps it for later work from others), so it is stripped
  from the options shown when a non-owner conversation is *asked*. Automatic allow (the level is allow) follows the
  auto-approve rule, `allow_once` else `allow_always` (`rules/11-13-RULES-permission-auto-approve.md`). Guests can't
  delegate at all (`scope: "none"`), so this concerns trusted conversations.
- **Today's default refuses everything** (`defaultPermission` defaults to `"cancel"`, `src/agent-session.ts:625`), so
  forwarding is needed before workers can do real work.
- Approve by exact tool or command, never by substring. The request shape is made neutral by the controller-interface
  work.

## Flow 5: stop, drop, eviction

- **`stop(w1)`** interrupts its turn (`interrupt()` with `clearQueue`); allowed for the conversation that gave the
  running work, or a policy with `redirect`.
- **`drop(w1)`** stops it, deletes its conversation and provider session, and marks the row dropped.
- **Idle stop:** a worker idle for `workers.idleStopMs` (default 10 minutes; `false` turns it off) has its process
  stopped, so a worker that isn't working holds no connection. Its handle, conversation and row stay; the next send
  reloads it, as after eviction. A reload may lose the provider's cache, so the next message to it costs a little
  more.
- **Eviction:** when all N slots are taken and one is needed, the least recently used idle worker is stopped. Its
  handle stays valid; the next send reloads it (for an ACP worker, `session/load` where the adapter supports it,
  losing only the provider cache; otherwise context is rebuilt from the transcript).
- **Deletion** only explicitly: `drop` by the agent, or `agent.workers.delete(id)` by the consumer. No retention rule
  in v1.

## Flow 6: restart

```
acp-client starts
  orchestrator: reads the workers table (not dropped)
  durable handoff: for each assignment not staged, the worker conversation's committed final record
                → result recorded and notice staged; no reliable final record → an uncertainty notice staged
                staged notices retried after the open's earlier channel changes
  none are live; the next send reloads them
  pending permission requests: gone (refused)
```

## Slots and scheduling

- `workers.limit` counts live workers (those with a running process). No limits per kind in v1: there are no
  worker kinds.
- Pool operations (acquire, evict, drop) run one at a time per `Agent`, so two conversations can't race for the last
  slot. Prompts to one worker are serialized by that worker conversation's own queue.
- **Only the pool prompts workers,** so the slot count holds; the consumer can read and stop them.
- No wait queue and no retries by the orchestrator.

## Events

`worker_opened`, `worker_busy`, `worker_idle`, `worker_replied`, `worker_failed`, `worker_redirected`,
`worker_stopped` (idle stop or eviction, with which), `worker_reloaded`, `worker_dropped`. Each carries the handle,
the conversation id, `opened_by` and `last_conversation`. Facts, never user-facing text. Permission requests use the
giving conversation's own `permission_requested` and `permission_resolved` (Flow 4).

## Configuration

```ts
new Agent({
  // ...
  orchestrator: {
    workers: { adapterId: "codex", cwd: "/work", limit: 2, idleStopMs: 600_000 },  // the pool adapter, else the
                                                              // Agent's default (an ACP adapter); idle stop 10 min
  },
});
```

- Workers are ordinary conversations, so they keep the adapter, the launcher (`src/launcher.ts`) and `cwd` exactly as
  today. A consumer running each agent in its own container gives the pool a launcher that targets it.
- ACP harnesses send filesystem and terminal requests back to the client (`src/client.ts`, `src/terminals.ts`);
  workers inherit that unchanged.
- The agent never chooses adapters or paths. Later: consumer-defined worker kinds and named workspaces the agent may
  pick by name.

## Accepted risk: workers sharing a workspace

The agent is not a coding harness, so the pool isn't tied to git or worktrees. `about`, `check` and the busy answer
show what each worker does, so the agent can avoid overlap; the consumer can configure one workspace per worker kind.

## Code plan

```
src/orchestrator/
  contracts.ts      Orchestrator, Actor, DelegationPolicy, DeliveryPort, results, statuses, events
  orchestrator.ts   the operations: checks first, then pool and workers
  pool.ts           slots, serialization, LRU eviction
  workers.ts        prompting a worker (sender, steer, permission handler), reading status from its conversation
  busy.ts           the busy rules: who gave the running work, redirect, the busy answer
  permissions.ts    the forwarding handler, levels, deadlines, routing to the right conversation
  delivery.ts       turn ends → results and notices through the durable handoff module; ACP out-of-band items
  restart.ts        rebuild on start
  consumer-api.ts   agent.workers.*
  index.ts
src/persistence/    the optional workers? repository (WorkerPersistence) with capabilities.workers; SQLite schema 19 (worker delivery took 18)
```

- **Touches existing code:** `src/agent.ts` (construct when configured, expose `agent.workers`); `src/agent/config.ts`
  (the `orchestrator` option); `src/persistence/` (one optional repository, like the others); the worker marker on
  conversations, and identity skipping marked conversations (`src/agent/persisted-lifecycle.ts`,
  `src/agent/record-capture.ts`); `src/index.ts` (exports). The conversation manager is used through its public methods; `agent-session.ts` is not edited.
- Each file under ~400 lines; the module under ~2,000.
- Tests: `test/orchestrator/` with workers on the offline fixture ACP agents (turn ends, permission requests, stalls) and a
  temp-file SQLite.

## Implementation plan

Written 2026-11-13; revised in review 2 (2026-11-22). Nine briefs (O3 and O5 each split in two), each about one agent run, run in order by one trio
(`../.plan-execution/plan.md`; its code-quality and triage rules apply).

**Dependencies.** Starts after the integration's briefs R1–R3: it uses the turn-based controller interface, the
permission events and `answerPermission` (R3), the permission matcher with `worker:` rules (R2), and the
optional-repository pattern (`channels?`, R1). **Also blocked on two harness proposals,** accepted and built: the
[callback policy amendment](../../../../src/native-harness/.res/docs/tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md) (`policyNames` on `functions/call`, used by O6's route) and
[external notices](../../../../src/native-harness/.res/docs/channel-messaging/0001-DESIGN-external-notices/SPEC.md) (`channel/notify`, and its Gate 3's durable handoff module, used by O3b and O5b). O1–O5a need no harness: workers are
ordinary conversations on the existing offline fixture ACP agents (`test/fixtures/`: `steer-agent`,
`permission-agent`, `stalling-prompt-agent`, …), so they are tested as real conversations, not fakes. O6 needs the harness's
consumer-registered tools (`functions/call`) for its route.

**Common to every brief.** Clean-copy gates (`bun run typecheck`, full `bun test`, output saved); the integration
spec's final gate is the baseline; no edit to `src/agent-session.ts`; no live harness runs except O6's step 3, with
the owner's authorization.

**Order** (revised 2026-11-22, with worker delivery in `alpha`): G, O1, O2, **O4**, O3a, O5a, O3b, O5b, O6. Gate 3's
host side (the flush through `channel/notify`, retries, recovery at open) is built by the harness work in parallel;
everything through O5a needs none of it, and only O3b, O5b and O6 wait for it. O4 comes before the way back because it
needs no harness and its forwarding entry is the one change to integration R3's code (reviewed on its own).

### The code as it is (for these briefs)

Read on `beta` 2026-11-13; line numbers move once the controller-interface and integration work land.

- **Conversation manager** (`src/agent/conversation-manager.ts`): `create` (147), `open` (383), `list` (581),
  `delete` (617), `appendAssistantMessage` (673). Stop is the conversation's own.
- **Interrupt:** `interrupt({ clearQueue })` on the conversation (`src/agent-client.ts:15`, `:52`).
- **Events:** `agent.events`, an `AgentEventBus` (`src/agent.ts:105`).
- **Identity calls:** `agent.identity.load` before each prompt (`src/agent/persisted-lifecycle.ts:96`) and
  `agent.identity.update` after each committed batch (`src/agent/record-capture.ts:44`): where worker conversations are
  skipped.
- **Out-of-band messages:** `src/out-of-band-messages.ts` (`pendingOutOfBandMessages`, `composeProviderParts`):
  the ACP half of delivery.
- **Record kinds** (`src/persistence/records.ts:507`): `header`, `operation`, `reasoning`, `activity`,
  `configuration`, `permission`, `transition`, `metering_reference`, `lifecycle`, `cancellation`. The canonical Agent
  kinds in `src/persistence/backend.ts` also include `agent_action` (`AgentActionRecord`); v1 emits no delegation
  records (decided in review 2).
- **Persistence:** optional repositories with capability flags (`src/persistence/backend.ts`), as `channels?`.

### Brief G: grounding

The implementer checks The code as it is and every reuse point in the briefs against the code after integration R1–R3
(the permission events, the matcher's `worker:` prefix, the `channels?` pattern) and worker delivery (the
`workerDelivery?` repository and the lifecycle's `recordFinal` and `recordFailure`, in `alpha`), checks that
`policyNames` on `functions/call` and `channel/notify` are built as their harness specs say, and reports what moved or
doesn't exist (`library/reports/<date>-REPORT-OG.md`). It also writes **the interface with Gate 3's remainder**: the
calls the orchestrator makes (reserve before dispatch, report the result or failure, redirect, add policies) and the
ones it expects from the host side (flush through `channel/notify`, retries, recovery at open), so both sides build
to the same contract; and sizes **O4's forwarding entry** on the conversation's permission handling (R3 emits
events only for a conversation's own turns). Corrections go to the spec owner before O1.

### Brief O1: the pool and the workers table

**Scope:** steps 1–4.

1. **The `workers?` repository** with `capabilities.workers`, its SQLite implementation (schema 19, upgrade from 18,
   tested on a version-18 database and on the chain from 16); the orchestrator refused at `Agent` construction on a
   backend without `capabilities.workers` **or `capabilities.workerDelivery`**, and on an `Agent` whose message
   capture isn't `content` (a worker's final text must be recoverable for its result). It holds the workers rows;
   assignments, results and staged notices are `workerDelivery?`'s. **Gate:** suite green; the upgrade tests; the
   refusal for each missing capability and for a lower capture setting.
2. **The worker marker:** worker conversations created with `role: "worker"`; identity `load`, `update` and member
   registration skip them; `agent.conversations.list()` shows the role. **Gate:** a worker's records never reach the
   identity runtime; its prompts get no preamble.
3. **`open`, `send` (to an idle worker), `check`, `list`** over workers on fixture agents; slots (`workers.limit`),
   pool operations one at a time per `Agent`, LRU eviction of idle workers, reload on the next send; `no_worker_free`
   with the listing. **Gate:** tests for each, including two opens racing for the last slot.
4. **The consumer API** (`agent.workers.list`, `check`, `stop`, `delete`) and the events. **Gate:** a consumer lists
   and stops every worker.

**Done:** report commits, the schema change, each operation and its test.
**Risks:** a worker reaching the identity (sign: a worker's text in a preamble); the gate is the guard.

### Brief O2: busy rules and policy

**Scope:** steps 1–2.

1. **Busy rules:** steer when the same conversation gave the running work; `busy` with the listing otherwise;
   `redirect: true` steers, retargets the running assignment (`redirect`), moves `last_conversation`, and pushes `worker_redirected` to the previous one. **Gate:**
   each case, with two conversations on one worker.
2. **Policy checks:** `use`, `scope`, `redirect` (also gating stop by others and drop), `maxOpen`. **Gate:** a
   refusal for each.

**Done:** report commits and each case.

### Brief O4: permission forwarding

**Scope:** steps 1–2.

1. **The handler** passed with each prompt to a worker: the level from the giving conversation's `worker:` rules
   (integration R2's matcher); allow and deny answered at once; ask me as `permission_requested` on the giving
   conversation, marked with the worker (`permission_requested` gains a `source` mark, and `turnId` is optional for a
   forwarded request), through a forwarding entry on the conversation's permission handling that O4
   adds (R3 emits events only for a conversation's own turns, so this is a small extension of it: a pending request
   with a source mark and a resolver that answers the worker's request); a giving conversation that doesn't answer
   permissions has the ask refused at once. **Gate:** each level; the timeout; a headless giving conversation.
2. **Allow always:** stripped from the options shown when a non-owner conversation is asked; automatic allow follows
   the auto-approve rule. **Gate:** both.

**Done:** report commits and each case.

### Brief O3a: the way back, assignments and the ACP half

**Scope:** steps 1–3. Needs no Gate 3 remainder.

1. **Assignments:** each delegated `delegate` or `send` reserves its assignment (id = the call's invocation id) in
   `workerDelivery?` before dispatch, through the `beforeDispatch` hook, with the destination and the call's
   contributing `policyNames`; a steer joins the running assignment (`addContributingPolicies`) and a redirect
   retargets it (`redirect`). **Gate:** an assignment exists before the worker's prompt reaches the provider; a steer
   and a redirect each change it; a refused hook sends nothing.
2. **The delivery port's ACP half** (`src/orchestrator/contracts.ts`): out-of-band messages with a kind and a sender
   in their metadata, delivered with the next prompt. **Gate:** an item reaches an ACP conversation.
3. **Items:** `worker_reply` (the final message) on a normal turn end, `worker_failed` with the error kind, to
   the assignment's destination; a stop asked by the conversation itself produces none; a gone target keeps the reply on the
   worker (`check`, `list`). **Gate:** each item; a deleted target.

**Done:** report commits and each item.

### Brief O5a: stop, drop, idle stop

**Scope:** steps 1–2. Needs no Gate 3 remainder.

1. **`stop`** (`interrupt({ clearQueue })`, allowed for the giver or with `redirect`) and **`drop`** (stop, delete the
   conversation and provider session, mark the row dropped). **Gate:** each, and a refusal.
2. **Idle stop:** `workers.idleStopMs` (default 10 minutes, `false` off); the next send reloads; `worker_stopped` with
   the reason. **Gate:** a worker idle past the limit has no process and reloads on the next send.

**Done:** report commits and each case.

### Brief O3b: the way back, native delivery

**Scope:** steps 1–2. After Gate 3's host side lands (the flush, retries and recovery at open).

1. **Native delivery through the durable handoff:** a native conversation's result reaches its channel as one notice
   (`channel/notify`, stable id, source label, the assignment's composed policies frozen at staging), delivered by the
   host side from the staged notice. **Gate:** a result reaches a native channel as one notice; a steer's policies
   are in it; a redirect retargets it, whichever order it meets staging.
2. **Outcomes:** `pending`, blocked on `invalid_policy` (explicit retry after the policy is fixed), failed for a
   missing or retired channel, the result kept for `check` and `list`. **Gate:** each.

**Done:** report commits and each case.

### Brief O5b: restart

**Scope:** one step. After Gate 3's host side lands.

1. **Restart:** workers read from the repository; the durable handoff's recovery run at open; pending permission
   requests refused. **Gate:** the harness plan's two crash cases through the orchestrator: acp-client killed after a
   worker's final record commits but before staging (the result recovered by assignment id, nothing redispatched),
   and killed before the final record commits (one uncertainty notice); a staged notice not yet accepted, delivered
   once.

**Done:** report commits and each case.

### Brief O6: the delegation route, end to end

**Scope:** steps 1–3.

1. **The route:** the delegation tools registered in the per-open tool catalog (guidance in their descriptions); `functions/call` from
   the harness routed to the orchestrator, the `Actor` built from the call, its `policyNames` resolved to the
   session's worker rules (most restrictive; empty list → defaults; missing or unknown → declined); results returned
   as tool output. **Gate:** with the in-process harness, including a two-policy turn.
2. **Against `serve --stdio`** (the harness's consumer-registered tools, scripted model): delegate, a reply reaching
   the agent's channel, a forwarded permission, a redirect. **Gate:** each.
3. **One live run,** with the owner's authorization: real throwaway ACP workers on a cheap model; a reply reaches the
   delegating conversation, a forwarded permission is answered, a redirect is reported; sessions deleted afterwards.
   **Gate:** the run's evidence in the report.

**Done:** report commits, the end-to-end evidence.

## Acceptance

- The suite (workers on the offline fixture agents) covers slots, eviction and reload, `no_worker_free` with the listing, busy and redirect,
  policy refusals, restart with a busy worker, forwarded permissions at each level and on timeout. No provider key.
- A consumer lists and stops every worker.
- No edit to `src/agent-session.ts`.

## Limitations

- **No native workers in v1** (Roles).
- **No "ask the agent" level for worker permissions in v1:** the agent can't approve its own worker's requests
  (no answering tool, and the harness's policies have no such level). Allow, deny and ask me only.
- **An uncertain outcome is reported, not resolved:** if acp-client dies before a worker's final record commits, the
  agent gets an uncertainty notice and decides; provider-side recovery is a follow-up.
- **Eviction picks the least recently used idle worker,** not the one cheapest to reload (Codex and Claude reload
  their session from the provider; a harness that can't has its history re-sent). Preferring cheap reloads is later.
- **Worker costs are metered on the worker's own conversation.** Attributing them to the conversation that gave the
  work is the consumer's, from `last_conversation` and the events.
- **Headless conversations can't get human approval for worker requests;** they use rules (Flow 4).
- **All workers are equal:** any conversation whose policy allows `redirect` can take any worker. Workers only the
  owner may steer are later, as worker kinds a policy can be limited to (how such workers are created, and which
  policies they accept).

## Decided in review 2 (2026-11-22)

- Delegation tools go in the tool catalog supplied at each open; usage guidance in their descriptions, no system
  prompt section.
- Durable native delivery follows the harness's external notices rules; the acp-client module that implements it is
  built by that work's Gate 3, and the orchestrator uses it. Assignment id = the call's invocation id.
- Dropped from v1: `agent_action` records, "ask the agent", the worker policy and depth limit, limits per kind.

## Decided in review 1

- Only the pool prompts workers (Slots); the consumer reads, stops and deletes them.
- Whether a `worker_redirected` item wakes the agent is the harness's per-kind default, as for every item.

## Open

- [ ] Measurement, later: does reloading a harness session keep cache reads (Codex, Claude, OpenCode; throwaway
      sessions).
