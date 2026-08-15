# Slash commands and AgentSession operations — implementation log

Branch: `feat/agent-session-operations`

This is the running implementation log for the staged AgentSession operations work. A
new entry is appended only after each part is finished and verified.

## Part 1 — consumer operations smoke contract

Status: complete

### Purpose

Before changing the public API, establish one executable scenario showing how an
orchestration consumer should use all three operational levels:

1. Catalog-level management through `SessionManager` and `SessionStore`.
2. Stable logical-session control through `AgentSession`.
3. Harness-specific command discovery and invocation over ACP.

The scenario is deliberately non-interactive. Slash syntax is a possible UI binding, not
the underlying consumer contract. This keeps the smoke test focused on library operations
rather than readline, terminal rendering, or command parsing.

### Files added

- `smoke-tests/test5-operations/README.md`
- `smoke-tests/test5-operations/operations-smoke.ts`
- `smoke-tests/test5-operations/operations-agent.ts`

### Contract established

The smoke consumer constructs a file-backed catalog and creates two logical sessions with
custom fake adapters. It pins the following intended API and invariants:

- `agentSessionId` is the consumer's permanent identity and never changes.
- `internalSessionId` is the current provider-thread identity and may change.
- `AgentSession.state`, `isBusy`, and `queuedOperationCount` expose authoritative runtime
  state.
- `AgentSession.subscribe(listener)` exposes ordered session lifecycle notifications.
- Turn start/completion and harness-command changes are observable by listeners.
- `agentCommands` exposes the harness's current advertised command set.
- `executeAgentCommand(name, input?)` explicitly invokes a harness command.
- `handoff({summary})` retains the same `AgentSession` and `agentSessionId`, creates a new
  internal session, updates the existing catalog record, and emits lifecycle events.
- The logical transcript spans the handoff and contains a typed handoff boundary.
- `AgentSession.restore(...)` reconstructs a stopped logical session from its catalog
  record using a consumer-provided adapter resolver.
- Creating a second logical session makes both records visible through
  `SessionManager.list()`.

Planned methods are feature-detected at runtime. This lets the existing part of the
scenario execute while missing future APIs are reported as explicit red checks. The smoke
entry itself remains syntactically valid and bundleable throughout the staged work.

### Deterministic ACP fixture

`operations-agent.ts` is a standalone fake ACP process. It:

- Implements initialize, session/new, session/load, session/list, session/prompt, and
  session/cancel.
- Gives each new internal thread a deterministic distinct id.
- Advertises `status` during session creation.
- Adds `usage`, including its unstructured input hint, during the first prompt.
- Returns recognizable responses for `/status` and `/usage`.
- Recognizes the handoff seed text so a later handoff implementation can prove that the
  replacement thread received the continuation context.

The fixture is colocated with the smoke consumer but kept in a separate process entry so
the consumer and harness each have one responsibility.

### Failure classification

The script uses these exit codes:

- `0`: the complete operations contract passed.
- `1`: the scenario ran and an operation is missing or incorrect.
- `2`: the fixture/transport could not run, so the contract is inconclusive.

A configurable watchdog (`SMOKE_TIMEOUT_MS`, default 15 seconds) prevents transport startup
problems from hanging indefinitely. Output is explicitly flushed before exit because ACP
stream readers can retain an event-loop handle briefly after process termination under
Bun.

### Verification

- `bun run typecheck` passed.
- Both new smoke entries bundled successfully with `bun build --target=bun`.
- The fake harness responded correctly when driven directly with an initialize request.
- In the current managed sandbox, ACP subprocess tests stall before the harness receives
  initialize. Existing subprocess-based transcript tests display the same baseline
  behavior (`ACP connection closed` / timeout), so this is not classified as a Part 1 API
  failure. The new smoke watchdog correctly reports it as inconclusive with exit code 2.

### Deliberately not implemented in Part 1

- AgentSession state/listeners.
- Explicit harness-command execution.
- Handoff behavior or transcript lines.
- Restoration helpers.
- REPL or slash-command changes.

## Part 2 — AgentSession state and lifecycle notifications

Status: complete

### Purpose

Give orchestration consumers an authoritative, reactive view of a stable
`AgentSession`. Consumers should be able to render busy/idle state, observe turn
completion, monitor queue depth, and react to failures without polling private fields or
wrapping every prompt call themselves.

### Public API added

`AgentSession` now exposes:

```ts
session.state
session.isBusy
session.queuedOperationCount

const unsubscribe = session.subscribe(listener)
```

New exported types:

- `AgentSessionPhase`
- `AgentSessionState`
- `AgentSessionEvent`
- `AgentSessionNotification`
- `AgentSessionListener`

The initial phase union is:

```ts
"idle" | "prompting" | "handoff" | "stopped"
```

`handoff` is reserved now so Part 4 can use the state model without changing its public
shape.

### State semantics

- `isBusy` means an operation is actively executing.
- `queuedOperationCount` counts operations waiting behind the active operation and never
  counts the active operation itself.
- `state` is a frozen point-in-time snapshot containing phase, busy/queue state, stable
  and internal ids, adapter id, and mode.
