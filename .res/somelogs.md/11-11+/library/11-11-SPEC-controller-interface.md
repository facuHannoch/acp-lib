# Controller interface: what a conversation needs from its backend

Status: agreed, not started; reviews 1–3 done 2026-11-12 (checked against `beta`, 0.12.1). First in the library line
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
(overview, decisions 34 and 40), and `AgentSession` runs every turn the same way, whichever backend started it.

Decided (overview, decision 6): one `AgentConversation`, the backend chosen by the adapter's type. A separate
conversation type was rejected.

## Scope

**In:** the turn-based `ConversationController` interface (`send`, `subscribeTurns`, `executeTurn`); `AgentSession`
running every turn from `turn_started`; `runPrompt` moved out of `agent-session.ts` into phases; `send()` and the
`cause` on turn events for consumers; renaming `AgentController` to `HarnessController`; the controller factory;
neutral capabilities and capability checks; a core-only fake controller and the controller conformance suite.

**Out (integration stage 2a, where the native backend needs them):** a separate "accept a message" step for messages
a backend takes on its own; generalizing `provider_sessions`; the neutral permission request shape; the model-call
record; opaque provider data on messages; anything native.

**Behaviour:** none changes for ACP conversations, in any of the three persistence modes (below). Public additions:
`send()`, `cause` on `turn_started`, `harnessConnection()`, the `HarnessController` name and the new types. Public
change: the type of `connection`.

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

**Who uses `AgentController` directly:** `src/agent-session.ts` (18 references), `src/controller.ts`,
`src/internal-inference/runtime/harness-runtime.ts` (6), `src/repl/commands.ts`, `src/cli/index.ts`, `src/index.ts`,
`src/wire-log.ts`; tests `test/commands.test.ts`, `test/internal-inference/harness-runtime.test.ts`.

**Members `AgentSession` uses** (through `this.controller`): `configOptions` 27, `isDegraded` 8, `start` 5,
`startFresh` 5, `setConfig` 5, `currentMode` 4, `setMode` 3, `forceStop` 3, `capabilities` 3, `isConnected` 2,
`currentSessionId` 2, and once each `stop`, `reconnect`, `prompt`, `listSessions`, `cancel`, `bridge`,
`availableCommands`, `authenticate`; plus `subscribeConnection`, `subscribeAvailableCommands`,
`subscribeUsageUpdate` in `bindController`, and `subscribeOutput`, `cancel`, `forceStop`, `cancelGraceMs` through
`supervisedPrompt` (line 4037).

**Tests:** 1,096 tests in 112 files pass in about 90 seconds (`bun test`); `bun run typecheck` is clean. Conversation
tests drive real fake ACP agents (`test/fixtures/*-agent.ts`: echo-prompt, steer, permission, permission-order,
stalling-prompt, usage, identity, config, lifecycle, media, presentation, replay, terminal). Set-ups to copy per mode:
Agent-owned in `test/agent-conversation-*.test.ts`, managed in `test/session-manager-*.test.ts`, detached in
`test/agent-session-*.test.ts`. The repo uses no snapshot tests yet.

## The interface

A turn is two calls on the controller: `send` puts a message in, and `executeTurn` runs a turn the controller has
reported. `AgentSession` runs every turn from the controller's `turn_started`.

| Group | Members | Native backend (later) |
| --- | --- | --- |
| Core (required) | `send`, `subscribeTurns`, `executeTurn`, `cancel`, `forceStop`, `stop`, `start`, `startFresh`, `isConnected`, `subscribeOutput`, `subscribeConnection`, `cancelGraceMs`, `capabilities` | `send` pushes onto the channel; turns are reported as the harness starts them; `executeTurn` waits for the harness's end of turn; `forceStop` abandons the turn if the process doesn't answer; `start` opens the channel |
| Generalized | `configOptions`, `setConfig`, `subscribeUsageUpdate`, `currentSessionId`, `availableCommands`, `subscribeAvailableCommands` | per-channel settings in the `ConfigOption` shape; usage from every model call; no commands at first |
| Optional, behind capabilities | `runInternalPrompt` (a prompt outside any turn: handoff summaries, recaps, post-adoption summaries), `isDegraded`, `currentMode`, `setMode`, `reconnect`, `listSessions`, `bridge`, `authenticate`; session load with replay and session delete | absent; callers check capabilities |

