# Orchestrator and worker pool

Status: agreed, not started. Written 2026-11-11. Lines of work L2 and L3 in `../11-11-NOTE-overview.md`. Buildable
first: tested through the consumer API with real or fake workers, with no harness and no provider key.

## Problem

Today every conversation owns a whole harness process (`AgentSession` creates an `AgentController`, which creates an
`AcpClient`, which launches a process). Ten conversations are ten Codex or Claude processes, and nothing limits live
processes or evicts idle ones.

The design (overview, decisions 1, 8, 9): many cheap native conversations talk; a fixed number of workers, usually ACP
harnesses, do the environment work. The harness is the agent's hands, not its voice. Between them sits one library
module, the orchestrator, which holds the pool and applies every rule.

Not in scope: how the agent decides to delegate (judgment, in the harness) and how worker replies are rendered (the
harness's renderers).

## Roles

- An **agent** is a conversation run by the native harness. A **worker** is a conversation the pool runs for it,
  usually ACP-driven (Codex, Claude) and possibly native.
- The agent decides whether to delegate, to which worker and what to tell the user. The user has no say in delegation.
- **The library never speaks in the agent's voice.** It records facts (a prompt sent, a turn ended, a worker busy) and
  never writes user-facing lines such as "Delegated · running"; the agent may not want to disclose that it delegates.
- **No rigid model.** No task lifecycle, structured brief or library-decided "done". The only library concept is a
  handle to a worker conversation, which lasts until the agent drops it.
- The agent owns the conversation and the decisions taken with the user; the worker owns the execution. Nobody steers
  the worker step by step: its harness is better at that.

## The orchestrator

```
consumer API  ──┐
harness tools ──┼──> orchestrator ──> pool ──> worker conversations
MCP tools     ──┘    (rules, routing)
(later)
```

- **Its API is the primitives:** open, send, check, stop, drop, list, and answer a forwarded permission request.
- **Every call says who it acts for:** a conversation, with the policy of the turn that made the call, or the
  consumer, which is privileged.
- **Scopes, caps and permission levels are checked here,** never in the tools, so the entry points can't disagree.
- **The harness only wraps the API as tools** (`delegate`, `check`, `stop`) through its delegation-backend contract;
  the MCP extension will be a second wrapper.
- **Dependencies:** the orchestrator depends on the `Agent` (to create and load conversations) and on a delivery
  interface for the way back. It doesn't import the harness, and the harness doesn't import it; the integration
  module registers it as the backend. An `Agent` with no orchestrator configured behaves as today.

```ts
interface Orchestrator {
  open(actor: Actor, text: string, options?: { title?: string }): Promise<OpenResult>;     // new worker
  send(actor: Actor, handle: string, text: string): Promise<SendResult>;                    // steer if busy
  check(actor: Actor, handle: string): Promise<WorkerStatus>;
  stop(actor: Actor, handle: string): Promise<void>;
  drop(actor: Actor, handle: string): Promise<void>;
  list(actor: Actor): Promise<WorkerSummary[]>;
  answerPermission(actor: Actor, requestId: string, optionId: string): Promise<void>;
}
type Actor = { kind: "consumer" } | { kind: "conversation"; conversationId: string; policy: DelegationPolicy };
type OpenResult = { handle: string; status: "sent" } | { status: "no_worker_free"; workers: WorkerSummary[] };
type SendResult = { status: "sent" | "steered" | "queued" } | { status: "no_worker_free"; workers: WorkerSummary[] };
```

Shapes are a starting point; records store facts at the primitive level ("conversation X sent this prompt to worker
Y"), never tool calls with their arguments, so the tools can be renamed or merged without touching stored data. The
tool definitions are internal defaults of the harness, not public API.

**Consumer, not end user.** The consumer API (`agent.workers.list()`, `check(id)`, `stop(id)`, `delete(id)`) sees and
controls every worker; no policy applies to it. This is what makes delegated work stoppable through the product
(agents-core: "a looping Agent must be stoppable through the product"). Whether end users see workers is the
consumer's product decision; the library never shows them by itself.

## Delegation limits from the turn's policy

The policy is the harness's (`../harness/11-11-SPEC-harness-v1.md`, Configuration and policies); the orchestrator
receives its `delegation` part with each call:

```ts
interface DelegationPolicy {
  use: boolean;                         // may open and message workers
  scope: "none" | "own" | "all";        // which workers it may check, message and stop
  max: number;                          // workers held at once by this conversation
}
```

"Own" means workers this conversation opened. A guest with `scope: "none"` asking to "stop whatever it's doing" is
refused by the orchestrator, not by the model. Worker conversations run under a worker policy: read what relates to
their delegation, write findings, no messaging the entity's participants, `delegate` off by default; if the consumer
turns it on, a depth limit stops workers delegating without end.

## Pool and busy policy

One pool per `Agent` instance, shared by every conversation; policies limit what each can touch. Two `Agent` instances
are two entities with two pools.

- **A handle is a persisted worker conversation, not a process.** The pool limit N counts live processes.
- **Idle workers are evicted.** When all N slots are taken and one is idle, the pool stops the least recently used
  idle worker. Its handle stays valid and it reloads on the next message, losing the provider cache.
- **No worker free** happens only when all N are busy. The answer lists each worker: who opened it, the start of its
  text, how long it has run. The agent decides (stop one, wait, tell the user).
- **Preemption needs no library policy:** an agent whose policy allows it calls `stop` and delegates again.
- **No wait queue for now.** Add one if the test run shows the agent retrying.
- **Native workers** (a research worker on consumer tools, say) cost API calls, not a process; the limit then counts
  per adapter or per kind.

**Workers are ordinary conversations** in the `Agent`'s registry, persisted and listable, with metadata marking them
as workers and who opened them. No new conversation type and no second registry: the pool manages them by querying
the registry.

| Stage | Meaning |
| --- | --- |
| created | `open` (`delegate` without `to`) |
| live | holds a slot |
| idle | turn ended; evictable |
| evicted | process stopped, handle kept |
| reloaded | a message arrived; needs a slot again |
| dropped | conversation and provider session deleted |

- **Only the pool wakes a worker.** The consumer can read and stop one, but a direct prompt would bypass the slot
  count, so prompts go through the pool or are refused.
- **Reload cost depends on the adapter.** Where the adapter can load a session, a reload keeps context and loses only
  the provider cache; otherwise context is rebuilt from the transcript, which costs more and loses detail.
- **Deletion** happens when the agent drops a worker, by an optional retention rule (off by default, `retention:
  { idleDays }`), or through `agent.workers.delete(id)`.
- **The worker's adapter** comes from the pool configuration, else the `Agent`'s default; the agent never chooses
  adapters. Leave room in the configuration for consumer-defined worker kinds ("coder" on Codex, "reviewer" on Claude)
  that the agent picks by name.
- **Restart.** The pool rebuilds its list from records with no live workers. Workers that were busy lost their
  process: they are marked interrupted and each delegating conversation gets an "interrupted" inbox item. Pending
  forwarded permission requests are refused.

```ts
new Agent({
  // ...
  orchestrator: {
    workers: { adapterId: "codex", cwd: "/work", limit: 2 },
    retention: { idleDays: 30 },
  },
});
```

**Jobs, and caching.** The recommended shape is a job per task, kept for follow-ups: a new task opens a worker (clean
context, isolation), a follow-up messages the same one (continuity), idle jobs are evicted and reloaded. The pool
limits jobs live at once, not jobs that exist. Provider caches are keyed on the request prefix, not on the process,
so a reload within the TTL keeps the cache unless the harness rebuilds its prompt differently on load; a new job
loses only its own history's cache.

**Measurement to run** (throwaway sessions only): per harness (Codex, Claude, OpenCode), a turn, stop, load, another
turn within a few minutes, compare cached input tokens in metering; then the same with a fresh session.

## Communication

**Agent to worker: plain prompts,** written by the agent, through the existing machinery:

| Need | Existing piece |
| --- | --- |
| Talk to work in progress | `busyDelivery: "steer"` folds a prompt into the running turn; `"queue"` waits (`src/steering/contracts.ts`) |
| Stop | `interrupt()`, with `clearQueue` |
| Status | the worker's `state.operation` (stage, tools in flight, last output) and latest messages |
| Results | the `prompt()` result, records, metering, stall handling, recovery |
| Several fronts on one worker | prompts into its queue, in order, each with `participantId` set to the sender |

The worker sees none of the agent's conversation; decisions agreed with the user reach it only if the agent writes
them into the prompt (the harness's default tool guidance says so). The library doesn't attach transcripts: costly,
leaks the conversation under guest policies, and takes the choice from the agent.

**Worker to agent, cheapest first:**

| Level | When | What |
| --- | --- | --- |
| The reply | the worker's turn ends | its final message, as an inbox item from that worker |
| `check` | when the agent asks | state, elapsed time, current plan, last tool call titles, latest message, from records already stored |
| Reading more (later) | rarely | a page of the worker's transcript |

- **`open` and `send` return at once** ("sent", "steered", "queued"); awaiting the worker's `prompt()` inside a tool
  would hold the agent's turn open for the whole job.
- **The way back belongs to the orchestrator.** It delivers replies, failures (stalled, crashed) and permission
  requests to the delegating conversation through a small delivery interface: an inbox item for a native
  conversation, a queued prompt for an ACP conversation once MCP exists.
- A worker needing a decision ends its turn with a question, which arrives as its reply. Asking without ending the
  turn (an `ask_agent` tool) comes with the MCP extension.
- A reply whose agent conversation is gone stays unread on the handle and shows on any `check`.
- **Events for the consumer:** worker opened, busy, idle, replied, permission requested, evicted, dropped.

## Permissions

One permission system covers the harness's tools, the consumer's tools and forwarded worker requests:

| Level | Who decides |
| --- | --- |
| Deny | refused without asking |
| Ask me | the human in the conversation |
| Ask the agent | the agent, on the user's behalf (worker requests only) |
| Allow | approved without asking |

- **Worker requests are forwarded.** ACP hands over the full request (tool call, options allow once / allow always /
  reject once / reject always, raw data). It goes through the policy of the turn that delegated the work, so a user
  who wants everything asked gets that. When that conversation can't approve (a guest), the request goes to a
  consumer-chosen conversation or is refused. Deny matters: worker tools come from a harness we don't control.
- **Ask the agent:** the request arrives in the delegating conversation as an inbox item and the agent answers with a
  tool, picking one of the worker's options; where Ask me is also possible, it can pass the request up. Never the
  default: the default is Ask me, or Deny where no human can answer.
- **A timeout.** The stale timer has no deadline while a permission is pending, so an unanswered request would hold a
  slot forever. Forwarded requests time out to a refusal.
- **Allow always outlives the request** (the worker harness keeps it for later tasks from other users), so it is
  stripped from what non-owner conversations are offered.
- **Today's default refuses everything** (`defaultPermission` defaults to `"cancel"`, `src/agent-session.ts:625`), so
  the pool needs forwarding before workers can do real work.
- **Approve by exact command or tool name, never by substring.**

## Accepted risk: workers sharing a workspace

The agent is an entity, not a coding harness, so the pool isn't tied to git or worktrees. Mitigations: `check` and "no
worker free" show what each worker does, so the agent can avoid overlap (judgment); the consumer can configure one
worker per workspace, or worker kinds with different working directories.

## Steps

1. Worker metadata on conversations; the orchestrator with `open`, `send`, `check`, `stop`, `drop`, `list` over the
   registry; slot accounting and LRU eviction; consumer API and events.
2. Delegation policy checks (`use`, `scope`, `max`) and the depth limit.
3. The delivery interface and the way back (reply, failure, interrupted on restart).
4. Permission forwarding with the four levels, timeout, and stripping allow-always.
5. Restart rebuild; retention.

## Acceptance

- Tests through the consumer API with fake workers cover: slots, eviction and reload, no worker free with the
  listing, policy refusals for each scope, `max`, restart with a busy worker, forwarded permission at each level and
  on timeout. No provider key.
- One run with real throwaway ACP workers (cheap model) shows a reply reaching the delegating conversation and a
  forwarded permission answered.
- A consumer can list and stop every worker.

## Open

- [ ] What a reply contains (final message only, or more); which turn ends wake the agent; batching several replies;
      the loop guard for agent–worker ping-pong.
- [ ] The default target for an Ask me request the delegating conversation can't answer.
- [ ] Only the pool wakes a worker (recommended), or direct consumer prompts allowed?
- [ ] Eviction preferring adapters that reload cheaply.
- [ ] Linking worker usage to the delegating conversation for cost roll-up.
- [ ] A preempted job: resumed later or abandoned?
