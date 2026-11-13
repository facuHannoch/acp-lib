# Controller interface: what a conversation needs from its backend

Status: ready for implementation; reviews 1–7 and a final review done 2026-11-12 (checked against `beta`, 0.12.1). First in the library line
(`../11-11-NOTE-overview.md`, Order of work). A refactor with **no new behaviour**: every native piece depends on it,
and its gate is that nothing breaks. Carries over the "provider-session interface" prerequisite of
`../../9-22+/10-17-NOTE-model-call-controller.md` and the 2026-11-09 review.

## Problem

`AgentConversation` is built on `AgentSession` (`src/agent-session.ts`, 5,022 lines), which depends on the concrete
`AgentController` (`src/controller.ts:122`). The nominal contract, `AgentClient` (`prompt`, `interrupt`, `stop`;
`src/agent-client.ts:45`), is much smaller than what the session uses. A second backend (the `NativeController`,
`11-11-SPEC-native-harness-integration.md`) can't be plugged in until that surface is an interface with ACP-only parts
marked optional.

A second problem: one call does two jobs. `controller.prompt()` puts a message in and runs the turn, and its promise
is that turn's result. A native backend also takes turns nobody prompted (a worker reply, another channel), and
decides itself when a message's turn runs. So the interface separates a message going in from a turn running
(overview, decisions 34, 40 and 41), and `AgentSession` runs every turn the same way, whichever backend started it.
Who decides when a turn starts is settled in Appendix A: the backend does, freely.

Decided (overview, decision 6): one `AgentConversation`, the backend chosen by the adapter's type. A separate
conversation type was rejected.

## Scope

**In:** the turn-based `ConversationController` interface (`send`, `subscribeTurns`, `prepareTurn`,
`abandonTurn`); `AgentSession` running every turn from `turn_started`, including turns the backend starts on its
own; public turn completion owned by the session; `runPrompt` moved out of `agent-session.ts` into phases; the
`cause` on `turn_started`; renaming `AgentController` to `HarnessController`; the controller factory; the startup
result and progress contract; capabilities split into what the controller supports and what the backend offers;
a core-only fake controller and the controller conformance suite.

**Out:**

- **Integration stage 2a** (where the native backend needs them): channel holds, `accepted` on the prompt handle, a
  separate "accept a message" step for messages a backend takes on its own, generalizing `provider_sessions`, the
  neutral permission request shape, the model-call record, opaque provider data on messages; anything native.
- **Harness part 1:** the protocol for holds (Appendix A).
- **No new public `send()`.** Today's `PromptHandle` (the result promise plus `id` and `withdraw`) already is "put a
  message in, get its result later": a consumer that doesn't want to wait doesn't await it.

**Behaviour:** none changes for ACP conversations, in any of the three persistence modes (below). Public additions:
`cause` on `turn_started`, `harnessConnection()`, the `HarnessController` name and the new types. Public change: the
type of `connection`. `capabilities` on conversations, sessions and the `HarnessController` keeps its ACP shape
unchanged (the neutral shape has its own name, `conversationCapabilities`).

## The code as it is

What the refactor must preserve, read from the code on 2026-11-12.

**The turn path.** A consumer prompt is queued by `enqueuePrompt` (`src/agent-session.ts:1965`), which mints the turn
id (`mintTurnId`) and returns a `PromptHandle`: the result promise plus `id` (that turn id) and `withdraw`. `pump()`
(line 2253) runs queue items one at a time. For a prompt:

1. `steering.prepareRun` (line 2275) may combine queued steer messages into one run: the run takes the **first**
   message's turn id; each combined message keeps its own id (its queue item's `turnId`, the id its handle returned),
   and steering reports them in `message_delivered { ids }` (`src/steering/controller.ts:209`).
2. `steering.turnStarted`; emit `turn_started { turnId }` (line 2280).
3. `ensureProvider()`; report delivery; `runPrompt(prompt)` (line 3337, about 450 lines).
4. emit `turn_completed { turnId, result }` and resolve; or emit `turn_failed { turnId, error }` and reject (a failure
   before dispatch, such as no provider, takes this path too).
5. `steering.turnEnded`.

**A message settles on its own.** A queued message removed by `withdraw` (`src/steering/controller.ts:251`) or
dropped by an interrupt settles its promise with a cancelled result and no turn (`steering.dropped` and
`cancelledPromptResult`, lines 260–279).

**Startup.** `start(onProgress?)` and `startFresh(onProgress?)` return `ConnectResult { sessionId, resumed }`
(`src/controller.ts:248`, `src/client.ts:162`) and report progress as `AgentControllerStartEvent` (`initialized`
with capabilities; `internal_session_acquired` with the id and `created` or `resumed`; line 81). `AgentSession` uses
both for provider attachment and recovery (lines 1093, 1126, 1164, 1235).

**Streaming and permissions travel through the prompt's handlers.** `controller.prompt(input, handlers)` takes
`PromptHandlers` (`src/types.ts:254`: response chunks, activity, permission requests); `runPrompt` builds wrapped
handlers that record and present. `subscribeOutput` carries only supervision signals (`ProviderOutput`:
updates, requests, permission started and ended; `src/operations/contracts.ts:11`).

Internal commands (`executeInternalSessionCommand`, line 2026) are queued the same way with `operationKind:
"internal_command"`: ordinary turns. Handoff summaries, recaps and post-adoption summaries are **not** turns: they run
through `meteredInternalPrompt` (line ~4087), which calls `controller.prompt` directly, often on a handoff's target
controller (`InternalPromptTarget`, line 307) before it is live, and emits no turn events.

**Three persistence modes,** exclusive, all inside `runPrompt`:

| Mode | When | How the user message is written |
| --- | --- | --- |
| Agent-owned | conversations of an `Agent`: `ownerLifecycle` set, session `persistence: false` (`src/agent/conversation-manager.ts:904`, `:915`) | `ownerLifecycle.beforePrompt`: participants, media, identity `load`, out-of-band messages, the user record in SQLite (`${operationId}:user`, `src/agent/persisted-lifecycle.ts:112`) |
| Managed | `SessionManager` sessions (`v2Transcript`, a `PersistenceStateRuntime`); agents-core uses this path | metered operation opened first (preflight), then `beginOperation`, presentation events for each user text, `syncBeforeDispatch` |
| Detached | an `AgentSession` with neither | `appendTranscript` (legacy JSONL), then the metered operation |

**Ordering constraints:**