```ts
interface ConversationController {
  send(message: OutgoingMessage): Promise<{ messageId: string }>;
  subscribeTurns(listener: (event: TurnEvent) => void): () => void;
  executeTurn(turnId: string, content?: TurnContent): Promise<PromptResult>;
  subscribeOutput(listener: OutputListener): () => void;           // the stream inside a turn, as today
  cancel(): void;
  forceStop(): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  startFresh(): Promise<void>;
  readonly isConnected: boolean;
  readonly cancelGraceMs: number;
  readonly capabilities: ConversationCapabilities;
  subscribeConnection(listener: () => void): () => void;
  // generalized and optional members as in the table
}
interface OutgoingMessage {
  messageId: string;            // minted by the session (today's turn id at enqueue)
  operationKind: MeteredOperationKind;
}
type TurnContent = Parameters<HarnessController["prompt"]>[0];   // what today's prompt call takes
type TurnEvent =
  | { kind: "turn_started"; turnId: string; cause: TurnCause }
  | { kind: "turn_completed"; turnId: string; result: PromptResult }
  | { kind: "turn_failed"; turnId: string; error: unknown };
type TurnCause = { kind: "messages"; messageIds: string[] } | { kind: "items"; items: unknown[] };
```

- **`send`** tells the backend a message is in. The `HarnessController` makes no provider call: it reports
  `turn_started` for that message at once, synchronously, before `send` resolves. The native controller (later)
  pushes the message to the harness, which reports the turn when it starts it.
- **`executeTurn(turnId, content)`** runs a reported turn and resolves with its result. The `HarnessController`
  prompts the provider with `content` (today's `controller.prompt(content)`, unchanged) and reports
  `turn_completed` or `turn_failed`. The native controller ignores `content` (the harness built the context) and
  resolves when the harness ends the turn. The supervisor wraps `executeTurn` exactly as it wraps `prompt` today.
- **A turn reported but never executed** (the provider connection fails, a pre-dispatch record fails) is ended by
  the session through the controller as `turn_failed`, as `pump`'s catch does today. The conformance suite tests it.
- **`PromptResult`** is the controller's result type, as today; the session maps it to `AgentSessionPromptResult`.
- **Names.** `ConversationController` is what a conversation needs from whatever backs it. Implementations: the
  `HarnessController` (today's `AgentController`, renamed: it drives an external harness, over ACP or a PTY in
  degraded mode) and, later, the `NativeController`. `AgentController` stays exported as a deprecated alias.
- **Optional members are capabilities, not stubs:** `AgentSession` checks before calling.
- **The operation-lifecycle guarantees stay above the controller** (`../../9-22+/10-17-SPEC-operation-lifecycle.md`);
  each controller supplies `cancel` and `forceStop`.

## How a turn runs after the refactor

For one ACP prompt, compared with today:

```
today:  pump: emit turn_started → ensureProvider → runPrompt: [content, records, preflight] → controller.prompt(content)
                                                              → [records, metering] → emit turn_completed
after:  pump: controller.send(message) → the controller reports turn_started (same moment as today)
        session on turn_started → runTurn: ensureProvider → [content, records, preflight]
                                  → controller.executeTurn(turnId, content) → [records, metering]
        the controller reports turn_completed
```

- **`runPrompt` moves, intact, to `src/conversation-turns/run-turn.ts`,** organized into phases in today's order
  (prepare content and records per persistence mode; open the metered operation; dispatch through `executeTurn`
  under the supervisor; assistant records; close metering and transcript; `afterPrompt`). No phase is reordered. A
  separate "accept a message" step is not needed for ACP, where a message and its turn are one; it comes in stage 2a
  for messages the harness takes on its own.
- **Ids.** A message's id is the turn id minted at enqueue (the handle's `id`). A turn's id is its first message's id.
  So for a single prompt the two are the same value; for a combined steer run the cause lists every combined
  message's id (the same list steering already reports in `message_delivered`). No new ids are minted; record and
  presentation ids don't change.
