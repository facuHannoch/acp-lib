# Orchestrator and worker pool

Status: agreed, not started. Written 2026-11-11; grounded in code 2026-11-12; review 1 and implementation plan
2026-11-13; revised 2026-11-21 against the built harness and integration: **the orchestrator stands; only its route
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

- **acp-client registers `delegate`, `check`, `list` and `stop`** (names provisional) as consumer-registered
  functions when it opens the session (the harness's tools-and-callbacks work), each with its description and input
  schema, and adds a short section to the system prompt on how to use workers.
- **The harness runs them like any tool:** through its permission gate (a harness policy that denies them hides them
  from that channel's model), then a `functions/call` to the host with the invocation id, channel, turn, tool name
  and arguments. acp-client routes the call to the orchestrator and returns the result (`sent`, `steered`, `busy`,
  `no_worker_free`, statuses) as the tool's output.
- **The harness never knows it is delegating.** The pool, the busy rules, the way back and permission forwarding
  are all acp-client's, as below.

```
harness (the agent)                        acp-client (orchestrator + workers table)
  delegate / check / list / stop  ───────► functions/call (tools acp-client registered)
  ◄──────────────────────────────────────  replies, failures, redirected, interrupted, permission asks:
                                           items pushed onto the agent's channel
```

Nothing about workers goes into the system prompt; the tool descriptions say how to use them.

## Where it sits

```
                       consumer (agent.workers.list / check / stop / delete)
                                         │
┌────────────────────────────── acp-client (one Agent) ──────────────────────────────┐
│   native conversations (channels)                 orchestrator                     │
│   ┌──────────┐  ┌──────────┐                      ┌─────────────────────┐          │
│   │ agc-1    │  │ agc-2    │   delegate / check   │ rules: policy,      │          │
│   │ owner    │  │ trusted  │ ───────────────────► │ busy, redirect      │          │
│   └────┬─────┘  └────┬─────┘  (the harness's      │ pool: N slots, LRU  │          │
│        │             │        delegation callback)│ the way back        │          │
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

- **The delegation tools.** Their registration and system prompt section; the `functions/call` route from
  `src/native/` to the orchestrator; building the `Actor` from the call (the channel's conversation, the sender of
  the turn's input, and the call's contributing `policyNames`); mapping results back as tool output. Delegation calls
  aren't idempotent (`delegate` opens a worker): the harness never repeats an uncertain callback, which is what they
  need.
- **The delivery port's ACP half.** For an ACP conversation, items become out-of-band messages delivered with its
  next prompt, with a kind and a sender in their metadata (`src/out-of-band-messages.ts`). The native half (pushing
  onto a channel) comes from integration stage 2a.

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
pattern as `identity?` and the integration spec's `channels?`; SQLite implements it, schema version 18; a custom
backend without it can't enable the orchestrator: creating the `Agent` fails with a clear error):

```
workers
  handle             "w1": the name the agent uses; unique per Agent
  conversation_id    the worker's ordinary conversation
  opened_by          the conversation (or "consumer") where the work started
  about              the agent's short description; updated on any send that gives one
  last_conversation  the conversation that gave its latest work: where its reply and notices go
  created_at, dropped_at
```

Also persisted, for durable native completion (The way back): each assignment's identity, destination and
originating policy names, written before the work starts, and the worker's result with its staged notice, written
together. In memory only: which slot a worker holds, the resolved worker rules of the running assignment, pending
permission requests (refused on restart). Busy or idle is read from the worker conversation's state. Delegation facts (opened, sent,
redirected, stopped, dropped) are also written as `agent_action` records on both conversations, for audit, not as the
source of state.

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
restrictive** applicable rules (the `worker:` rules matched by acp-client's permission matcher, integration Remaining
work 2). An empty list selects the orchestrator's configured defaults, which another harness integration can also
select by explicitly saying it has no policy context. A missing field on a native callback, or an unknown name,
declines the delegation operation. The resolved rules are kept with the assignment and applied to that worker's
later permission requests. Example: a turn that took an owner's message and a guest's notice carries both names, so
it can send work to an idle worker if both allow it, but guest restrictions prevent taking over a busy one.

- Owner and trusted presets: `use`, `scope: "all"`, `redirect: true`. Guest: `scope: "none"`, `redirect: false`.
- No per-conversation cap by default: the pool limit is the entity's capacity.
- Workers run under a worker policy: no messaging the entity's participants, delegation off by default; if the
  consumer turns it on, a depth limit stops workers delegating without end.
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
  | { kind: "conversation"; conversationId: string; sender: SenderRef; policy: DelegationPolicy };
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
    4. row: handle w1, opened_by agc-1, about, last_conversation agc-1; agent_action records
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
                                                       yes → steer; last_conversation = X;
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
  delivery port → item "w1 finished: …" pushed onto channel agc-1 (w1's last_conversation)
  harness: keeps it in the channel's inbox (its own store), takes a turn, reads it, writes its own answer
  acp-client: records that turn on agc-1 and emits it → consumer → the owner sees the agent's answer
```

The user never sees the worker's text directly; the agent reads it and decides what to say.

| When | Item | To |
| --- | --- | --- |
| a worker's turn ends normally | `worker_reply`: its final message | `last_conversation` |
| a turn fails (stalled, crashed, error) | `worker_failed` with the error kind | `last_conversation` |
| another conversation redirects the worker | `worker_redirected` | the previous `last_conversation` |
| restart finds a worker that was busy | `worker_interrupted` | `last_conversation` |
| a forwarded permission at Ask the agent | `permission_request` with the options | `last_conversation` |

- **The port:** for a native conversation it delivers the result through `channel/notify`, as an external notice
  with a stable id, the text, a source label (the worker's handle) and the assignment's originating `policyNames`;
  the harness commits it to the channel's inbox before acknowledging, deduplicates retries by id, and refuses it
  while the channel or session is suspended ([external notices spec](../../../../src/native-harness/.res/docs/channel-messaging/0001-DESIGN-external-notices/SPEC.md)). For an ACP conversation
  (later, with MCP) it is an out-of-band message delivered with the next prompt.
- **Durable native completion:** persist the assignment's identity, worker-operation correlation, destination and
  originating policy names before dispatch. A committed final ACP worker conversation record is the recovery source.
  In the `Agent` database, record the assignment result and stage the pending notice in one transaction. After an
  acp-client restart, recover finalized unstaged completions by assignment id and retry staged notices by stable id
  until accepted, blocked or failed; the result stays available to `check` and `list`. If no reliable final record or
  supported provider recovery is available, stage an interruption notice with an uncertain outcome and do not
  automatically repeat the work. Recovery of a result that never reached a durable worker record is future work.
- **Redirect and completion:** persist the new destination and policy provenance together when redirect takes
  effect. Completion staging freezes the committed assignment state in the pending notice. A later redirect
  leaves that notice intact. Preserve policy restrictions from all work taken into the completed worker turn.
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
      ask the agent ─────► permission_request item on agc-1; the agent answers with a tool
    no answer before the deadline → refused
  w1 continues
```

- **When the conversation that gave the work doesn't answer permissions** (`answersPermissions: false`, for example
  one driven by an API integration with no human watching), its permission default applies at once, usually deny:
  the rule every conversation follows (integration spec, Permissions). No routing to another conversation; a headless
  conversation gets worker approvals through rules instead (the policy allows the specific commands). Ask the agent
  is never the default: the default is Ask me, or Deny where no human can answer.
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
                for each, the worker conversation's records: a turn that started and never ended → interrupted
                → "w1 was interrupted" item to its last_conversation
  none are live; the next send reloads them
  pending permission requests: gone (refused)
```

## Slots and scheduling

- `workers.limit` counts live workers (those with a running process); optional limits per kind.
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
  pool.ts           slots, serialization, LRU eviction, limits per kind
  workers.ts        prompting a worker (sender, steer, permission handler), reading status from its conversation
  busy.ts           the busy rules: who gave the running work, redirect, the busy answer
  permissions.ts    the forwarding handler, levels, deadlines, routing to the right conversation
  delivery.ts       turn ends → reply, failure, redirected and interrupted items
  restart.ts        rebuild on start
  consumer-api.ts   agent.workers.*
  index.ts
src/persistence/    the optional workers? repository (WorkerPersistence) with capabilities.workers; SQLite schema 18
```

- **Touches existing code:** `src/agent.ts` (construct when configured, expose `agent.workers`); `src/agent/config.ts`
  (the `orchestrator` option); `src/persistence/` (one optional repository, like the others); the worker marker on
  conversations, and identity skipping marked conversations (`src/agent/persisted-lifecycle.ts`,
  `src/agent/record-capture.ts`); `src/index.ts` (exports). The conversation manager is used through its public methods; `agent-session.ts` is not edited.
- Each file under ~400 lines; the module under ~2,000.
- Tests: `test/orchestrator/` with workers on the offline fixture ACP agents (turn ends, permission requests, stalls) and a
  temp-file SQLite.

## Implementation plan

Written 2026-11-13; not yet reviewed. Seven briefs, each about one agent run, run in order by one trio
(`../.plan-execution/plan.md`; its code-quality and triage rules apply).

**Dependencies.** Starts after the integration's briefs R1–R3: it uses the turn-based controller interface, the
permission events and `answerPermission` (R3), the permission matcher with `worker:` rules (R2), and the
optional-repository pattern (`channels?`, R1). **Also blocked on two harness proposals,** accepted and built: the
[callback policy amendment](../../../../src/native-harness/.res/docs/tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md) (`policyNames` on `functions/call`, used by O6's route) and
[external notices](../../../../src/native-harness/.res/docs/channel-messaging/0001-DESIGN-external-notices/SPEC.md) (`channel/notify`, used by O3's way back). O1–O5 need no harness: workers are
ordinary conversations on the existing offline fixture ACP agents (`test/fixtures/`: `steer-agent`,
`permission-agent`, `stalling-prompt-agent`, …), so they are tested as real conversations, not fakes. O6 needs the harness's
consumer-registered tools (`functions/call`) for its route.

**Common to every brief.** Clean-copy gates (`bun run typecheck`, full `bun test`, output saved); the integration
spec's final gate is the baseline; no edit to `src/agent-session.ts`; no live harness runs except O6's step 3, with
the owner's authorization.

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
  `configuration`, `permission`, `transition`, `metering_reference`, `lifecycle`, `cancellation`. **There is no
  `agent_action` kind** (What it keeps assumes one): brief G decides whether an existing kind fits the delegation
  facts or they are left to the events and the `workers` row in v1.
- **Persistence:** optional repositories with capability flags (`src/persistence/backend.ts`), as `channels?`.

### Brief G: grounding

The implementer checks The code as it is and every reuse point in the briefs against the code after integration R1–R3
(the permission events, the matcher's `worker:` prefix, the `channels?` pattern), checks that `policyNames` on
`functions/call` and `channel/notify` are built as their harness specs say,
decides the `agent_action` question with a recommendation, and reports what moved or doesn't exist
(`library/reports/<date>-REPORT-OG.md`). Corrections go to the spec owner before O1.

### Brief O1: the pool and the workers table

**Scope:** steps 1–4.

1. **The `workers?` repository** with `capabilities.workers`, its SQLite implementation (schema 18, upgrade from 17,
   tested on a version-17 database); the orchestrator refused at `Agent` construction on a backend without it. It
   holds from the start everything What it keeps lists: the workers rows, each assignment's identity, destination and
   originating policy names (written before the work starts), and each result with its staged notice (written in
   one transaction, used by O3 and O5). **Gate:** suite green; the upgrade test; a result and its staged notice
   written together or not at all.
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
   `redirect: true` steers, moves `last_conversation`, and pushes `worker_redirected` to the previous one. **Gate:**
   each case, with two conversations on one worker.
2. **Policy checks:** `use`, `scope`, `redirect` (also gating stop by others and drop), `maxOpen`; the worker policy's
   delegation off and the depth limit. **Gate:** a refusal for each.

**Done:** report commits and each case.

### Brief O3: the way back

**Scope:** steps 1–2.

1. **The delivery port** (`src/orchestrator/contracts.ts`): `channel/notify` for native conversations (external
   notices), out-of-band messages with a kind and a sender in their metadata for ACP conversations, delivered with
   the next prompt. Results recorded and their notices staged in one transaction. **Gate:** a notice reaches a native
   channel through the fake harness client; an item reaches an ACP conversation; a suspended channel leaves the
   notice staged.
2. **Items:** `worker_reply` (the final message) on a normal turn end, `worker_failed` with the error kind, to
   `last_conversation`; a stop asked by the conversation itself produces none; a gone target keeps the reply on the
   worker (`check`, `list`). **Gate:** each item; a deleted target.

**Done:** report commits and each item.

### Brief O4: permission forwarding

**Scope:** steps 1–2.

1. **The handler** passed with each prompt to a worker: the level from the giving conversation's `worker:` rules
   (integration R2's matcher); allow and deny answered at once; ask me as `permission_requested` on the giving
   conversation, marked with the worker (integration R3); ask the agent as a `permission_request` item; a giving
   conversation that doesn't answer permissions gets its default at once. **Gate:** each level; the timeout; a
   headless giving conversation.
2. **Allow always:** stripped from the options shown when a non-owner conversation is asked; automatic allow follows
   the auto-approve rule. **Gate:** both.

**Done:** report commits and each case.

### Brief O5: stop, drop, idle stop, restart

**Scope:** steps 1–3.

1. **`stop`** (`interrupt({ clearQueue })`, allowed for the giver or with `redirect`) and **`drop`** (stop, delete the
   conversation and provider session, mark the row dropped). **Gate:** each, and a refusal.
2. **Idle stop:** `workers.idleStopMs` (default 10 minutes, `false` off); the next send reloads; `worker_stopped` with
   the reason. **Gate:** a worker idle past the limit has no process and reloads on the next send.
3. **Restart:** workers read from the repository; a turn that started and never ended reported `worker_interrupted`
   to `last_conversation`; unstaged completions recovered and staged notices retried by id; pending permission
   requests refused. **Gate:** a restart with a busy worker; a restart with a staged notice not yet accepted,
   delivered once.

**Done:** report commits and each case.

### Brief O6: the delegation route, end to end

**Scope:** steps 1–3.

1. **The route:** the delegation tools registered at session open with their prompt section; `functions/call` from
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
- **Eviction picks the least recently used idle worker,** not the one cheapest to reload (Codex and Claude reload
  their session from the provider; a harness that can't has its history re-sent). Preferring cheap reloads is later.
- **Worker costs are metered on the worker's own conversation.** Attributing them to the conversation that gave the
  work is the consumer's, from `last_conversation` and the events.
- **Headless conversations can't get human approval for worker requests;** they use rules (Flow 4).
- **All workers are equal:** any conversation whose policy allows `redirect` can take any worker. Workers only the
  owner may steer are later, as worker kinds a policy can be limited to (how such workers are created, and which
  policies they accept).

## Decided in review 1

- Only the pool prompts workers (Slots); the consumer reads, stops and deletes them.
- Whether a `worker_redirected` item wakes the agent is the harness's per-kind default, as for every item.

## Open

- [ ] Measurement, later: does reloading a harness session keep cache reads (Codex, Claude, OpenCode; throwaway
      sessions).