- In managed mode the metering preflight runs **before** any durable record ("a strict pricing/policy rejection
  needs no abort record").
- The ACP prompt's content (identity preamble, out-of-band messages, resolved media) is put together inside
  `runPrompt`, just before dispatch.
- User records and presentation ids are keyed by the turn (`<turnId>:user`, `<turnId>:user:2`,
  `message:<turnId>:user`).
- The permission handler is built inside `runPrompt` (line ~3536) and records `permission` requested and resolved
  under the turn.
- The identity delivery receipt is confirmed at the end (`ownerLifecycle.afterPrompt` with
  `identityDeliveryReceipt`).

**Which orders are contractual** (decided 2026-11-13, during A2). Tests assert these strictly:

- each stream keeps its own order: records in sequence-number order, events in emission order;
- a turn's records and metering belong to that turn, each appears once, and record ids are stable;
- metering is recorded after the provider's result;
- the final assistant message is recorded before the turn is announced complete;
- `turn_completed` comes only after metering, the transcript and `afterPrompt` are done.

**Not contractual:** the relative order of metering against a turn's presentation events (managed mode: any of them,
since presentation events are delivered from their own queue and may lag behind metering) or its last in-progress
assistant snapshot record (Agent-owned mode). They are written on separate paths and today's code
fixes no order between them; both orders occur on A1. Making one order hold would be a behaviour change
(`findings/11-13-FINDING-metering-vs-presentation-order.md`), not part of this spec.

**A known hang, accepted for now:** an ACP harness that never answers while connecting or reconnecting leaves its
conversation stuck (the queue and `stop()` wait forever). It is today's behaviour, seen on A1, and a named exception
to the "nothing waits forever" rule for ACP's existing lifecycle; the fix is in
the integration spec (Cancellable connect, stage 2a). A2 keeps the queue waiting on an in-progress reconnect (two
reconnects never overlap), and fails the prompt that triggered it as soon as `send` fails.

**Who uses `AgentController` directly:** `src/agent-session.ts` (18 references), `src/controller.ts`,
`src/internal-inference/runtime/harness-runtime.ts` (6), `src/repl/commands.ts`, `src/cli/index.ts`, `src/index.ts`,
`src/wire-log.ts`; tests `test/commands.test.ts`, `test/internal-inference/harness-runtime.test.ts`.

**Members `AgentSession` uses** (through `this.controller`): `configOptions` 27, `isDegraded` 8, `start` 5,
`startFresh` 5, `setConfig` 5, `currentMode` 4, `setMode` 3, `forceStop` 3, `capabilities` 3, `isConnected` 2,
`currentSessionId` 2, and once each `stop`, `reconnect`, `prompt`, `listSessions`, `cancel`, `bridge`,
`availableCommands`, `authenticate`; plus `subscribeConnection`, `subscribeAvailableCommands`,
`subscribeUsageUpdate` in `bindController`, and `subscribeOutput`, `cancel`, `forceStop`, `cancelGraceMs` through
`supervisedPrompt` (line 4037), which builds a `SupervisedProvider` (`src/operations/supervisor.ts:21`: `prompt`,
`subscribeOutput`, `cancel`, `forceStop`) for the `OperationSupervisor`. The supervisor subscribes to output
**before** it calls `prompt()` (`run()`, line 115), so it sees the first signals. Turns, handoff summaries, recaps and
recovery seeds all go through it, each kind with its own stall limits (`turn`, `recap`, `internal_inference`).

**Tests:** 1,096 tests in 112 files pass in about 90 seconds (`bun test`); `bun run typecheck` is clean. Conversation
tests drive real fake ACP agents (`test/fixtures/*-agent.ts`: echo-prompt, steer, permission, permission-order,
stalling-prompt, usage, identity, config, lifecycle, media, presentation, replay, terminal). Set-ups to copy per mode:
Agent-owned in `test/agent-conversation-*.test.ts`, managed in `test/session-manager-*.test.ts`, detached in
`test/agent-session-*.test.ts`. The repo uses no snapshot tests yet.

## The interface

**The ownership rule: the controller owns provider execution; the session owns the conversation's outcome**, once
supervision, metering and persistence have finished. Every rule below follows from it: the controller reports that
a turn started and runs it; the session decides what the turn means for the conversation, records it and announces
it.

A turn is reported by the controller and run by the session: `send` puts a run of messages in; the controller
reports `turn_started` whenever a turn starts (because of a `send`, or on its own); the session prepares it with
`prepareTurn`, runs it under the supervisor and owns its completion.

**Who chooses a turn's messages** depends on the backend, and the contract says which:

- **Session-scheduled (the `HarnessController`):** the session chooses each run and combines queued steer messages
  into it, as today; the controller runs exactly that run. Cancel-to-steer (cancel the running turn, resend with
  the steer) applies only here.
- **Backend-scheduled (the native controller, later; `nativeSteering: true`):** the session hands messages over; the
  backend decides which turn takes which, and reports it in the cause. The session never combines or cancels to
  steer for it.

| Group | Members | Native backend (later) |
| --- | --- | --- |
| Core (required) | `send`, `subscribeTurns`, `prepareTurn`, `abandonTurn`, `cancel`, `forceStop`, `stop`, `start`, `startFresh`, `isConnected`, `subscribeOutput`, `subscribeConnection`, `cancelGraceMs`, `conversationCapabilities`, `configOptions`, `setConfig`, `subscribeUsageUpdate`, `currentSessionId` | `send` pushes onto the channel; the harness starts turns freely and they are reported; a prepared turn's `prompt()` replays its held output, streams the rest to the session's handlers and resolves at its end; `start` opens the channel; options known before start |
| Optional methods | `prepareInternalPrompt`, `availableCommands` + `subscribeAvailableCommands`, `currentMode` + `setMode`, `reconnect`, `listSessions`, `bridge`, `authenticate` | absent |

