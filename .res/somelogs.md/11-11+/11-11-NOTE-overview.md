# Native harness and worker pool: overview

Status: design agreed, nothing built. Written 2026-11-11 from the design discussion of 2026-11-06 to 2026-11-11.
This note is the entry point to the specs in this folder and the single home of the decisions log, the open questions
and the order of work; the specs link here instead of repeating them.

Supersedes, as direction: `../9-22+/10-17-NOTE-model-call-controller.md` (the model-call controller idea, now the
native harness; its "order" is replaced by the one below) and `../harness.md` (an export of the 11-11 chat). The
specs are the source of truth; the Claude Docs they came from carry a pointer here. The theory behind them is
`harness/theory/11-11-NOTE-harness-theory.md`.

## The system in one picture

```
                       consumer code (the host)
                               │  Agent API, CLI
┌──────────────────────── Agent (acp-client process) ────────────────────────┐
│                                                                             │
│  AgentConversation ── NativeController ─┐                                   │
│  AgentConversation ── NativeController ─┤ NativeHarnessHost: the Agent's    │
│  (each one a channel of the session)    │ session; HarnessClient ═══ stdio ═╪══► harness serve --session S
│                                         │ serves callbacks: functions,      │    (agent's environment:
│                                         │ delegation, history               │     loop, tools, MCP, model
│                                         ▼                                   │     calls, timeline, storage)
│                               orchestrator ──► pool ──► worker conversations│
│                                                                │            │
│  AgentConversation ── HarnessController ──────────────────────┴────────────╪══► Codex / Claude / OpenCode
│        └── identity runtime: load → preamble, update → timeline,           │    (started through the
│            delivered → position                                            │     launcher, as today)
└─────────────────────────────────────────────────────────────────────────────┘
```

- **A native harness session is the agent entity.** It talks to many parties at once (owner chats, trusted agents, guests,
  a public channel) while staying one identity, and does no environment work itself.
- **Workers do the environment work.** They are ordinary conversations (usually ACP harnesses) that the library's
  orchestrator runs in a pool; the agent reaches them through delegation tools.
- **The library hosts the harness.** It drives it through the `NativeController`, plugs in the orchestrator, its
  records and the consumer's functions, and gives ACP conversations the entity's identity by injection.

## The specs

| Spec | What it settles | Priority |
| --- | --- | --- |
| `library/11-11-SPEC-controller-interface.md` | The controller interface `AgentSession` depends on, ACP-only features as capabilities, neutral capabilities | First: offline refactor, prerequisite for every native piece |
| `library/11-11-SPEC-orchestrator.md` | Orchestrator, pool, worker lifecycle, consumer API, permission forwarding, the way back | Second: offline, testable with fake workers |
| `library/11-11-SPEC-native-harness-integration.md` | The harness from acp-client's side: why, the `native` adapter, `NativeController`, inbox and native steering, identity as injection, the `http` internal-inference runtime | After the harness foundation |
| `library/11-11-SPEC-cli.md` | The `acp-client agent` CLI on `Agent` | Last |
| `harness/11-11-SPEC-harness-design.md` | What the native harness is and why we build it; alternatives; the overall design | Read first |
| `harness/11-11-SPEC-harness-v1.md` | The first implementation: kernel, contracts, config and policies, tools, model client, context, timeline v1, storage, CLI | With the controller interface |
| `harness/11-11-SPEC-harness-project.md` | Package layout, the pattern, dependency and contribution rules, testing, build order | Before the first harness commit |
| `harness/11-11-NOTE-memory-findings.md` | Findings on memory: kinds, write and read paths, Letta, digests, what is deferred | Reference |
| `harness/theory/11-11-NOTE-harness-theory.md` | How harnesses work in general | Reference |

## Decisions

Agreed between 2026-11-06 and 2026-11-11. Changing one is a new decision recorded here.

1. **Shape.** Many concurrent native conversations backed by our own harness; a pool of workers (ACP or native) does
   the environment work; they talk with plain prompts through the existing prompt, steer, queue and interrupt
   machinery.
