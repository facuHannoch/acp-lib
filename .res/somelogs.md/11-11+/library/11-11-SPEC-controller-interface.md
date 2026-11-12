# Controller interface: what a conversation needs from its backend

Status: agreed, not started; review 1 done 2026-11-12 (checked against `beta`, 0.12.1). First in the library line
(`../11-11-NOTE-overview.md`, Order of work). A refactor with **no new behaviour**: every native piece depends on it,
and its gate is that nothing breaks. Carries over the "provider-session interface" prerequisite of
`../../9-22+/10-17-NOTE-model-call-controller.md` and the 2026-11-09 review.

## Problem

`AgentConversation` is built on `AgentSession` (`src/agent-session.ts`, 5,022 lines), which depends on the concrete
`AgentController` (`src/controller.ts:122`). The nominal contract, `AgentClient` (`prompt`, `interrupt`, `stop`;
`src/agent-client.ts:45`), is much smaller than what the session uses. A second backend (the `NativeController`,
`11-11-SPEC-native-harness-integration.md`) can't be plugged in until that surface is an interface with ACP-only parts
marked optional.

A second problem: one call does two jobs. `prompt()` puts a message in and makes the backend take a turn, and its
promise is that turn's result. A native backend also takes turns nobody prompted (a worker reply, another channel),
so the message going in and the turn running have to be separate (overview, decisions 34 and 40).

Decided (overview, decision 6): one `AgentConversation`, the backend chosen by the adapter's type. A separate
conversation type was rejected.

## Scope

**In:** the turn split inside `AgentSession` (`acceptMessage` and `runTurn`), `send()`, the cause on turn events; the
turn-based `ConversationController` interface; renaming `AgentController` to `HarnessController`; the controller
factory; neutral capabilities and capability checks; a core-only fake controller and the controller conformance
suite.

**Out (moved to integration stage 2a, where the native backend needs them):** generalizing `provider_sessions`, the
neutral permission request shape, the model-call record, opaque provider data on messages; anything native.

**Behaviour:** none changes for ACP conversations, in any of the three persistence modes (below). The only public
additions are `send()`, the `cause` on `turn_started`, `harnessConnection()` and the `HarnessController` name; the one
public change is the type of `connection`.

## The code as it is

What the refactor must preserve, read from the code on 2026-11-12.

**The turn path.** A prompt becomes a `PromptQueueItem` (`src/agent-session.ts:272`) in the conversation's operation
queue (`AgentConversationQueue`); `pump()` (line 2253) runs queue items one at a time. For a prompt it lets steering
combine queued steer messages into one run (`steering.prepareRun`), emits `turn_started` (line 2280), calls
`runPrompt` (line 3337, about 450 lines), emits `turn_completed` or `turn_failed`, and resolves or rejects the item's
promise. Internal operations (`executeInternalSessionCommand`, handoff summaries) use the same path with another
`operationKind`.

**Three persistence modes,** all inside `runPrompt`:

| Mode | When | How the user message is written |
| --- | --- | --- |
| Agent-owned | conversations of an `Agent` (`ownerLifecycle`) | `ownerLifecycle.beforePrompt`: media, participants, identity `load`, out-of-band messages, the user record in SQLite |
| Managed | `SessionManager` sessions (`v2Transcript`, a `PersistenceStateRuntime`); agents-core uses this path | the metered operation is opened first, then `beginOperation`, then presentation events for each user text, then `syncBeforeDispatch` |
| Detached | an `AgentSession` with neither | `appendTranscript` (legacy JSONL), then the metered operation |

**Ordering constraints:**