```ts
interface ConversationController {
  // turns
  send(run: TurnRun): Promise<void>;               // resolves when the backend has accepted the run
  subscribeTurns(listener: (event: TurnEvent) => void): () => void;
  prepareTurn(turnId: string, content: TurnContent): PreparedTurn;  // starts nothing
  abandonTurn(turnId: string, reason: unknown): void;
  subscribeOutput(listener: OutputListener): () => void;           // controller-wide supervision signals, as today
  cancel(): void;                                                  // cancels the turn executing now, as today
  forceStop(): Promise<void>;                                      // stops the backend itself; controller-wide
  // lifecycle
  start(onProgress?: (event: ControllerStartEvent) => void): Promise<StartResult>;
  startFresh(onProgress?: (event: ControllerStartEvent) => void): Promise<StartResult>;
  stop(): Promise<void>;
  readonly isConnected: boolean;
  subscribeConnection(listener: () => void): () => void;
  readonly cancelGraceMs: number;
  // settings and usage
  readonly configOptions: ConfigOptions;            // may be non-empty before start
  setConfig(id: string, value: unknown): Promise<void>;
  subscribeUsageUpdate(listener: UsageListener): () => void;
  readonly currentSessionId: string | null;
  readonly conversationCapabilities: ConversationCapabilities;
  // optional: absent when the controller type doesn't support them
  prepareInternalPrompt?(content: TurnContent): SupervisedProvider;  // starts nothing; not a turn
  readonly availableCommands?: readonly InternalSessionCommand[];
  subscribeAvailableCommands?(listener: () => void): () => void;
  readonly currentMode?: AgentMode;
  setMode?(mode: AgentMode): Promise<StartResult>;
  reconnect?(sessionId: string): Promise<StartResult>;
  listSessions?(): Promise<SessionListPage>;
  bridge?(...args: Parameters<HarnessController["bridge"]>): ReturnType<HarnessController["bridge"]>;
  authenticate?(...args: Parameters<HarnessController["authenticate"]>): ReturnType<HarnessController["authenticate"]>;
}
interface TurnRun {
  turnId?: string;                      // session-scheduled: the session's id for the run (its first message's id),
                                        // required; backend-scheduled: absent, the backend assigns turn ids
  messageIds: readonly string[];        // every message the run carries (one, or several for a combined steer run)
  operationKind: MeteredOperationKind;
}
interface TurnContent {
  input?: ClientPrompt;                 // what the backend is told; ACP only, built by the session at turn time
  handlers: PromptHandlers;             // the session's recording handlers: stream, activity, permissions; both backends
}
// The supervisor's existing contract (src/operations/supervisor.ts:21), moved to src/operations/contracts.ts:
// interface SupervisedProvider { prompt(): Promise<PromptResult>; subscribeOutput(l): () => void;
//                                cancel(): void; forceStop(): Promise<void> }
interface PreparedTurn extends SupervisedProvider {   // one turn, prepared; prompt() starts it
  readonly turnId: string;
  readonly live: boolean;               // false while replaying output held for a turn that already ended
}
interface TurnStarted { kind: "turn_started"; turnId: string; cause: TurnCause; sentBySession: boolean }
interface TurnTook { kind: "turn_took"; turnId: string; cause: TurnCause }  // more items folded into a running turn
type TurnEvent = TurnStarted | TurnTook;
type TurnCause = { kind: "messages"; messageIds: readonly string[] } | { kind: "items"; items: readonly unknown[] };
type StartResult = ConnectResult;      // { sessionId, resumed }
type ControllerStartEvent = AgentControllerStartEvent;   // renamed, alias kept
```

- **`send(run)`** puts a run in. The `HarnessController` makes no provider call: it reports `turn_started` for the
  run synchronously, inside `send`, with `sentBySession: true`, and returns an already resolved promise. The native
  controller (later) pushes each message to the harness and resolves once the harness has accepted it; the harness
  starts turns as it decides, so `send` promises no turn.
- **A message's queue operation ends when `send` resolves, for a backend-scheduled controller; its turn runs as a
  separate operation.** A turn the backend reports joins the queue as its own operation, so if the operation that
  sent the message waited for that turn, each would wait for the other (a deadlock). The prompt's promise still
  resolves when the turn that took the message ends: it is tied to the message, not to the queue operation (Messages
  settle on their own, below). For the `HarnessController` nothing changes: the turn is reported inside `send` and
  runs within the same operation, as today.
- **`turnId` in a run:** the `HarnessController` requires it (a run without one is an error) and reports the turn
  under it. A backend-scheduled controller ignores it if given: the backend assigns turn ids and reports them in
  `turn_started`.
- **`turn_took`** extends a running turn's cause: a backend-scheduled controller reports it when the backend folds
  more items into a turn already running (native steering). The session adds them to the turn's cause, and a message
  taken this way settles with that turn's finalized result, like one in the original cause. A `turn_took` for a turn
  the session doesn't know, or that has ended, is logged and ignored. The `HarnessController` never reports it.
- **The session registers a run's state before calling `send`,** since the `HarnessController` reports
  `turn_started` inside the call; registering afterwards would miss it.
- **Message ids in a run:** `messageIds` is non-empty and in queue order; an id unknown to the session, or repeated,
  is an error (the controller throws, the session treats it as a bug). In this stage each dispatched message belongs
  to exactly one turn. A cause's ids name messages the session sent; a backend-scheduled cause naming an unknown id
  is recorded and logged, not trusted for settlement.
- **The controller reports only the start of turns, never their end:** `turn_started`, and for backend-scheduled
  controllers `turn_took` (more items folded into a running turn). A turn's end is its prepared turn's `prompt()`
  resolving or rejecting, which is the single authority for the provider's outcome; the public `turn_completed` / `turn_failed`
  are the session's, emitted after finalization (below). A result forced by the supervisor (stall, force stop) goes
  the same way; the controller never announces an outcome of its own.
- **`prepareTurn(turnId, content)`** prepares a reported turn and **starts nothing**. The session hands the
  `PreparedTurn` to the supervisor, which subscribes to its output and only then calls `prompt()`: that call starts
  the provider work (or, for a held turn, the replay of its output) and resolves with the result. This is the
  attachment barrier, the same order the supervisor keeps today, so no first signal (a tool starting, a permission
  request) is missed. The `HarnessController`'s `prompt()` calls today's `controller.prompt(content.input,
  content.handlers)`, unchanged. The native controller ignores `input` (the harness built the context) and drives
  `handlers` from the harness's events.
- **Internal prompts use the same shape.** `prepareInternalPrompt(content)` returns a `SupervisedProvider` that
  starts nothing until `prompt()`. The session runs it through the same supervisor with its own stall limits
  (`recap`, `internal_inference`), cancel escalation and metering, as today; it emits no turn events, because it
  isn't a turn.
- **Supervision and cancel are per turn.** A prepared turn's `subscribeOutput`, `cancel` and `forceStop` are what the
  supervisor uses, never the controller-wide ones. This matters for
  backend-scheduled controllers, where the backend can finish turn B (its output held) and start turn C before the
  session runs B: supervising B must not see C's activity, and interrupting B must not cancel C. Rules:
  - a turn's signals reach only its own prepared turn; signals of a turn whose `prompt()` hasn't been called are held
    with its output and replayed, in order, once it is;
  - `cancel` cancels only that turn, and does nothing if it already ended in the backend (its result is known);
  - while `live` is false (output replayed from the hold) the stall check doesn't apply; it applies from the point
    the turn is live, if it still is;
  - `forceStop` stops the backend itself (controller-wide), and every open prepared turn rejects.

  For the `HarnessController` there is only ever one turn: its prepared turn wraps today's controller-wide
  `subscribeOutput`, `cancel` and `forceStop`, `live` is always true, and nothing changes. It is the wrapper
  `supervisedPrompt` builds today, moved into the controller; the supervisor itself is unchanged.
