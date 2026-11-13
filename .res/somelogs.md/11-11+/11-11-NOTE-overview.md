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
| `library/11-11-SPEC-controller-interface.md` | The turn split and the turn-based controller interface, ACP-only features as capabilities, neutral capabilities | Library 1: an offline refactor, no new behaviour |
| `library/11-11-SPEC-native-harness-integration.md` | The harness from acp-client's side, in two stages: native conversations, permissions as events (2a); identity, callbacks, internal inference over HTTP (2b) | Library 2 and 3, with harness parts 1 and 2 |
| `library/11-11-SPEC-orchestrator.md` | Orchestrator, pool, worker lifecycle, consumer API, permission forwarding, the way back, delegation callbacks | Library 4 |
| `library/11-11-SPEC-cli.md` | The `acp-client agent` CLI on `Agent` | Library 5, last |
| `11-12-SPEC-harness-protocol.md` | The protocol between a host and the harness: methods, events, callbacks, errors, timeouts, framing, versioning | Agreed before either side is built; both build against it |
| `11-12-SPEC-end-to-end-robustness.md` | A stress test across the library and the harness, used to refine the model (messages, interrupts, crashes, persistence failures, holds, changes while stopped) | After everything that builds is done |
| `harness/11-11-SPEC-harness-design.md` | What the native harness is and why we build it; alternatives; the overall design | Read first |
| `harness/11-11-SPEC-harness-project.md` | Package layout, the pattern, dependency and contribution rules, testing, build order | Harness 1, before the first harness commit |
| `harness/11-11-SPEC-harness-v1.md` | The first implementation, in two parts: the core, server mode and a test mode (part 1); the actual harness (part 2) | Harness 2 and 3, in parallel with the library line |
| `harness/11-11-NOTE-memory-findings.md` | Findings on memory: kinds, write and read paths, Letta, digests, what is deferred | Reference |
| `harness/theory/11-11-NOTE-harness-theory.md` | How harnesses work in general | Reference |

**Document types:** `SPEC` (what to build), `NOTE` (context and decisions), `TODO` (deferred work), `FINDING`
(something observed, accepted for now), `RULES` (how the library behaves and why, documented without changing it).
Named `<month>-<day>-<TYPE>-<topic>.md`, in the folder of the part they concern.

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
7. **Delegation through tools,** starting with `delegate(text, about?, to?)`, `check`, `list`, `stop`; `message_participant` (deliver, no model
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
10. **Permissions:** four levels (deny, ask me, ask the agent, allow), in one permission setting with one shape
    (`permissions: { default, rules }`, rules by pattern) covering the harness's own tools, tools declared in the
    config, MCP tools and worker requests (`worker:` rules, applied by the orchestrator to the work of whoever gave
    it). acp-client's ACP conversations use the same shape instead of `defaultPermission: "approve" | "cancel"`.
11. **Policies** (renamed from "profiles") live in the harness configuration and are asserted by the host, never by
    end users, in three layers: the message's policy, else the channel's, else the session's `defaultPolicy`. A
    native adapter's default only seeds a new channel's policy. A turn triggered by several items takes the most
    restrictive; presets `readOnly`, `guest`, `trusted`, `owner`; no participant registry, the owner is just a
    policy. The agent is told each turn which channel it is in and what its policy allows, so it can say "not here;
    talk to me in our other conversation". Senders are acp-client's participants passed through (the same id in two
    conversations is the same person); the conversation's `title` is the channel's label.
12. **Tool placement** is a pipeline strategy (stable superset plus a per-turn hint by default); the gate always
    enforces.
13. **The inbox** belongs to whoever runs the loop: for native conversations the harness keeps it, per channel, in
    its own store (an item wakes the channel or goes in at the next model call); for ACP conversations it is
    acp-client's out-of-band messages (with a kind and a sender), delivered with the next prompt. Rendering is the
    harness's.
14. **Identity is a timeline in the harness:** one append-only history, a position per channel, shared state and
    memory as projections, delivery as a digest of the slice since a position. Conversation summaries are
    acp-client's, reported into the timeline. acp-client only injects, through the existing `AgentIdentityRuntime`
    (`load`, `update`, `delivered`) implemented over the harness; ACP conversations are managed member channels in v1
    (identity prepared for them, their messages and summaries reported); the harness's MCP server for members and
    unmanaged members are phase 2; the checkpoint-backed identity is deprecated.
15. **Phase 1 memory** is a simple shared state on the timeline. Watches are deferred (`harness/todos/11-11-TODO-watches.md`).
16. **Internal inference** gets an `http` runtime with its own minimal OpenAI-compatible client and model config in
    acp-client (duplicated on purpose: one call, no tools; it keeps internal inference independent of the harness
    package); the ACP-session runtime stays as the fallback.
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
    `agent-session.ts` does not grow; only `src/native/` imports the harness (its entry points in `src/native-harness/`).