- **An ACP message is durable only once its turn starts** (the user record is written then, as today); accepted for
  now and recorded in `findings/11-12-FINDING-acp-message-durability.md`.
- **The consumer-facing events** on the conversation are the session's re-emission of the controller's turn events,
  at the same moments and with the same fields as today, plus `cause` on `turn_started`.

**Public API.**

- `prompt()` stays the main consumer method and behaves exactly as today.
- `send(message)` is new: same inputs as `prompt` (text, parts, attachments, participant, consumer metadata,
  delivery); resolves with `{ messageId }` once queued, not once saved; `withdraw()` works as on a prompt handle.
- `prompt()` becomes `send()` plus waiting for the turn whose cause includes the message.
- Consumers that want every turn subscribe to the conversation's events (`turn_started`, `turn_completed`,
  `turn_failed`), as they can today.

## Neutral capabilities

`Capabilities` today is ACP's `initialize` result; `AgentSession` reads `capabilities.agent.promptCapabilities` for
media and `isDegraded` for PTY. Add a neutral layer:

```ts
interface ConversationCapabilities {
  loadSession: boolean;
  forkSession: boolean;
  listSessions: boolean;
  modes: boolean;               // currentMode / setMode
  degradedMode: boolean;        // PTY fallback
  commands: boolean;            // availableCommands
  internalPrompts: boolean;     // runInternalPrompt
  nativeSteering: boolean;      // false for the HarnessController
  media: { image: boolean; audio: boolean; file: boolean };
  mcpServers: { stdio: boolean; http: boolean; sse: boolean };
  acp?: AcpCapabilities;        // the raw initialize result
}
```

The `HarnessController` derives it from the ACP `initialize` result (`fromAcp`), so every check is true exactly where
the code works today. Capability checks are added where `AgentSession` calls an optional member; for the
`HarnessController` they always pass.

## Seams and files

| Seam | Where | Change |
| --- | --- | --- |
| Field | `private controller: AgentController` (line 491) | typed `ConversationController` |
| Creation | `createController` (line 733) | through `factory.ts`; only `Adapter` → `HarnessController` exists in this spec |
| Binding | `bindController` (line 742) | typed on the interface; commands only with the capability; subscribes to turn events |
| Turn dispatch | `pump`'s prompt branch (line 2253) | calls `controller.send`; the turn runs from `turn_started` |
| Turn execution | `runPrompt` (line 3337) → `controller.prompt` | moved to `run-turn.ts`; calls `controller.executeTurn` |
| Handoff targets | `handoff` creates a target controller (around line 2460) | through the factory |
| Degraded-mode switch | `runSetMode` (line 3218) recreates the controller | capability-gated; `HarnessController` only |
| Internal prompts | `meteredInternalPrompt` (line ~4087) on `InternalPromptTarget.controller` (line 307) | `runInternalPrompt`, gated by `internalPrompts` |
| Supervision | `supervisedPrompt` (line 4037) | typed on the interface; wraps `executeTurn` |
| Public escape hatch | `get connection(): AgentController` (line 1897) | returns `ConversationController`; `harnessConnection(): HarnessController \| null` added |