- **A controller holds a reported turn's output until its `prompt()` is called,** then delivers it in order to
  that turn's handlers. The `HarnessController` never needs this (its turns start inside `prompt()`); the fake and
  the native controller do.
- **`abandonTurn(turnId, reason)`** ends a reported turn the session won't run (the provider connection fails, a
  pre-dispatch record fails, the conversation stops). It releases the controller's bookkeeping for that turn and
  discards any output held for it. It is idempotent (a second call, or a call for a turn already executed, does
  nothing) and it is not a cancel: it never stops provider work; stopping work is `cancel` / `forceStop`. The native
  controller (later) also interrupts the channel's turn, through its own interrupt, not through `abandonTurn`'s
  contract.
- **Startup** keeps today's result and progress: `{ sessionId, resumed }` and the two progress events. The
  contract documents, as today's code behaves:
  - **`resumed: true`** confirms the backend reattached an existing context (the provider has its history);
    `false` means a fresh context, including a resume that fell back to fresh.
  - **A start can succeed without a context.** In PTY mode (`src/controller.ts:574`), and when the connection works
    but creating the session fails, for example because authentication is needed (line 617), `start` resolves
    with `{ sessionId: "", resumed: false }` and the connection stays usable (to log in, then start again). An
    already-running controller with no session returns the same.
  - **Progress:** `initialized` fires once the backend answered its handshake, with its capabilities;
    `internal_session_acquired` fires only when a context actually exists, before `start` resolves.
  - **A rejected start** keeps whatever progress was reported before it failed; the session keeps what it learned
    (attachment and recovery state rely on it), as today.

  Where the session reads `resumed` to decide on seeding from records, it also checks
  `conversationCapabilities.backend?.loadSession`. For native (later): `sessionId` is the harness session id, and `resumed`
  means the channel already had a context. **Reconnecting the shared harness process is not resuming a
  conversation:** the native controller maps them separately.
- **Settings may be known before start.** `configOptions` may be non-empty before `start` and change after it. For
  the `HarnessController` it is empty until the agent reports options, as today; a native controller has them from
  the session's config at once. The contract says so; the session never assumes options appear only after start.
- **Names.** `ConversationController` is what a conversation needs from whatever backs it. Implementations: the
  `HarnessController` (today's `AgentController`, renamed: it drives an external harness, over ACP or a PTY in
  degraded mode) and, later, the `NativeController`. `AgentController` and `AgentControllerStartEvent` stay exported
  as deprecated aliases.
- **The operation-lifecycle guarantees stay above the controller** (`../../9-22+/10-17-SPEC-operation-lifecycle.md`);
  each controller supplies `cancel` and `forceStop`.

## How a turn runs after the refactor

For one ACP prompt, compared with today:

```
today:  pump: emit turn_started → ensureProvider → runPrompt: [content, records, preflight]
              → controller.prompt(content) → [records, metering, afterPrompt] → emit turn_completed
after:  pump: controller.send(run) → the controller reports turn_started (inside send)
              → the session emits turn_started with cause (same moment as today)
              → runTurn: ensureProvider → [content, records, preflight]
              → supervisor(controller.prepareTurn(turnId, content)) → [records, metering, afterPrompt]
              → the session emits turn_completed (same moment as today)
```

- **`runPrompt` moves, intact, to `src/conversation-turns/run-turn.ts`,** organized into phases in today's order
  (prepare content and records per persistence mode; open the metered operation; dispatch through `prepareTurn`
  under the supervisor; assistant records; close metering and transcript; `afterPrompt`). No phase is reordered.
- **Completion is the session's.** `turn_completed` (with the session's `AgentSessionPromptResult`) goes out after
  metering, transcript and `afterPrompt`, as today; `turn_failed` for any failure, before or after dispatch,
  including a provider success followed by a persistence failure. A failure before dispatch calls `abandonTurn` and
  then emits `turn_failed`, as `pump`'s catch does today.
- **The queue waits for the session's finalization,** not for `send` or the provider: the next operation (a prompt,
  a config change, a handoff) starts only after the turn's records, metering and `afterPrompt` are done, as today.
- **`runTurn` takes a turn context, not a queue item:** `{ turnId, cause, messages? }`, where `messages` are the
  originating queued messages with their handlers when the session sent the turn, and absent for a turn the backend
  started from items. ACP preparation (content, user records, the prompt's handlers) runs only when `messages` is
  present; a turn without messages writes no user record and uses the session's own recording handlers.
- **Turns the backend starts on its own** (`sentBySession: false`; none for ACP) join the conversation's operation
  queue as a turn item, so they never overlap another operation, and run when their turn comes: `turn_started` is
  emitted when the item runs, then `runTurn` without the ACP content phase, then completion. The controller holds
  their output meanwhile. Waits are short in practice: long exclusive operations hold the channel first, so the
  backend starts nothing during them (Appendix A; native, stage 2a).
- **Ids.** A message's id is the turn id minted at enqueue (the handle's `id`). A run's turn id is its first
  message's id; `messageIds` lists every message in it (the same list steering reports in `message_delivered`). No
  new ids are minted; record and presentation ids don't change.
- **Messages settle on their own,** directly from the session's message state (never reconstructed from public
  events), as today:

  | What happens to the message | Its prompt's promise |
  | --- | --- |
  | rejected on acceptance (blank participant, conversation stopped) | rejects |
  | withdrawn before dispatch | resolves with today's cancelled result |
  | dropped by an interrupt or queue clearing | resolves with today's cancelled result |
  | taken into a turn that completes | resolves with that turn's finalized `AgentSessionPromptResult` |
  | taken into a turn that fails | rejects, after the failure is finalized |

  Settled entries are released. Withdrawal is local and before dispatch only; for native, removing a message the
  harness already accepted needs the harness's acknowledgement (stage 2a).
- **An ACP message is durable only once its turn starts** (the user record is written then, as today); accepted for
  now and recorded in `findings/11-12-FINDING-acp-message-durability.md`.

**Public API.** `prompt()` and `PromptHandle` are unchanged. `turn_started` gains `cause`. Consumers that want every
turn, including ones nobody prompted, subscgentribe to the conversation's events (`turn_started`, `turn_completed`,
`turn_failed`), as they can today. In stage 2a the handle gains `accepted: Promise<void>` (queued for ACP, stored by
the harness for native), which makes the durability difference visible per backend.