2. **Names (provisional).** `NativeHarness`, `NativeController`, adapter kind `native`. "Native" because in this
   codebase it already means "done by the library itself" (`native_action`). Rejected: "direct" (names how it works
   today, stops fitting once the harness is useful on its own), "model", "built-in".
3. **The native harness is self-sufficient and is the entity:** its own storage (SQLite for the identity core), model
   client, JSON configuration and policies, CLI. The library is one host.
4. **Ownership rule.** The harness owns capabilities about the entity (identity, timeline, memory, shared state, its
   sessions); the library owns capabilities about driving other harnesses (ACP sessions, workers, the pool). Where
   both hold data for one capability, the harness defines a source contract and the host plugs in sources.
5. **Responsibility rule.** Judgment goes to inference, policy goes to code. The library never speaks in the agent's
   voice; there is no rigid task model.
6. **One `AgentConversation`;** the adapter's kind chooses the controller: `HarnessController` (today's
   `AgentController`, renamed; it drives an external harness, ACP being the means) or `NativeController`, both behind
   the `ConversationController` interface. Requires the controller interface (spec
   above). Rejected: a separate conversation type.
7. **Delegation through tools,** starting with `delegate`, `check`, `stop`; `message_participant` (deliver, no model
   call) and `trigger_response` (wake the target conversation) reach other conversations, several recipients each.
   Records stay at the primitive level so tools stay cheap to change. No plan-based events and no `notify` tool; the
   way back is wake events, later worker report tools, and the agent checking.
8. **The orchestrator** is a library module holding the pool, with its own API; harness tools, MCP tools and the
   consumer API are thin wrappers and all checks live in it. It is registered as the harness's delegation backend.
9. **Workers** are ordinary conversations managed by the pool, one pool per `Agent` instance; their adapter comes
   from pool configuration, never from the agent; busy workers come back as interrupted after a restart. **They
   belong to the entity, not to a conversation:** shared by every conversation the policy allows (`scope: none |
   all`), with no per-conversation cap. Each carries soft context the agent writes (`about`), plus where and by whom
   it was last instructed.
   **Busy work is a warning:** a send from the conversation that gave the running work steers; from any other it
   returns `busy` with that context; `redirect` steers anyway when the policy allows, and the previous conversation
   is told. No queueing behind another conversation's work; no trust hierarchy.
10. **Permissions:** four levels (deny, ask me, ask the agent, allow); worker requests are forwarded through the
    delegating turn's policy.
11. **Policies** (renamed from "profiles") live in the harness configuration and are asserted per prompt by the host,
    never by end users; a turn triggered by several items takes the most restrictive; presets `readOnly`, `guest`,
    `trusted`, `owner`; no participant registry, the owner is just a policy.
12. **Tool placement** is a pipeline strategy (stable superset plus a per-turn hint by default); the gate always
    enforces.
13. **The inbox** is two existing mechanisms: persisted items as out-of-band messages (with a kind and a sender),
    live items through the conversation queue and steering. Native delivery pushes into the harness session (wake or
    next model call); ACP delivery is next-prompt. Rendering is the harness's.
14. **Identity is a timeline in the harness:** one append-only history, a position per conversation, shared state and
    memory as projections, delivery as a digest of the slice since a position. Conversation summaries are
    acp-client's, reported into the timeline. acp-client only injects, through the existing `AgentIdentityRuntime`
    (`load`, `update`, `delivered`) implemented over the harness; ACP conversations join as
    member channels; the checkpoint-backed identity is deprecated.
15. **Phase 1 memory** is a simple shared state on the timeline. Watches are deferred (`harness/todos/11-11-TODO-watches.md`).
16. **Internal inference** gets an `http` runtime that imports the harness's model client; the ACP-session runtime
    stays as the fallback.
17. **MCP** is an optional extension for ACP-backed controllers, not the channel between conversations; the harness
    is an MCP client from phase 1.
18. **The internal event model** stays as it is; the `NativeController` translates into it.
19. **Harness architecture:** microkernel with ports and adapters, one actor per channel, an explicit turn state
    machine, a functional core for the context, middleware for model and tool calls, an event-sourced store.