29. **A harness session is the entity; channels are lines into it.** One session has its own config, timeline,
    shared state and memory; two sessions are two agents. A harness home (`~/.harness/` by default) stores many
    sessions; one process serves one session, locked while open. Each conversation is a channel (the host's
    conversation id passed through), with its own context and participants. In acp-client one `Agent` is one session
    (configured once on the `Agent`, `AgentConfig.harness`); every native conversation's `internal_session_id` is
    that session's id. Native adapters differ only in channel defaults.
30. **Config belongs to the session:** stored in it standalone; owned by the host while hosted.
31. **Where a session lives:** in the harness home, settable by the consumer (`AgentConfig.harness.home`, a path in
    the harness's environment); acp-client's data location by default. No sync in v1: a bad path fails, an ephemeral
    home loses the entity, backup is a manual export and import (`harness/todos/11-12-TODO-session-sync-and-backup.md`).
32. **Usage by purpose.** Every harness model call carries a purpose; the host files it by where it happened (inside
    a turn: that turn; otherwise entity-level metering). The session keeps its own ledger. acp-client's conversation
    summaries stay acp-client's internal inference.
33. **No native subagents** in the first or second pass; a standalone session has no delegation tools.
34. **Messages in, turns out.** A message going in and a turn running are separate. `send()` puts a message in and
    resolves when it is accepted; every turn, whatever caused it, is reported on the conversation's turn events with
    its cause (a message, a worker reply, another channel); `prompt()` stays as a shortcut: send, then wait for the
    turn that took the message. For native conversations the harness decides when turns run and acp-client records
    the turns it reports (harness → box); for ACP, each message gives exactly one turn, as today. Inside, every turn
    runs from the controller's `turn_started` (the first library spec, the controller interface). ACP harnesses
    talking outside a turn, and
    ACP v2 (a draft that adopts the same model), are in `library/todos/11-12-TODO-acp-messages-outside-a-turn.md`.
35. **Messages between channels.** `message_participant` puts the agent's text in another channel without a turn
    (acp-client records it as an appended assistant message on that conversation and emits it); `trigger_response`
    makes the other channel take its own turn. Targets are channels of the same session; how the agent addresses
    them (titles, handles) is settled after real use. Code guarantees actions (who may message whom, what tools run),
    not the confidentiality of what the agent writes (`harness/todos/11-12-TODO-information-confidentiality.md`).
    Tool names are provisional.
36. **Permissions are events.** A request is a `permission_requested` event on the conversation, for prompted turns
    and turns the harness starts alike; the answer is `conversation.answerPermission(id, option)`; the per-prompt
    handler stays as a shortcut. A conversation whose consumer answers waits up to a timeout, then refuses; otherwise
    `defaultPermission` applies at once. Forwarded worker requests at Ask me use the same path.
37. **A conversation's life** follows the channel: its id is the channel id; a cleared transcript or a handoff into
    native gives the channel a fresh context; a handoff out of native seeds the ACP session from acp-client's records
    or a summary, as today, and the channel stays in the session; deleting closes the channel and keeps its timeline
    events. `conversation.setTitle()` is added, since the title is the channel's label.
38. **The orchestrator stores almost nothing:** one core `workers` table (handle, conversation, opened by, about,
    last conversation). Progress is read from the worker conversation; slots, busy state, policies of running work
    and pending permissions are in memory. No persistence extension. The harness reaches the orchestrator only
    through its delegation tools and hears from it only through items on its channels.
39. **Per-channel settings.** Model settings changed on a conversation (model, reasoning, temperature) are that
    channel's settings in the harness, overriding the session's config for that channel only; there is no config
    overlay.
40. **The controller interface is turn-based.** `send(run)` puts a run of messages in; the controller reports
    `turn_started` with its cause; the session prepares the turn with `prepareTurn(turnId, content)` and runs it under the supervisor (ACP: today's
    prompt call, with the input the session builds at turn time; native: the harness's stream into the session's
    handlers) and owns the public completion, after finalization; `abandonTurn` ends a turn that won't run. The
    `HarnessController` reports each run at once, so the order of events stays as today. Turns the backend starts on
    its own join the conversation's operation queue. For consumers, `prompt()` and its handle are unchanged; the turn
    events carry the cause (controller-interface spec).
41. **The backend starts turns freely; the host never grants them.** The harness decides when a channel takes a
    turn. acp-client keeps its guarantees with holds for exclusive operations (handoff out, stop, delete), in-order
    handling of each conversation's turns, and a budget guard in the harness. Limitations and the alternatives (a
    grant before each turn) are in the controller-interface spec, Appendix A.
42. **The native harness process starts lazily, on activity, and its config is known before start.** Channels always
    exist; the process (and its container) starts when a native conversation first needs it and may stop when idle.
    acp-client stores the harness config (the `Agent` config as base, API changes as overrides) and answers models,
    commands and capabilities from it and the harness's `describe(config)`, so a native conversation always
    looks ready. The harness session id is the `Agent`'s id. Background work and waking a stopped harness are phase 2
    (`harness/todos/11-12-TODO-background-work-and-lazy-harness.md`).