## Capabilities

Two kinds of support, kept apart:

- **What the controller type supports** is the presence of its optional methods. The compiler forces a check
  (`controller.reconnect?.(…)`), so no flags are needed for them.
- **What the backend offers** is data, which can change and may be unknown. It is a new member,
  `conversationCapabilities`; the existing `capabilities` (the raw ACP `Capabilities`) stays on the
  `HarnessController`, `AgentSession` and `AgentConversation` with its shape unchanged, so
  `conversation.capabilities.agent.promptCapabilities` keeps working. `AgentSession.capabilities` delegates to the
  `HarnessController`'s getter through `harnessConnection()`, so it returns the same value and throws in the same
  cases as today (before the agent connects, and in PTY mode: `requireAcp()`, `src/controller.ts:207`). Inside the
  library, the readers of
  `.capabilities.agent` (`src/agent-session.ts:3357` media, `:4516` session listing,
  `src/agent/adoption/provider-sessions.ts:50`) move to `conversationCapabilities.backend`; the REPL
  (`src/repl/commands.ts:138`) keeps the ACP getter through `harnessConnection()`. When a native conversation exists
  (stage 2a) it has no ACP capabilities: the public `capabilities` then becomes `Capabilities | null`, a breaking
  change made and documented there.

```ts
interface ConversationCapabilities {
  nativeSteering: boolean;             // steer by injecting into the running turn; false for the HarnessController
  backend: BackendCapabilities | null; // null when unknown: before the agent's initialize, and in PTY mode
}
interface BackendCapabilities {
  loadSession: boolean;                // can reattach to a provider session with its context
  forkSession: boolean;
  listSessions: boolean;
  media: { image: boolean; audio: boolean; file: boolean };
  mcpServers: { stdio: boolean; http: boolean; sse: boolean };
  acp?: Capabilities;                  // the raw ACP initialize result
}
```

The `HarnessController` fills `backend` from the ACP `initialize` result (`fromAcp`), `null` before it and in PTY
mode. A native controller fills it from the session's config at once (the model's media, no load or fork). The
session re-reads capabilities after `start`, after a mode switch and after a handoff (the controller changes).

**Every optional member and its guard:**

| Member | Present on | Guard before calling | When unsupported |
| --- | --- | --- | --- |
| `prepareInternalPrompt` | `HarnessController` | method present | the caller skips the internal prompt (handoff without a summary) |
| `availableCommands`, `subscribeAvailableCommands` | `HarnessController` | method present | no commands |
| `currentMode`, `setMode` | `HarnessController` | method present | no mode switch (`degraded` not offered) |
| `bridge` | `HarnessController` | method present (the controller chooses: the live PTY in degraded mode, a temporary PTY in normal mode that leaves the ACP session untouched; `src/controller.ts:303`) | absent |
| `reconnect` | `HarnessController` | method present | recovery paths skip it (gated with continuation) |
| `listSessions` | `HarnessController` | method present and `backend?.listSessions` | empty list |
| `authenticate` | `HarnessController` | method present | `UnsupportedError` |
| session load with replay, fork | `HarnessController` | `backend?.loadSession` / `forkSession` | the continuation path runs as today when unsupported |
| media in a prompt | both | `backend?.media`; PTY keeps today's degraded rule | as today |

Paired members are present together or not at all (`currentMode` with `setMode`, `availableCommands` with
`subscribeAvailableCommands`); the contract documents each pair.

**Support is not readiness.** A present method says the controller type can do it; whether it can right now
depends on the state: `authenticate`, `listSessions` and `reconnect` need a connected agent, and `backend` says what
the connected agent offers. `bridge` works in both modes. So:

- reading `conversationCapabilities` and checking for a method is always safe, before connecting and in PTY mode;
- availability is re-evaluated after `start`, a reconnect, a mode switch and a controller replacement (handoff);
- a call that isn't possible fails **before** the session opens any metered or durable operation for it;
- existing ACP errors (`NotConnectedError` and the rest) stay as they are for ACP paths.

`UnsupportedError` (`src/errors.ts`, new) is thrown by a controller asked for something it can't do; callers guard
first, so it signals a bug.

## Seams and files

| Seam | Where | Change |
| --- | --- | --- |
| Field | `private controller: AgentController` (line 491) | typed `ConversationController` |
| Startup | `controller.start` / `startFresh` (lines 1093, 1126, 1164, 1235) | `StartResult` and `ControllerStartEvent`; unchanged shapes |
| Creation | `createController` (line 733) | through `factory.ts`; only `Adapter` → `HarnessController` exists in this spec |
| Binding | `bindController` (line 742) | typed on the interface; commands only if `subscribeAvailableCommands` is present; subscribes to turn events |
| Turn dispatch | `pump`'s prompt branch (line 2253) | calls `controller.send(run)`; the turn runs from `turn_started`; reported turns not sent by the session become queue items |
| Turn execution | `runPrompt` (line 3337) → `controller.prompt` | moved to `run-turn.ts`; runs `controller.prepareTurn(...)` under the supervisor |
| Handoff targets | `handoff` creates a target controller (around line 2460) | through the factory |
| Degraded-mode switch | `runSetMode` (line 3218) recreates the controller | only if `setMode` is present (`HarnessController`) |
| Internal prompts | `meteredInternalPrompt` (line ~4087) on `InternalPromptTarget.controller` (line 307) | `prepareInternalPrompt`, if present, under the same supervisor with its own limits |
| Supervision | `supervisedPrompt` (line 4037) | takes a `SupervisedProvider` (a prepared turn or internal prompt) instead of building one from the controller; `OperationSupervisor` unchanged |
| Capability readers | `.capabilities.agent` at lines 3357, 4516; `src/agent/adoption/provider-sessions.ts:50` | `conversationCapabilities.backend`; the public `capabilities` getter unchanged |
| Public escape hatch | `get connection(): AgentController` (line 1897) | returns `ConversationController`; `harnessConnection(): HarnessController \| null` added |

```
src/conversation-controller/
  contracts.ts       ConversationController, TurnRun, TurnContent, PreparedTurn, TurnStarted, TurnCause, StartResult
  capabilities.ts    ConversationCapabilities, BackendCapabilities; fromAcp()
  factory.ts         adapter → controller
  index.ts
src/conversation-turns/
  run-turn.ts        runPrompt, moved, in phases (split by phase into files if over ~400 lines)
  context.ts         the narrow context object run-turn receives from AgentSession
  index.ts
src/controller.ts    AgentController → HarnessController, implements ConversationController; alias export
src/operations/contracts.ts  SupervisedProvider, moved here from supervisor.ts (re-exported there)
src/errors.ts        UnsupportedError
src/index.ts         exports the new types, HarnessController, the aliases
test/conversation-controller/
  fake-controller.ts a core-only fake
  conformance.ts     the suite every controller passes
test/conversation-turns/
  characterization.test.ts  written before the refactor (Brief A1)
  normalize.ts              makes captured sequences stable
CHANGELOG-controller-interface.md
```