- Late subscribers read `state` first, then subscribe to future deltas. Subscription does
  not replay historical events.
- State notifications are emitted only when a public snapshot field changes.
- Adjacent queued prompts do not emit a false idle transition between turns.
- `stopped` is terminal for an `AgentSession` object. New prompts reject immediately.
- Stopping clears queued work, interrupts the active turn, publishes stopped before
  process teardown, and cannot later transition back to prompting or idle from a pump
  `finally` block.

### Notification contract

Every notification carries:

```ts
{
  seq,
  ts,
  agentSessionId,
  event,
}
```

`seq` is strictly monotonic for the lifetime of the stable `AgentSession`. The first
event set is:

- `state_changed`
- `turn_started`
- `turn_completed`
- `turn_failed`

Turn ids are minted when a prompt is enqueued. The same turn id now namespaces the
activity aggregator for that turn, aligning public lifecycle identity with persisted
activity record ids.

`turn_completed` is emitted after `runPrompt()` finishes its transcript and catalog work
and immediately before the prompt promise resolves. `turn_failed` is emitted before the
promise rejects.

The notification envelope, event, state snapshots, and copied completion result are
frozen. The completion result's usage object is copied and frozen too, preventing one
observer from mutating what another observer sees.

Listeners run synchronously in registration order, but are observational only. Listener
exceptions are caught and logged as `agent_session_listener_failed`; they cannot reject a
prompt, stop delivery to other listeners, or corrupt session state. Emission iterates over
a listener snapshot, so subscribe/unsubscribe during a callback does not perturb the
current delivery pass.

### Queue preparation for handoff

The prompt queue item now has an explicit operation discriminator and stable turn id:

```ts
{
  kind: "prompt",
  turnId,
  ...
}
```

It remains prompt-only in this part, but is ready to become a prompt/handoff operation
union. Queue transitions are now the single source of truth for phase and queue-depth
notifications.

### Files changed

- `src/agent-session.ts`
- `src/index.ts`
- `test/agent-session-state.test.ts` (new)
- `smoke-tests/test5-operations/operations-smoke.ts` (its existing Part 2 checks now run
  against the real API; no contract rewrite was needed)

### Tests added

The new focused test suite verifies:

- The initial immutable idle state.
- Busy state during a turn.
- Ordered `turn_started` and `turn_completed` delivery.
- Monotonically increasing sequence numbers.
- Frozen completion results and usage.
- Queue depth while a second prompt waits.
- No idle transition between adjacent queued turns.
- Listener exception isolation.
- Unsubscribe behavior.
- `turn_failed` when the live controller disappears.
- Terminal stopped state and rejection of later prompts.
- Stop clearing queued work without a later transition out of stopped.

### Verification

- `bun run typecheck` passed.
- `git diff --check` passed.
- Focused state tests: 5 passed, 0 failed, 32 expectations.
- Full suite: 165 passed, 0 failed, 930 expectations.
- Subprocess tests were run outside the managed sandbox because the sandbox prevents the
  fake ACP processes from communicating; no network or external agent was used.

The operations smoke now reaches the fake ACP harness and reports 9/14 checks passing.
All Part 2 checks are green:

- Notification listener exposed.
- State and busy/queue getters exposed.
- Ordinary prompt still works.
- Turn lifecycle notified.
- Notification envelope ordering correct.

The five expected remaining red checks belong to later parts:

- `AgentSession.restore()`.
- `AgentSession.handoff()`.
- `agent_commands_changed` notification.
- `executeAgentCommand()`.
- Handoff transcript boundary.

## Part 3 — ACP harness command discovery, observation, and execution

Completed on 2026-08-15 on branch `feat/agent-session-operations`.

### Goal and boundary

This part implements the third operation layer: commands owned by the active ACP
harness. It does not turn library/session-management operations into slash commands and
does not modify the REPL command-routing policy yet. The consumer now has a typed API to:

1. Read the harness's current advertised command snapshot.
2. Observe semantic changes to that snapshot through `AgentSession` notifications.
3. Intentionally execute a harness command through the same queue and lifecycle as an
   ordinary prompt.

ACP itself represents a harness slash command as ordinary prompt text. The library now
makes that wire fact explicit without pretending it is a separate ACP RPC.

### Command metadata contract

`AgentCommand` is now an immutable public shape and preserves ACP's optional unstructured
input hint:

```ts
interface AgentCommand {
  readonly name: string;
  readonly description: string;
  readonly input?: {
    readonly kind: "unstructured";
    readonly hint: string;
  };
}
```

`toAgentCommands()` is the normalization boundary. It:

- Returns a frozen array containing frozen command objects.
- Trims command names.
- Drops entries with missing, non-string, or blank names.
- Keeps the first command when a payload repeats a name.
- Defaults a missing/non-string description to an empty string.
- Preserves a string `input.hint` as `{ kind: "unstructured", hint }`.
- Omits malformed input metadata rather than exposing a misleading partial object.

The corresponding `commands` activity event now also uses a readonly collection.

### Session-aware command ownership in `AcpClient`