**Rejected directions:** pooling several ACP sessions in one harness process; one shared thread all conversations
talk into; building on top of an existing harness; the custom harness as an in-process ACP agent; an HTTP controller
with the model client as a library layer; one harness per conversation; the library hosting the harness's store;
answering everything through a `send_message` tool (MemGPT); a participant registry; dropping ACP support.

## Open questions

Decisions for the owner:

- [x] Repo layout (decided 2026-11-12): `src/native-harness/` in this repo, acting as a separate package from the
      start (its own entry points, never importing acp-client, enforced in CI); split out later as a package or a
      binary. acp-client depends on it directly until then.
- [ ] The harness's package name for when it is split out (and whether `NativeHarness` stays the public name).

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
- [ ] Config versioning and the shape of validation errors (harness v1).
- [ ] Member-channel tokens and cleanup (harness design; phase 2).
- [ ] Does the managed `AgentSession` REPL fold into the new CLI (CLI).
- [ ] Whether the consumer may wake an ACP conversation with an item, or ACP only gets next-prompt delivery
      (integration).
- [ ] agents-core runs on `SessionManager`, not `Agent`: when it moves to `Agent` to get native conversations and
      workers (its own decision).


## Code map

| Side | Module | Owns |
| --- | --- | --- |
| library | `src/conversation-controller/` | the `ConversationController` interface, capabilities, the controller factory |
| library | `src/controller.ts` | `HarnessController` (renamed in place) |
| library | `src/orchestrator/` | pool, workers, busy rules, permissions, delivery, `agent.workers`; the `workers` table in `src/persistence/` |
| library | `src/native/` | `NativeAdapter`, host, callbacks, `NativeController`, event translation, steering host, inbox delivery, identity runtime |
| library | `src/internal-inference/runtime/http-runtime.ts` | internal inference over HTTP |
| harness | `src/native-harness/` (acting as a separate package) | everything in `harness/11-11-SPEC-harness-project.md`; v1 contents in `harness/11-11-SPEC-harness-v1.md`, v1 code plan |

## Order of work

Work proceeds **one spec at a time**, from review to done. Each spec is first reviewed on its own several times
(corrected, improved, checked against the code), then closed with an implementation brief, then handed to an
implementing agent (about an hour per brief; a large spec is split into several briefs).

**The implementation brief** at the end of each spec:

1. scope, and what the run must not touch;
2. steps, each with a gate: the tests that must pass and the commands that run them before moving on;
3. a test plan: new unit tests, conformance suites, regression and characterization tests, end-to-end tests (offline,
   with the harness's scripted model where a harness is involved), and any live run with its authorization noted;
4. done criteria, and what to report back (commits, test output, deviations from the spec);
5. risks, and how to tell a step went wrong.

**The library line, in order:**

1. **Controller interface** (`library/11-11-SPEC-controller-interface.md`): the turn split, the turn-based
   controller, the `HarnessController` rename, neutral capabilities. A refactor with no new behaviour; its gate is no
   regressions (the existing suite, plus characterization tests written before the refactor). Ready for
   implementation, in four briefs (A1 characterization tests, A2 turn path, B1 interface, B2 conformance).
2. **Integration stage 2a** (`library/11-11-SPEC-native-harness-integration.md`): native conversations end to end
   against harness part 1, permissions as events and the one permission setting, export and import.
3. **Integration stage 2b**: identity for ACP conversations, the function and history callbacks, messages between
   channels, the `http` internal-inference runtime (which can go anywhere). Needs harness part 2.
4. **Orchestrator** (`library/11-11-SPEC-orchestrator.md`): the pool, the `workers` table, the busy and redirect rules,
   the way back (native and ACP), permission forwarding, the delegation callbacks, restart.
5. **CLI on `Agent`** (`library/11-11-SPEC-cli.md`).

**The harness line, in parallel** (once its spec is reviewed; the protocol spec is agreed first):

1. **Harness project setup** (`harness/11-11-SPEC-harness-project.md`): the package, tooling for the dependency rules,
   `AGENTS.md`, `ARCHITECTURE.md`, the decision-record format. Short.
2. **Harness part 1** (`harness/11-11-SPEC-harness-v1.md`, Two parts): the core, server mode and the test mode.
   Needed before integration stage 2a.
3. **Harness part 2**: the actual harness. Needed before integration stage 2b and the orchestrator's end-to-end tests.

**After the four main specs:** `billing_required` for native conversations
(`library/todos/11-12-TODO-billing-required-native.md`).

**Once everything is built:** the end-to-end robustness stress test (`11-12-SPEC-end-to-end-robustness.md`), whose
findings refine the specs.

**Then:** the smoke test on the duration-parser fixture and the basic-promise checks (a provider key), evals and the
prompt-injection suite, and phase 2 (long-term memory, the harness's MCP server for members, watches, skills, deferred
tools, worker kinds, sync and backup, removal of the checkpoint-backed identity).

**Blocked on:** a provider key for live runs (no OpenRouter key; the OpenCode Zen key has expired). Everything else
runs offline.