- **`agent-session.ts` must end shorter than 5,022 lines** (expected: about 4,550 or less, with `runPrompt` moved
  out); capability checks are guards, not new paths.
- `run-turn.ts` receives what it needs through the narrow context object (the controller, persistence, presentation,
  metering, steering, owner lifecycle, logger), not the whole session.

## Implementation briefs

Four briefs, each about one agent run. Line numbers are as of the baseline (`beta`, 0.12.1); after A2 moves code,
find places by name. Gates use `bun run typecheck` and `bun test`; the baseline is a clean
typecheck and 1,096 passing tests in 112 files. Commit after each step with explicit paths
(`git commit -- <paths>`), never `git add -A`. No live harness runs are needed.

### Brief A1: characterization tests

**Scope:** tests only, against today's code. Must not touch anything under `src/`.

1. **`test/conversation-turns/normalize.ts`:** turns a captured run into a stable value. Replace UUIDs, minted ids
   and timestamps with placeholders numbered by first appearance (`<id:1>`, `<ts>`), keeping equal ids equal so
   relations stay visible; drop durations and process ids.
2. **`test/conversation-turns/characterization.test.ts`,** with the set-ups the existing tests use (Agent-owned:
   `test/agent-conversation-*.test.ts`; managed: `test/session-manager-*.test.ts`; detached:
   `test/agent-session-*.test.ts`) and the fixture agents. Cases that write records run in **all three modes**, since
   records are where the modes differ; the others run **once**, in an Agent-owned conversation unless noted. The
   first group, in all three modes:
   - a plain prompt (echo-prompt agent);
   - a second prompt queued behind a running one;
   - two steer messages combined into one run (steer agent);
   - an interrupt of the running turn;
   - a stalled prompt (stalling-prompt agent, a short stale policy);
   - a permission request answered through the handler (permission agent);
   - an internal command (`executeInternalSessionCommand`);
   - a handoff with a summary (managed and Agent-owned only).

   Once each:
   - a queued message withdrawn, its promise awaited (cancelled result);
   - an interrupt that drops queued messages, their promises awaited;
   - a provider that fails to start (the prompt rejects, `turn_failed`);
   - a PTY start (`idle-pty-agent`): `start` resolves with an empty session id and no `internal_session_acquired`;
   - a connection whose session creation fails because authentication is needed: `start` resolves with an empty
     session id, the connection stays usable, no `internal_session_acquired` (add a fixture mode under
     `test/fixtures/` if no agent can do this);
   - `bridge` from degraded mode and from normal mode (the temporary PTY), at least asserting which path runs and
     that the ACP session is untouched in normal mode; if driving a terminal isn't possible in tests, assert the
     path chosen and report the limit;
   - `conversation.capabilities.agent.promptCapabilities` read before and after start (today it throws before
     the agent connects);
   - an internal prompt that stalls (a handoff summary under a short `internal_inference` limit) and one cancelled
     by force: metering recorded, the cancel escalation as today, and no `turn_*` events;
   - a permission request or tool start sent by the agent the instant the prompt reaches it: the operation's stage
     events show it (the supervisor saw it).

   Each case captures: the conversation's events (kind, ids, order; the `turn_*`, `message_delivered` and
   `message_withdrawn` events and the record events), the records written, read back the way each mode stores them
   (Agent-owned: the agent's persistence readers as the existing tests use them; managed: the session's persisted
   transcript and records; detached: the JSONL transcript), and the prompt results. Compare with
   `expect(normalize(run)).toMatchSnapshot()` and commit the `__snapshots__` files.
3. **Self-check:** run the file three times; the snapshots must not change between runs.

**Gate:** typecheck clean; full suite green (1,096 + the new cases); three runs identical.
**Done:** report the cases per mode, any case that couldn't be written in a mode and why, and the commit. If the
whole set doesn't fit one run, commit the all-modes group first (it guards A2), then the rest.

### Brief A2: the turn path through `send`, `prepareTurn` and `abandonTurn`

**Scope:** steps 1–4, on top of A1. Must not touch: records and schemas, `src/persistence/`, the adoption,
continuation and recovery paths except to call the moved code, the A1 snapshot files except in step 4's own commit.

1. **Move `runPrompt`** into `src/conversation-turns/run-turn.ts` with the context object, in phases, in today's
   order; `AgentSession` calls it. **Gate:** suite green; A1 snapshots unchanged.
2. **Contracts:** `src/conversation-controller/contracts.ts` with the turn members, the types (including `TurnTook`
   and the optional `turnId`) and doc comments.
   **Gate:** typecheck.
3. **`AgentController` gains `send`, `subscribeTurns`, `prepareTurn`, `prepareInternalPrompt` and `abandonTurn`**
   (its `prompt` stays): `send` reports `turn_started` synchronously with `sentBySession: true`; `prepareTurn` and
   `prepareInternalPrompt` return a `SupervisedProvider` whose `prompt()` calls today's `prompt` with the content's
   input and handlers, wrapping today's controller-wide output, cancel and force stop; `supervisedPrompt` takes it;
   `SupervisedProvider` moves to `src/operations/contracts.ts`; `abandonTurn` clears its bookkeeping, idempotently. **Gate:** suite green.
4. **`AgentSession` drives turns through them:** the session registers the run's state, then `pump` calls `send(run)`
   with the run's message ids; `run-turn.ts` takes a turn context (`{ turnId, cause, messages? }`) instead of the
   queue item, with today's preparation running when `messages` is present; the session
   emits `turn_started` with `cause` when the controller reports it; `run-turn.ts` dispatches through `prepareTurn`
   under the supervisor; completion stays the session's, after finalization; a failure before dispatch calls
   `abandonTurn`. **Gate:** suite green; A1 snapshots unchanged except the added `cause` field, updated in a commit
   of its own whose diff shows only `cause`. New tests: a combined steer run's cause lists both message ids while
   record ids stay keyed by the turn; a provider-connection failure calls `abandonTurn`, emits `turn_failed` and
   rejects the prompt; a finalization failure after the provider finished emits `turn_failed`, not
   `turn_completed`; a config change queued behind a turn starts only after that turn's finalization (a slow
   `afterPrompt` delays it); a duplicate or unknown message id in a run throws.