Command state belongs to the currently selected internal ACP session. The client now
publishes it through:

```ts
client.agentCommands
client.subscribeAgentCommands(listener)
```

Updates are accepted only when their notification session id matches the active internal
session. This prevents a late update from an old or unrelated ACP session from replacing
the visible command palette.

Session creation/load/resume/fork has an extra timing problem: an ACP harness may send an
`available_commands_update` for the new session before returning the RPC response that
tells the client which session was selected. Each transition now:

1. Saves the previous visible snapshot and clears the visible commands.
2. Buffers command snapshots keyed by their wire `sessionId`.
3. Commits only the snapshot belonging to the session id returned by the successful RPC.
4. Restores the previous snapshot if the transition fails.

This is deliberately internal to `AcpClient`: `AgentSession` should not have to reason
about ACP notification/RPC ordering.

Semantically identical command arrays are deduplicated before publication. The comparison
includes name, description, input kind, and input hint. Every published collection is a
fresh frozen snapshot, including empty snapshots used during transitions and shutdown.
Command-listener exceptions are caught and logged; they cannot break protocol handling.

Crash and stop clear both the current command set and any in-progress transition buffer,
so a dead or degraded connection never retains a stale harness palette.

### Propagation through `AgentController`

`AgentController` now exposes a readonly `agentCommands` snapshot and a
`subscribeAgentCommands()` stream that survives replacement of its internal leaf. On
start and mode changes it detaches from the old ACP client, attaches to the new one, and
publishes the new snapshot. In degraded PTY mode the snapshot is the shared immutable
empty collection because no ACP command-advertisement surface exists.

This keeps the controller useful as the live control-plane boundary without forcing an
orchestration consumer to reach into `currentClient`.

### `AgentSession` consumer API

`AgentSession.agentCommands` is now explicitly a readonly immutable snapshot.

Future semantic changes are delivered through the existing ordered notification stream:

```ts
{
  kind: "agent_commands_changed",
  commands: readonly AgentCommand[]
}
```

The initial command set can arrive while `AgentSession.create()` is still starting, before
an external subscriber can exist. The contract is therefore the same snapshot-plus-delta
pattern as session state: read `agentCommands` after creation, then subscribe for future
changes. No artificial historical event is replayed.

The explicit execution API is:

```ts
session.executeAgentCommand(name, input?, handlers?)
```

It serializes to `/${name}` or `/${name} ${input}` and delegates to `prompt()`. As a result,
command execution participates in the same operation queue, `isBusy` state, turn ids,
notifications, activity handlers, transcript messages, persistence, cancellation, and
error behavior as an ordinary turn.

The method rejects blank names, names containing whitespace, and names that include the
leading slash. It intentionally does not enforce the advertised snapshot as an allow-list:
advertisement is discoverability, and harnesses may accept valid commands before or
without advertising them.

### Adversarial smoke fixture behavior

The deterministic Part 1 harness now does more than publish a happy-path update. During
the first prompt it sends:

- A command update labelled for `stale-session`, which must be ignored by command state.
- A valid active-session update adding `usage` with input hint `optional scope`.
- The same valid update a second time, which must not produce another
  `agent_commands_changed` notification.

It continues to answer `/status` and `/usage ...` as ordinary ACP prompts. This makes the
smoke test representative of the actual ACP transport semantics.

### Files changed

- `src/types.ts`
- `src/updates.ts`
- `src/client.ts`
- `src/controller.ts`
- `src/agent-session.ts`
- `src/index.ts`
- `src/repl/commands.ts` (readonly type compatibility only; routing is deferred)
- `smoke-tests/test5-operations/operations-agent.ts`
- `test/updates.test.ts`
- `test/agent-session-commands.test.ts` (new)

### Tests added

The normalization tests cover metadata preservation, invalid entries, name trimming,
duplicate-name policy, malformed input omission, and immutability.

The `AgentSession` command tests cover:

- Initial command discovery at session creation.
- Frozen command collections and input metadata.
- Future `agent_commands_changed` delivery.
- Ignoring a stale-session update.
- Deduplicating repeated semantic updates.
- Executing a command with and without raw input.
- Command execution producing normal turn lifecycle events.
- Rejecting ambiguous command names without starting a turn.

### Verification

- `bun run typecheck` passed.
- `git diff --check` passed.
- Focused update/state/command tests: 20 passed, 0 failed, 81 expectations.
- Full suite: 170 passed, 0 failed, 950 expectations across 16 files.
- The Part 1 operations smoke reports 12/15 checks passing. All harness-command checks
  are now green: initial discovery, updated discovery, change notification, explicit
  execution API, and delivery to the fake harness.
- The remaining smoke failures are exactly the later-part work: `AgentSession.handoff()`,
  its transcript boundary, and `AgentSession.restore()`.
- `npm run build` was attempted but this package defines no `build` script. Its available
  validation scripts are `typecheck`, `test`, `check`, and `pack:dry`; the relevant
  typecheck and test validations above passed.
- Subprocess tests and the smoke were run outside the managed sandbox so their local fake
  ACP processes could communicate. No network service or real harness was used.