20. **Surfaces:** the API, and a CLI on `Agent` that owns no logic; the harness has its own `harness` CLI.
21. **First version:** the full skeleton with simple implementations, judged on the basic promise (harness design
    spec).
22. **Breaking changes** to records and tables are allowed.
23. **Isolation from v1.** The native harness runs as its own process in the agent's environment, one per `Agent`,
    started through the launcher (generalized to `ProcessLauncher`), like external harnesses today. It speaks its own
    JSON-RPC protocol over stdio (`harness serve --stdio`); ACP was rejected as the protocol. The public API is
    serializable; host functions, the delegation backend and history sources are callbacks. An in-process transport
    exists for tests and the standalone CLI.
24. **Adapter types are separate.** `Adapter` stays the `HarnessController`'s (an external harness command);
    `NativeAdapter` (`kind: "native"`) is its own type; `Agent` configs take either.
25. **Controller names.** The interface is `ConversationController`; `AgentController` is renamed
    `HarnessController` (alias kept); the new one is `NativeController`.
26. **Execution port.** Every process the harness starts (`command` tools, stdio MCP servers) goes through one port;
    the default spawns in the harness's own environment.
27. **Watches are deferred** to `harness/todos/11-11-TODO-watches.md`.
28. **New library code lives in new modules** (`src/conversation-controller/`, `src/orchestrator/`, `src/native/`);
    `agent-session.ts` does not grow; only `src/native/` imports the harness package.
29. **A harness session is the entity; channels are lines into it.** One session has its own config, timeline,
    shared state and memory; two sessions are two agents. A harness home (`~/.harness/` by default) stores many
    sessions; one process serves one session, locked while open. Each conversation is a channel (the host's
    conversation id passed through), with its own context and participants. In acp-client one `Agent` is one session
    (configured once on the `Agent`, `AgentConfig.harness`); every native conversation's `internal_session_id` is
    that session's id. Native adapters differ only in channel defaults.
30. **Config belongs to the session:** stored in it standalone; owned by the host while hosted.
31. **Where a session lives:** acp-client's data location by default when not isolated; inside the agent's
    environment when isolated, with acp-client keeping the durable copy by state sync (import on start, timeline
    events as appended, channel snapshots).
32. **Usage by purpose.** Every harness model call carries a purpose; the host files it by where it happened (inside
    a turn: that turn; otherwise entity-level metering). The session keeps its own ledger. acp-client's conversation
    summaries stay acp-client's internal inference.
33. **No native subagents** in the first or second pass; a standalone session has no delegation tools.
34. **Messages in, turns out.** A message going in and a turn running are separate. `send()` puts a message in and
    resolves when it is accepted; every turn, whatever caused it, is reported on the conversation's turn events with
    its cause (a message, a worker reply, another channel); `prompt()` stays as a shortcut: send, then wait for the
    turn that took the message. For native conversations the harness decides when turns run and acp-client records
    the turns it reports (harness → box); for ACP, each message gives exactly one turn, as today. Inside, `runPrompt`
    is split into "accept a message" and "run a turn"; this is part of L1. ACP harnesses talking outside a turn, and
    ACP v2 (a draft that adopts the same model), are in `library/todos/11-12-TODO-acp-messages-outside-a-turn.md`.


**Rejected directions:** pooling several ACP sessions in one harness process; one shared thread all conversations
talk into; building on top of an existing harness; the custom harness as an in-process ACP agent; an HTTP controller
with the model client as a library layer; one harness per conversation; the library hosting the harness's store;
answering everything through a `send_message` tool (MemGPT); a participant registry; dropping ACP support.

## Open questions

Decisions for the owner:

- [ ] Repo layout: Bun workspace with `packages/native-harness` (recommended, private until stable), or
      `src/native-harness/` with lint-enforced boundaries.
- [ ] The harness's package name (and whether `NativeHarness` stays the public name).
- [ ] Whether acp-client hard-depends on the harness package or takes it as an optional peer.

Design questions, each owned by a spec:

- [ ] Whether a `worker_redirected` item always wakes, or only when the previous work came from a human
      (orchestrator).
- [ ] Default target for an Ask me worker request the delegating conversation can't answer (orchestrator).
- [ ] Whether only the pool may wake a worker (recommended) (orchestrator).
- [ ] Eviction preference for adapters that reload cheaply; worker usage rolled up to the delegating conversation
      (orchestrator).
- [ ] Do Codex and Claude support HTTP MCP servers over ACP, or is the stdio bridge needed (integration).
- [ ] Cache measurement: does reloading a harness session keep cache reads (orchestrator).
- [ ] Digests: granularities, how and when they are produced (harness v1, memory findings).
- [ ] Steering: abort an in-flight model call and resend, or always wait (harness v1).
- [ ] Config versioning and how the library overlays the document (harness v1).
- [ ] Member-session tokens and cleanup (harness design; phase 2).
- [ ] Does the managed `AgentSession` REPL fold into the new CLI (CLI).
- [ ] Whether the consumer may wake an ACP conversation with an item, or ACP only gets next-prompt delivery
      (integration).
- [ ] agents-core runs on `SessionManager`, not `Agent`: when it moves to `Agent` to get native conversations and
      workers (its own decision).

**Blocked on:** a provider key for live runs (no OpenRouter key; the OpenCode Zen key has expired). Everything up to
the integration step runs offline.

## Code map

| Side | Module | Owns |
| --- | --- | --- |
| library | `src/conversation-controller/` | the `ConversationController` interface, capabilities, the controller factory |
| library | `src/controller.ts` | `HarnessController` (renamed in place) |
| library | `src/orchestrator/` | pool, workers, busy rules, permissions, delivery, its persistence extension, `agent.workers` |
| library | `src/native/` | `NativeAdapter`, host, callbacks, `NativeController`, event translation, steering host, inbox delivery, identity runtime |
| library | `src/internal-inference/runtime/http-runtime.ts` | internal inference over HTTP |
| harness | `packages/native-harness/` (pending H0) | everything in `harness/11-11-SPEC-harness-project.md`; v1 contents in `harness/11-11-SPEC-harness-v1.md`, v1 code plan |

## Order of work

Lines of work, with what each needs first. L = library, H = harness, X = cross-cutting.

| Id | Work | Needs |
| --- | --- | --- |
| L1 | Extract the controller interface; neutral capabilities | nothing (offline) |
| L2 | Orchestrator and pool, with fake workers | L1 for native workers only |
| L3 | Permission forwarding for workers (four levels, timeout) | L2 |
| L4 | The inbox: out-of-band items with kind and sender; the delivery port | nothing (offline) |
| H0 | Repo layout and the harness package | owner decision |
| H1 | Contracts, conformance skeletons | H0 |
| H2 | Kernel with the scripted client, in-memory store, golden requests | H1 |
| H3–H9 | Workstreams: provider client, context pipeline, compaction, tools and MCP client, config and policy engine, timeline v1 and storage | H2 |
| H10 | Protocol: `harness serve --stdio`, `HarnessClient`, both transports; execution port | H2 |
| H11 | `harness` CLI (`chat`, `config`, `serve`) | H3, H7, H10 |
| L5 | `NativeAdapter`, `NativeHarnessHost` (launch, restart, callbacks), `NativeController`, native steering | L1, L4, H2–H5, H10 |
| L6 | Orchestrator as delegation backend; records as history source; functions | L2, L5 |
| L7 | Identity injection for ACP conversations; summaries reported to the timeline; deprecate checkpoint-backed identity | L5, H8 |
| L8 | `http` internal-inference runtime | H3 |
| X1 | Smoke test (duration-parser fixture) and the basic-promise checks | L6, a key |
| X2 | Evals and the prompt-injection suite | X1 |
| L9 | CLI on `Agent` | L5 (REPL value exists earlier for ACP-only) |
| P2 | Phase 2: long-term memory, MCP server and member channels, watches, skills, deferred tools, worker kinds, removal of checkpoint identity | phase 1 |