**Done:** report the commits, test count and time, the `agent-session.ts` line count, and any place the order of
operations had to change (expected: none).

### Brief B1: capabilities, the rename, the session on the interface

**Scope:** steps 1–4, on top of A2. Must not touch: ACP behaviour, records, persistence, the A1 snapshot files.

1. **Capabilities:** `capabilities.ts` with `fromAcp`; `UnsupportedError`; `conversationCapabilities` next to the
   unchanged `capabilities`; the internal `.capabilities.agent` readers moved. **Gate:** typecheck; suite green; the
   A1 capability case unchanged.
2. **Rename** `AgentController` to `HarnessController` and `AgentControllerStartEvent` to `ControllerStartEvent`
   across the files listed above; keep both old names as deprecated aliases; `HarnessController` declares
   `implements ConversationController`. **Gate:** suite green.
3. **`AgentSession` on the interface:** the field and every seam in the table typed `ConversationController`; every
   optional member behind its guard (the capabilities table); capabilities re-read after start, mode switch and
   handoff; `connection` returns the interface, `harnessConnection()` added; new exports in `src/index.ts`.
   **Gate:** suite green; snapshots unchanged; no `HarnessController` type in `agent-session.ts` or
   `src/conversation-turns/` outside the factory and `harnessConnection`.
4. **Factory:** `createController` and handoff targets through `factory.ts`. **Gate:** suite green.

**Done:** report the commits, test count and time, `agent-session.ts` line count, and every guard added with the
member it guards.

### Brief B2: turns the backend starts and the conformance suite

**Scope:** steps 5–6, on top of B1. Must not touch: ACP behaviour, records, persistence, the A1 snapshot files.

5. **Turns the backend starts:** a reported `turn_started` with `sentBySession: false` becomes a queue item and runs
   in order, through `runTurn` with no `messages`: no user record, the session's recording handlers, supervision and
   metering attached to that turn. A `turn_took` extends the cause of the turn it names and settles the messages it
   lists with that turn's result. **Gate:** suite green (no ACP path reaches it).
6. **Fake controller and conformance suite:** `fake-controller.ts` implements only the core: `send` reporting turns,
   `prepareTurn` with scripted output and results delivered to the handlers once `prompt()` is called, a script step
   that starts a turn on its own (holding its output until its `prompt()`), cancel, force stop, usage, options before start. `conformance.ts`
   runs a conversation on any controller:
   - prompt; queue and steer delivery with the cause; withdraw and interrupt settling queued prompts;
   - interrupt, force stop, stale detection;
   - a turn that never executes (`abandonTurn`, `turn_failed`);
   - usage recorded, records written, completion after finalization;
   - **a turn the backend starts on its own** with no preceding `send`, while a prompt runs: it waits, then runs;
     its held output arrives in order and belongs to that turn; it is supervised and metered; no user record is
     written for it; it completes after finalization (fake only);
   - the same turn failing, the conversation stopping while it waits, and the controller being replaced (handoff)
     while it waits: each leaves nothing unsettled and no held output behind (fake only);
   - late output arriving after a force stop is dropped, not recorded on the next turn;
   - finalization that is slow to finish: completion and the next operation both wait for it;
   - `turn_started` reported synchronously inside `send` is not missed;
   - **`turn_took`** (fake only): a message sent while a fake turn runs and folded into it settles with that turn's
     result; a `turn_took` for an unknown or ended turn is ignored; the `HarnessController` rejects a run without a
     `turnId`;
   - **the attachment barrier:** `prepareTurn` starts nothing; a prepared turn that emits a permission or tool
     boundary the instant `prompt()` is called has it seen by the supervisor (stage and stall timer right), also for
     a held turn whose replay begins with such a boundary (fake only);
   - an internal prompt prepared through `prepareInternalPrompt` is supervised with its own limits and emits no turn
     events;
   - options available before start (fake only);
   - **per-turn supervision** (fake only): the backend finishes turn B (held) and starts turn C before the session
     runs B; B's supervisor never sees C's signals; cancelling B leaves C running; B replayed from the hold doesn't
     stall; `forceStop` rejects both prepared turns.

   It runs against the fake and against the `HarnessController` with the echo-prompt fixture agent in an
   Agent-owned conversation (backend-started and fake-only cases are skipped for it). Changelog completed (`connection` type, renames, aliases, `harnessConnection`, new
   types). **Gate:** both pass; suite green.

**Done:** report the commits, test count and time, and each conformance case with the controllers it ran on.

## Acceptance

- Typecheck clean; the full suite passes (at least the 1,096 baseline tests plus the new ones).
- The A1 snapshots are unchanged except for the added `cause` field, in one commit showing only that.
- The conformance suite passes on the core-only fake and on the `HarnessController`, including a turn the fake
  starts on its own. Passing it shows the session handles backend-started turns; it does not show that native policy
  is enforced (Appendix A, Limitations).
- `agent-session.ts` is shorter than 5,022 lines; no ACP type is used in it outside guarded paths, the factory,
  `harnessConnection` and the public `capabilities` getter (kept for compatibility).
- `CHANGELOG-controller-interface.md` lists every public change.

## Risks

- **Order changes in the turn path.** The managed-mode preflight, the moment `turn_started` is emitted and the
  user-record ids are the likely places. Sign: an A1 snapshot changes in order or ids. Fix the order, never the
  snapshot.