- In managed mode the metering preflight runs **before** any durable record ("a strict pricing/policy rejection
  needs no abort record"). A split that writes the user message first would change that.
- User records are keyed by the turn: `${operationId}:user`, presentation ids `message:${turnId}:user`. For ACP the
  message and its turn are one, so these ids stay.
- The permission handler is built inside `runPrompt` (line ~3536) and records `permission` requested and resolved
  under the turn.
- The identity delivery receipt is confirmed at the end of the turn (`ownerLifecycle.afterPrompt` with
  `identityDeliveryReceipt`).
- `turn_started` is emitted before the provider is ensured; failures before dispatch reject the prompt and emit
  `turn_failed`.

**Who uses `AgentController` directly:** `src/agent-session.ts` (18 references), `src/controller.ts`,
`src/internal-inference/runtime/harness-runtime.ts` (6), `src/repl/commands.ts`, `src/cli/index.ts`, `src/index.ts`,
`src/wire-log.ts`; tests `test/commands.test.ts` and `test/internal-inference/harness-runtime.test.ts`.

**Members `AgentSession` uses** (through `this.controller`): `configOptions` 27, `isDegraded` 8, `start` 5,
`startFresh` 5, `setConfig` 5, `currentMode` 4, `setMode` 3, `forceStop` 3, `capabilities` 3, `isConnected` 2,
`currentSessionId` 2, and once each `stop`, `reconnect`, `prompt`, `listSessions`, `cancel`, `bridge`,
`availableCommands`, `authenticate`; plus `subscribeConnection`, `subscribeAvailableCommands`,
`subscribeUsageUpdate` in `bindController`, and `subscribeOutput`, `cancel`, `forceStop`, `cancelGraceMs` through
`supervisedPrompt` (line 4037).

**Tests:** 1,096 tests in 112 files pass in about 90 seconds (`bun test`); `bun run typecheck` is clean. Most
conversation tests drive real fake ACP agents (`test/fixtures/*-agent.ts`: echo-prompt, steer, permission,
permission-order, stalling-prompt, usage, identity, config, lifecycle, media, presentation, replay, terminal).

## The interface

The interface is **turn-based**: a message going in (`send`) and a turn running (`subscribeTurns`) are separate.

| Group | Members | Native backend (later) |
| --- | --- | --- |
| Core (required) | `send`, `subscribeTurns`, `cancel`, `forceStop`, `stop`, `start`, `startFresh`, `isConnected`, `subscribeOutput`, `subscribeConnection`, `cancelGraceMs`, `capabilities` | `send` pushes onto the channel; turns are reported as the harness starts them; `forceStop` abandons the turn if the harness process doesn't answer; `start` opens the channel |
| Generalized | `configOptions`, `setConfig`, `subscribeUsageUpdate`, `currentSessionId`, `availableCommands`, `subscribeAvailableCommands` | per-channel settings in the `ConfigOption` shape; usage from every model call; no commands at first |
| Optional, behind capabilities | `runInternalPrompt` (one synchronous turn: recap, handoff summaries, internal commands), `isDegraded`, `currentMode`, `setMode`, `reconnect`, `listSessions`, `bridge`, `authenticate`; session load with replay and session delete | absent; callers check capabilities |

```ts
interface ConversationController {
  send(message: OutgoingMessage): Promise<{ messageId: string }>;  // queued to the backend
  subscribeTurns(listener: (event: TurnEvent) => void): () => void;
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
type TurnEvent =
  | { kind: "turn_started"; turnId: string; cause: TurnCause }
  | { kind: "turn_ended"; turnId: string; result: PromptResult }
  | { kind: "turn_failed"; turnId: string; error: unknown };
type TurnCause = { kind: "messages"; messageIds: string[] } | { kind: "items"; items: unknown[] };
```

- **Names.** `ConversationController` is what a conversation needs from whatever backs it. Implementations: the
  `HarnessController` (today's `AgentController`, renamed: it drives an external harness, over ACP or a PTY in
  degraded mode) and, later, the `NativeController`. `AgentController` stays exported as a deprecated alias.
- **Optional members are capabilities, not stubs:** `AgentSession` checks before calling.
- **The operation-lifecycle guarantees stay above the controller** (`../../9-22+/10-17-SPEC-operation-lifecycle.md`);
  each controller supplies `cancel` and `forceStop`.

## Messages in, turns out

**Inside `AgentSession`,** `runPrompt` is split into two functions, moved to `src/conversation-turns/`:

- **`acceptMessage(message)`:** what makes the message the conversation's: participants, media resolution, identity
  `load`, out-of-band messages, the user record (each persistence mode as today).
- **`runTurn(turn)`:** what runs a turn: the metered operation, transcript begin, the permission handler, the
  supervisor, the backend call, assistant records, metering close, transcript finish, `afterPrompt` with the identity
  receipt.

**For the `HarnessController` (ACP and PTY), the order stays exactly as today.** `send` and its turn are one unit:
the message is queued; when its turn comes the session runs the same sequence `runPrompt` runs now, in the same order,
including the managed-mode preflight before any durable record. The split is a split of code, not a change of
sequence.

- **Message ids and turn ids are separate.** Each message keeps the id the queue already gives it (the pending
  message id that `withdraw` takes); that is `messageId`. A turn has its own turn id, as today.
- **Steering's combining** of queued steer messages into one run stays as it is: a combined run is one turn whose
  cause lists every message id it took.
- **Record and presentation ids stay keyed by the turn** (`<turnId>:user`, `<turnId>:user:2`,
  `message:<turnId>:user`), so no record changes.
- **An ACP message is durable only once its turn starts** (the user record is written then, as today); accepted for
  now and recorded in `findings/11-12-FINDING-acp-message-durability.md`.

**Turn events.** `turn_started` gains `cause` (`{ kind: "messages", messageIds }` for every ACP turn);
`turn_completed` and `turn_failed` are unchanged. `AgentSession` runs `runTurn` when its controller reports
`turn_started`; the `HarnessController` reports it when the session dispatches the queued message, so the observable
order of events is unchanged.

**Public API.**

- `prompt()` stays the main consumer method and behaves exactly as today.
- `send(message)` is new: it queues the message (same inputs as `prompt`: text, parts, attachments, participant,
  consumer metadata, delivery) and resolves with `{ messageId }` once queued, not once saved; `withdraw()` works as
  on a prompt handle. For ACP the user record is written when its turn begins, as today (see the finding above).
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
| Binding | `bindController` (line 742) | typed on the interface; commands only with the capability |
| Handoff targets | `handoff` creates a target controller (around line 2460) | through the factory |
| Degraded-mode switch | `runSetMode` (line 3218) recreates the controller | capability-gated; `HarnessController` only |
| Internal prompts | `InternalPromptTarget.controller` (line 308) | `runInternalPrompt`, gated by `internalPrompts` |
| Supervision | `supervisedPrompt` (line 4037) | typed on the interface |
| Public escape hatch | `get connection(): AgentController` (line 1897) | returns `ConversationController`; `harnessConnection(): HarnessController \| null` added |

```
src/conversation-controller/
  contracts.ts       ConversationController, TurnEvent, TurnCause, OutgoingMessage; documented guarantees
  capabilities.ts    ConversationCapabilities; fromAcp()
  factory.ts         adapter → controller
  index.ts
src/conversation-turns/
  accept-message.ts  the first half of runPrompt, per persistence mode
  run-turn.ts        the second half
  index.ts
src/controller.ts    AgentController → HarnessController, implements ConversationController; alias export
test/conversation-controller/
  fake-controller.ts a core-only fake
  conformance.ts     the suite every controller passes
test/conversation-turns/
  characterization.test.ts  written before the refactor (Brief A, step 1)
CHANGELOG-controller-interface.md
```

- **`agent-session.ts` must end shorter than 5,022 lines.** The turn split moves `runPrompt` out; capability checks
  are guards, not new paths.
- `src/conversation-turns/` receives what it needs from `AgentSession` through a narrow context object (the
  controller, persistence, presentation, metering, steering, logger), not the whole session.
- Files under ~400 lines; split `run-turn.ts` by phase if it grows past that.

## Implementation briefs

Two briefs, each about one agent run. Gates use `bun run typecheck` and `bun test`; the baseline is a clean
typecheck and 1,096 passing tests. Commit after each step with explicit paths (`git commit -- <paths>`), never
`git add -A`. No live harness runs are needed.

### Brief A: characterization tests and the turn split

**Scope:** steps 1–5 below. Must not touch: records and schemas, `src/persistence/`, the adoption, continuation and
recovery paths except to call the new functions, public behaviour.

1. **Characterization tests first,** in `test/conversation-turns/characterization.test.ts`, run against today's code
   and committed before any refactor. For each persistence mode (Agent-owned, managed through `SessionManager`,
   detached), with the existing fixture agents: a plain prompt; a queued prompt; two steer messages combined into one
   run; an interrupt; a stalled prompt (stalling agent); a permission request answered through the handler; an
   internal command; a handoff summary. Each test records the emitted event sequence (kinds, turn ids, order), the
   records written (kinds, ids, order) and the prompt result, and compares against an inline snapshot.
   **Gate:** typecheck clean; full suite green (1,096 + new).
2. **Extract `acceptMessage` and `runTurn`** into `src/conversation-turns/` with the narrow context object; `runPrompt`
   becomes a call to both, in today's order. **Gate:** full suite green; characterization snapshots unchanged.
3. **`cause` on `turn_started`** (`{ kind: "messages", messageIds }`; for a combined steer run, every message).
   **Gate:** suite green; snapshots updated only by the added field.
4. **`send()`** on `AgentConversation` / `AgentSession`, returning `{ messageId }` with `withdraw`; `prompt()` rebuilt
   as send plus waiting for the turn. New tests: `send` resolves before the turn ends; a turn's cause lists the
   message id; two steer messages combined into one turn give two message ids in its cause, with record ids still
   keyed by the turn; `withdraw` before dispatch. **Gate:** suite green; snapshots unchanged.
5. **Changelog:** `CHANGELOG-controller-interface.md` with `send()` and `cause`. **Gate:** `agent-session.ts` shorter
   than before.

**Done:** all gates; report the commits, the final test count and time, the `agent-session.ts` line count, and any
place where the order of operations had to change (expected: none).

### Brief B: the interface, the rename and capabilities

**Scope:** steps 1–6 below, on top of Brief A. Must not touch: behaviour, records, persistence.

1. **Contracts:** `src/conversation-controller/contracts.ts` and `capabilities.ts` with doc comments. **Gate:**
   typecheck.
2. **Rename** `AgentController` to `HarnessController` across the files listed above; keep
   `export { HarnessController as AgentController }` with a deprecation comment. **Gate:** suite green.
3. **`HarnessController` implements the interface:** `send` and `subscribeTurns` over its prompt (one message, one
   turn), `runInternalPrompt`, `capabilities` through `fromAcp`. **Gate:** suite green; characterization snapshots
   unchanged.
4. **`AgentSession` on the interface:** the field and every seam in the table typed `ConversationController`;
   capability checks before optional members; `runTurn` started from `turn_started`; `connection` returns the
   interface, `harnessConnection()` added. **Gate:** suite green; snapshots unchanged; no `HarnessController` type in
   `agent-session.ts` or `src/conversation-turns/` outside the factory and `harnessConnection`.
5. **Factory:** `createController` and handoff targets through `factory.ts`. **Gate:** suite green.
6. **Fake controller and conformance suite:** `test/conversation-controller/fake-controller.ts` implements only the
   core (`send`, scripted turns, output, cancel, force stop, usage); `conformance.ts` runs a conversation on any
   controller: prompt, `send` with turn events, queue and steer delivery, interrupt, force stop, stale detection,
   usage recorded, records written. It runs against the fake and against the `HarnessController` with the echo
   fixture agent. **Gate:** both pass; suite green. Changelog updated (`connection` type, rename, alias,
   `harnessConnection`).

**Done:** all gates; report the commits, test count and time, `agent-session.ts` line count, and every capability
check added with the member it guards.

## Acceptance

- Typecheck clean; the full suite passes (at least the 1,096 baseline tests plus the new ones).
- The characterization snapshots are unchanged except for the added `cause` field.
- The conformance suite passes on the core-only fake and on the `HarnessController`.
- `agent-session.ts` is shorter than 5,022 lines; no ACP type is used in it outside capability-gated paths, the
  factory and `harnessConnection`.
- `CHANGELOG-controller-interface.md` lists every public change.

## Risks

- **Order changes in the turn path.** The managed-mode preflight and the user-record ids are the likely places. Sign:
  a characterization snapshot changes in record order or ids. Fix the order, never the snapshot.
- **Hidden coupling in `runPrompt`.** Closures over session fields (presentation, metering state, `ownerRecordWrite`)
  can make the narrow context object grow. Sign: the context passes most of the session. Then extract smaller pieces
  first rather than pass the session.
- **Steering combine.** A combined run carries several messages; the cause must list each message's own id (not the
  turn id), and `withdraw` must keep working for messages not yet dispatched. Covered by the characterization tests
  and the step 4 tests.
- **The managed path is agents-core's.** Breaking it breaks the only consumer. The `session-manager-*` tests and the
  managed characterization tests must stay green.