```
src/conversation-controller/
  contracts.ts       ConversationController, OutgoingMessage, TurnContent, TurnEvent, TurnCause; documented guarantees
  capabilities.ts    ConversationCapabilities; fromAcp()
  factory.ts         adapter → controller
  index.ts
src/conversation-turns/
  run-turn.ts        runPrompt, moved, in phases (split by phase into files if over ~400 lines)
  context.ts         the narrow context object run-turn receives from AgentSession
  index.ts
src/controller.ts    AgentController → HarnessController, implements ConversationController; alias export
src/index.ts         exports the new types, HarnessController, the alias
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

Three briefs, each about one agent run. Gates use `bun run typecheck` and `bun test`; the baseline is a clean
typecheck and 1,096 passing tests in 112 files. Commit after each step with explicit paths
(`git commit -- <paths>`), never `git add -A`. No live harness runs are needed.

### Brief A1: characterization tests

**Scope:** tests only, against today's code. Must not touch anything under `src/`.

1. **`test/conversation-turns/normalize.ts`:** turns a captured run into a stable value. Replace UUIDs, minted ids
   and timestamps with placeholders numbered by first appearance (`<id:1>`, `<ts>`), keeping equal ids equal so
   relations stay visible; drop durations and process ids.
2. **`test/conversation-turns/characterization.test.ts`:** for each persistence mode, with the set-ups the existing
   tests use (Agent-owned: `test/agent-conversation-*.test.ts`; managed: `test/session-manager-*.test.ts`; detached:
   `test/agent-session-*.test.ts`) and the fixture agents, these cases:
   - a plain prompt (echo-prompt agent);
   - a second prompt queued behind a running one;
   - two steer messages combined into one run (steer agent);
   - an interrupt;
   - a stalled prompt (stalling-prompt agent, a short stale policy);
   - a permission request answered through the handler (permission agent);
   - an internal command (`executeInternalSessionCommand`);
   - a handoff with a summary (managed and Agent-owned only).

   Each case captures: the conversation's events (kind, ids, order; the `turn_*` and `message_delivered` events and
   the record events), the records written, read back the way each mode stores them (Agent-owned: the agent's
   persistence readers as the existing tests use them; managed: the session's persisted transcript and records;
   detached: the JSONL transcript), and the prompt results. Compare with `expect(normalize(run)).toMatchSnapshot()`
   and commit the `__snapshots__` files.
3. **Self-check:** run the file three times; the snapshots must not change between runs.

**Gate:** typecheck clean; full suite green (1,096 + the new cases); three runs identical.
**Done:** report the cases per mode, any case that couldn't be written in a mode and why, and the commit.

### Brief A2: the turn path through `send` and `executeTurn`

**Scope:** steps 1–5, on top of A1. Must not touch: records and schemas, `src/persistence/`, the adoption,
continuation and recovery paths except to call the moved code, the A1 snapshot files.

1. **Move `runPrompt`** into `src/conversation-turns/run-turn.ts` with the context object, in phases, in today's
   order; `AgentSession` calls it. **Gate:** suite green; A1 snapshots unchanged.
2. **Contracts:** `src/conversation-controller/contracts.ts` with `send`, `subscribeTurns`, `executeTurn`, the turn
   types and doc comments. **Gate:** typecheck.
3. **`AgentController` gains `send`, `subscribeTurns` and `executeTurn`** (its `prompt` stays): `send` reports
   `turn_started` synchronously; `executeTurn` calls `prompt` and reports the end; a session-side `failTurn` ends a
   reported turn that never executed. **Gate:** suite green.
4. **`AgentSession` drives turns through them:** `pump` calls `send`; the turn runs from `turn_started`;
   `run-turn.ts` dispatches through `executeTurn` under the supervisor; the conversation re-emits the turn events with
   `cause`. **Gate:** suite green; A1 snapshots unchanged except the added `cause` field (update them in a commit of
   their own whose diff shows only `cause`).
5. **`send()` for consumers** on `AgentConversation` and `AgentSession`, returning `{ messageId }` with `withdraw`;
   `prompt()` rebuilt as send plus waiting for the turn. New tests: `send` resolves before the turn ends; the cause
   lists the message id; two combined steer messages give both ids in the cause, with record ids still keyed by the
   turn; `withdraw` before dispatch; a provider-connection failure after `send` gives `turn_failed` and rejects the
   prompt. Changelog started. **Gate:** suite green; snapshots unchanged.

**Done:** report the commits, test count and time, the `agent-session.ts` line count, and any place the order of
operations had to change (expected: none).

### Brief B: the interface, the rename and capabilities

**Scope:** steps 1–5, on top of A2. Must not touch: behaviour, records, persistence, the A1 snapshot files.

1. **Capabilities:** `capabilities.ts` with `fromAcp`; `AgentController` exposes them. **Gate:** typecheck.
2. **Rename** `AgentController` to `HarnessController` across the files listed above; keep
   `export { HarnessController as AgentController }` with a deprecation comment; `HarnessController` declares
   `implements ConversationController`, with `runInternalPrompt` as its name for the prompt `meteredInternalPrompt`
   uses. **Gate:** suite green.
3. **`AgentSession` on the interface:** the field and every seam in the table typed `ConversationController`;
   capability checks before optional members; `meteredInternalPrompt` through `runInternalPrompt`; `connection`
   returns the interface, `harnessConnection()` added; new exports in `src/index.ts`. **Gate:** suite green;
   snapshots unchanged; no `HarnessController` type in `agent-session.ts` or `src/conversation-turns/` outside the
   factory and `harnessConnection`.
4. **Factory:** `createController` and handoff targets through `factory.ts`. **Gate:** suite green.
5. **Fake controller and conformance suite:** `fake-controller.ts` implements only the core (`send` reporting turns,
   `executeTurn` with scripted results and output, cancel, force stop, usage); `conformance.ts` runs a conversation
   on any controller: prompt, `send` with turn events and cause, queue and steer delivery, interrupt, force stop,
   stale detection, a reported turn that never executes, usage recorded, records written. It runs against the fake
   and against the `HarnessController` with the echo-prompt fixture agent. Changelog completed (`connection` type,
   rename, alias, `harnessConnection`, new types). **Gate:** both pass; suite green.

**Done:** report the commits, test count and time, `agent-session.ts` line count, and every capability check added
with the member it guards.

## Acceptance

- Typecheck clean; the full suite passes (at least the 1,096 baseline tests plus the new ones).
- The A1 snapshots are unchanged except for the added `cause` field, in one commit showing only that.
- The conformance suite passes on the core-only fake and on the `HarnessController`.
- `agent-session.ts` is shorter than 5,022 lines; no ACP type is used in it outside capability-gated paths, the
  factory and `harnessConnection`.
- `CHANGELOG-controller-interface.md` lists every public change.

## Risks

- **Order changes in the turn path.** The managed-mode preflight, the moment `turn_started` is emitted and the
  user-record ids are the likely places. Sign: an A1 snapshot changes in order or ids. Fix the order, never the
  snapshot.
- **A reported turn left open.** If `send` reports `turn_started` and the turn then fails before `executeTurn`, the
  turn must still end with `turn_failed`, and steering's `turnEnded` must still run. Covered by the A2 step 5 test
  and the conformance suite.
- **Hidden coupling in `runPrompt`.** Closures over session fields (presentation, metering state, `ownerRecordWrite`,
  `providerFailedTurnId`) can make the context object grow. Sign: it passes most of the session. Then move smaller
  pieces first rather than pass the session.
- **Steering combine.** The cause must list each combined message's id and `withdraw` must keep working for messages
  not yet dispatched. Covered by A1 and the A2 step 5 tests.
- **The managed path is agents-core's.** Breaking it breaks the only consumer. The `session-manager-*` tests and the
  managed A1 cases must stay green.
- **Snapshot flakiness.** Timing-dependent cases (stall, interrupt, queued) can capture events in varying order. Sign:
  the A1 three-run check differs. Then wait on explicit events in the test, never loosen the snapshot.