- **The one allowed snapshot exception (A2).** For the two non-contractual cases only, the characterization tests
  accept the observed alternatives: in managed mode, the turn's metering event may appear anywhere among that turn's
  presentation events, but only after its `turn_started` and before its `turn_completed` (widened 2026-11-13 after
  `M → P1 → P2` was observed: metering ahead of the in-progress presentation, not only the completed one); in
  Agent-owned mode, metering vs. the last in-progress assistant snapshot record, either order. The presentation
  events' own order (in-progress before completed), stable ids, metering exactly once, and `turn_completed` after
  both metering and the turn's last presentation event stay strict. Everything else stays strict (content, ids, order within each
  stream, sequence numbers), and the contractual orders get explicit assertions of their own. Where a test is about a
  specific sequence, it waits on an event barrier instead (as A1's instant-tool case does). This is one dedicated
  commit, reviewed. Before the gate, the affected cases run many times (about 50) on A1 and on A2, and the frequency
  of each order is compared; a noticeable shift means A2 changed timing in the turn path and is investigated.
- **A reported turn left open.** If `send` reports `turn_started` and the turn then fails before its `prompt()` is called, the
  turn must still be abandoned and end with `turn_failed`, and steering's `turnEnded` must still run. Covered by the
  A2 step 4 tests and the conformance suite.
- **Completion announced before finalization.** Sign: `turn_completed` emitted before `afterPrompt` or with the raw
  `PromptResult`. Covered by the A2 finalization-failure test.
- **Code no production path uses.** Turns the backend starts are only exercised by the fake until stage 2a. The
  conformance suite keeps them honest; stage 2a runs the same suite on the native controller.
- **Hidden coupling in `runPrompt`.** Closures over session fields (presentation, metering state, `ownerRecordWrite`,
  `providerFailedTurnId`) can make the context object grow. Sign: it passes most of the session. Then move smaller
  pieces first rather than pass the session.
- **Steering combine.** The cause must list each combined message's id and `withdraw` must keep working for messages
  not yet dispatched. Covered by A1 and the A2 step 4 tests.
- **The managed path is agents-core's.** Breaking it breaks the only consumer. The `session-manager-*` tests and the
  managed A1 cases must stay green.
- **Snapshot flakiness.** Timing-dependent cases (stall, interrupt, queued) can capture events in varying order. Sign:
  the A1 three-run check differs. Then wait on explicit events in the test, never loosen the snapshot.

## Appendix A: who starts a turn

**Decision (2026-11-12): the backend starts turns freely; the host never grants them.** For ACP this changes
nothing (the session sends every turn). For native, the harness decides when a channel takes a turn: a message, a
worker reply, another channel, later its own background work. acp-client records and runs what it reports.

How the guarantees that today depend on acp-client starting every turn are kept:

1. **One thing at a time per conversation.** The harness runs one turn at a time per channel. acp-client puts
   reported turns into the conversation's operation queue, so a turn never overlaps another operation. For the rare
   exclusive operations (a handoff out of native, a stop, a delete) acp-client first **holds** the channel: the
   harness starts nothing on it until released; a running turn is waited for or interrupted, depending on the
   operation.
2. **Turn 1 is recorded before turn 2.** acp-client handles each conversation's turns in order, locally; the
   controller holds turn 2's output until the session runs it. No protocol step.
3. **Costs.** The harness reports every model call's usage, in turns and outside them (compaction), and acp-client
   meters each at billing grade (integration spec, Billing-grade metering). Spending limits are the consumer's,
   outside; a cap enforced by the library is deferred (`todos/11-13-TODO-spending-cap.md`, revised 2026-11-13).
4. **A deleted conversation starts nothing new:** its channel is closed. A stopped one is only unloaded: the backend
   may still run turns on its channel (a worker reply, another channel's trigger), which reload it (integration spec,
   Limitations).

Where it is built: holds in harness part 1 (protocol `channel/hold`, `channel/release`);
their use in integration stage 2a. This spec only needs the session to accept turns
the backend starts, which the fake exercises.

### Limitations

- **acp-client can't refuse a turn before it starts.** The metering preflight can still reject a turn the session
  sends (ACP), but not one the harness starts. Budget refusals rely on the harness guard; other refusals on changing
  the channel's policy or holding the channel.
- **Budget accuracy.** The guard sees each call's usage after it happens; a turn can overshoot a limit by its last
  call. The same is true today for ACP.
- **A turn can start just as a hold is requested.** The hold then waits for that turn or interrupts it; the
  operation waits that long.
- **Short waits inside acp-client.** A reported turn that arrives while another operation runs waits in the queue,
  with its output held. Holds keep long operations from causing long waits, but a slow non-exclusive operation (a
  config change waiting on its own provider call) still delays the turn's recording and its events to the consumer.
  The agent's work itself is not delayed.
- **Two logs can disagree.** If recording fails after the harness finished a turn, the harness's context contains it
  while acp-client records a failure ("completed by the backend, recording failed"). acp-client's records are the
  observation log; the harness's context is what the agent knows.
- **Every exclusive operation must remember to hold.** A new operation that needs the channel to itself and forgets
  to hold can overlap a turn. The rule goes in the integration spec, and stage 2a's tests cover each exclusive
  operation.
- **Local per-turn checks can't prevent native spending.** Holding a reported turn's output until the session runs
  it keeps the order of what is observed; it does not stop the harness from executing or spending meanwhile. Stage
  2a needs an explicit policy for each check the session makes before an ACP turn:
  - **budget rejection:** none in the library (there is none today either); the consumer enforces limits from the
    metering, as above;
  - **stale configuration:** the harness may run a turn on settings acp-client is about to change; a setting change
    applies from the next model call, and stage 2a states whether a pending change holds the channel first;
  - **unhealthy persistence:** the harness keeps working while acp-client can't record; stage 2a decides whether
    acp-client holds its channels until persistence recovers (recommended) or records late.
- **Per-turn approval is not possible.** A consumer that wants to approve each turn (an approval workflow) can't with
  this design; it would need the grant (below).

### Alternatives considered

- **The grant.** The harness asks before each turn; acp-client answers when the conversation is free. One rule
  covers every guarantee and acp-client can refuse turns, but each native turn waits a round trip, a busy or stuck
  host mutes the agent, the harness needs a waiting state with timeouts and refusal reasons, and the harness stops
  being self-sufficient in how it acts. Revisit if a channel gets several hosts or consumers need per-turn approval.
- **Acknowledged turns (open for stage 2a).** The harness starts a channel's next turn only after acp-client
  confirms it processed the previous one. At most one turn per channel is then ever in flight between them, so no
  output is held for a finished turn while the next runs; per-turn supervision (`PreparedTurn`) stays correct
  either way. The cost: the agent's next turn waits for acp-client's finalization (usually milliseconds, longer with
  slow persistence). Decide in stage 2a.
- **Concurrency without holds.** Turns run whenever the harness wants and acp-client records them as they come. No
  ordering against handoffs or stops; rejected.
- **Buffering only.** acp-client holds every reported turn's output until it may run, with no holds. Output goes
  stale, permission requests sit unanswered, and preflight still can't refuse; rejected as the main mechanism (it
  stays for the short waits above).

## Appendix B: acp-client as a holder of conversations

A framing for later revision, not a change. acp-client is converging on a holder of conversations: it keeps each
conversation's records, order, participants, permissions, metering and delivery to people, and the parties talk on
it: the user (through the consumer's code), the backend that answers (an ACP harness or the native harness), workers
through the orchestrator. For native there are two holders with different jobs: acp-client holds the conversation
(what was said, in what order, for whom); the harness holds the agent's memory of it (context, inbox, timeline). This
is the "two logs" decision seen from another side. It may later justify treating ACP harnesses as one more party on
a conversation.
