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

## Part 4 — Stable logical identity handoff and transcript boundaries

Completed on 2026-08-15 on branch `feat/agent-session-operations`.

### Goal and invariant

Handoff is implemented as an operation on the existing `AgentSession`, not as creation of
a replacement logical session. The invariant is:

```text
AgentSession object:       unchanged
agentSessionId:            unchanged
internalSessionId:         old ACP thread -> new ACP thread
catalog key:               unchanged
logical transcript path:  unchanged
```

This lets an orchestration consumer retain one durable reference while the library moves
the conversation to a fresh provider context behind it.

### Public API

The new consumer-facing shapes are exported from the package root:

```ts
interface HandoffOptions {
  readonly summary?: string;
}

interface HandoffResult {
  readonly handoffId: string;
  readonly agentSessionId: string;
  readonly fromInternalSessionId: string | null;
  readonly toInternalSessionId: string;
  readonly summary: string;
}

session.handoff(options?): Promise<HandoffResult>
```

When a nonblank `summary` is supplied, handoff uses it verbatim. When it is omitted, the
old thread is prompted to generate portable continuation context covering objectives,
decisions, completed work, current state, important identifiers, next steps, constraints,
and unresolved risks.

The queued options object is copied and frozen when `handoff()` is called. A consumer
cannot mutate a waiting handoff while it sits behind an active operation.

The returned result is frozen and reports both provider thread ids alongside the stable
logical id.

### One serialized operation queue

The old prompt-only queue is now a discriminated union of `prompt` and `handoff`
operations. Both use the same pump, so:

- A handoff waits for an active or earlier queued prompt.
- A prompt submitted after a handoff waits for the new thread to be ready.
- `queuedOperationCount` covers both operation kinds.
- During execution `state.phase` is `handoff` and `isBusy` is true.
- There is no false idle transition between adjacent operations.
- `interrupt({ clearQueue: true })` rejects a handoff that has not started rather than
  inventing a prompt-shaped cancellation result.
- Stopped sessions reject new handoffs just as they reject new prompts.

Summary generation and continuation seeding call the controller inside the outer handoff
operation. They do not re-enter the AgentSession queue and cannot interleave with consumer
prompts.

### Handoff lifecycle

The operation executes in this order:

1. Capture the current internal session id.
2. Publish `handoff_started` and append the start transcript boundary.
3. Validate the supplied summary or generate one on the old thread.
4. Call ACP `session/new` through `AgentController.newSession()`.
5. Immediately update the AgentSession's `internalSessionId`, state snapshot, and existing
   catalog record to the new thread.
6. Seed the new thread with the portable continuation context.
7. Append the completion boundary, publish `handoff_completed`, and resolve with the
   frozen result.

Starting a fresh thread naturally goes through the Part 3 command-transition machinery,
so `agentCommands` clears and then adopts the new thread's advertised command set without
special handoff code.

Handoff is intentionally unavailable in degraded PTY mode because there is no ACP
session identity or `session/new` operation to replace safely.

### Notifications

The existing ordered `AgentSessionNotification` stream now includes:

```ts
{ kind: "handoff_started", handoffId, fromInternalSessionId }
{ kind: "handoff_completed", result }
{ kind: "handoff_failed", handoffId, fromInternalSessionId, toInternalSessionId?, error }
```

These share the same stable `agentSessionId`, monotonic sequence counter, timestamp,
listener ordering, listener exception isolation, and frozen event envelope as turn,
state, and command notifications.

### Transcript contract

The recognized transcript union now includes `TranscriptHandoffLine`:

```ts
{
  v: 1,
  t: "handoff",
  event: "start" | "complete" | "failed",
  ts,
  handoffId,
  fromInternalSessionId,
  toInternalSessionId?,
  summary?,
  error?,
}
```

The reader validates and returns these records, and `ReadTranscriptOptions.types` can
select `"handoff"` like any other recognized line type.

Library-generated summary and continuation prompts are deliberately not written as
`t:"msg"` lines. They are implementation traffic rather than user-authored conversation.
The logical transcript instead records their effect as a typed boundary:

- `start -> complete` means the provider-thread transition committed.
- `start -> failed` means a handoff was attempted but did not complete.

The completed record contains the portable summary, making the boundary self-describing
without fabricating a user turn. The transcript remains one append-only file named from
the stable `agentSessionId` across every internal thread.

### Partial failure semantics

Failures before `session/new` succeeds leave the old provider session active.

The important partial-failure case is continuation seeding failing after the harness has
already switched to the new thread. The implementation does not claim transactional
rollback that ACP cannot guarantee. Instead it:

- Keeps the stable logical identity.
- Reports the new internal id because that is what the controller actually uses.
- Persists that truthful id to the same catalog record.
- Writes a failed boundary containing both old and new ids plus the error.
- Publishes `handoff_failed` with the new id.
- Rejects the handoff promise so the consumer knows continuation was not seeded.

This avoids the worse outcome of exposing the old id while subsequent prompts actually
go to the new thread. A future opt-in rollback policy could use `session/load` where a
harness supports it, but rollback is not required for truthful base semantics.

### Deterministic failure fixture

The Part 1 fake harness accepts a `fail-seed` label. In that mode it successfully creates
the new provider thread and then returns a JSON-RPC error for the continuation prompt.
This pins the post-switch failure behavior rather than testing only failures that occur
before any state changes.

### Files changed

- `src/agent-session.ts`
- `src/transcript.ts`
- `src/index.ts`
- `smoke-tests/test5-operations/operations-agent.ts`
- `test/agent-session-handoff.test.ts` (new)

### Tests added

The focused handoff suite verifies:

- The same object and stable id survive handoff.
- The internal provider id changes.
- The frozen result reports the exact old and new ids.
- Supplied summary preservation.
- Generated summary behavior on the old thread.
- Serialization behind an active prompt.
- `handoff` phase and busy state during the operation.
- Turn completion occurs before a queued handoff starts.
- Command discovery follows the new internal thread.
- The existing catalog record is updated in place.
- The transcript contains start and complete boundaries.
- Internal prompts do not appear as user message lines.
- Ordered started/completed notifications.
- Post-switch continuation failure keeps public state, controller state, catalog,
  notification, and failed transcript boundary consistent.

### Verification

- `bun run check` passed: TypeScript plus the complete test suite.
- Full suite: 173 passed, 0 failed, 981 expectations across 17 files.
- Focused handoff suite: 3 passed, 0 failed, 31 expectations.
- `git diff --check` passed.
- `bun run pack:dry` succeeded and included the changed public source files.
- The operations smoke now reports 18/19 checks passing. Handoff exposure, stable logical
  identity, changed internal id, catalog update, lifecycle notification, and transcript
  boundary are all green.
- The only remaining smoke failure is `AgentSession.restore()`, which belongs to Part 5.
- Subprocess tests and smoke verification used only the local deterministic ACP fixture;
  no network service or real harness was used.

## Part 5 — Explicit startup identity, transcript independence, and consumer-owned reopening

Completed on 2026-08-15 on branch `feat/agent-session-operations`.

### Architectural correction

The originally planned `AgentSession.restore()` was not added. It would only have hidden
consumer policy behind a second factory: catalog lookup, adapter resolution, transcript
location policy, and translation back into `AgentSession.create()`.

The implemented lifecycle is instead:

```text
SessionManager.get(agentSessionId)   -> routing/history metadata only
consumer.resolveAdapter(adapterId)   -> consumer-owned runtime dependency
AgentSession.create(config)          -> opens the live logical session
```

`SessionManager.get()` does not start a process, contact ACP, read a transcript, or
resolve an adapter. With `FileSessionStore` it reads the catalog JSON record keyed by the
encoded stable id and returns `SessionRecord | null`.

### Four independent axes

The startup model is now explicitly documented as four independent decisions:

1. `agentSessionId` — stable logical identity.
2. `providerSession` — whether ACP creates a new provider thread or loads a specific one.
3. `sessions` — optional routing metadata persistence.
4. `transcriptPath` / `transcriptDir` — optional logical history persistence.

There is deliberately no precedence between catalog, transcript, and provider identity:
they do different jobs. Neither transcript file existence nor an attached SessionManager
is consulted implicitly during `AgentSession.create()`.

### Stable logical id semantics

`agentSessionId` is always exposed as `session.agentSessionId`:

- A supplied value is retained exactly.
- When omitted, the library mints a UUID.
- A blank supplied id is rejected.
- Nonblank ids are opaque values and are not trimmed or otherwise normalized.

The id determines the catalog key and, with `transcriptDir`, the encoded transcript
filename. It does not decide whether the provider thread is new or loaded.

### Explicit provider-thread selector

The package now exports:

```ts
type ProviderSession =
  | { readonly kind: "new" }
  | {
      readonly kind: "load";
      readonly internalSessionId: string;
      readonly onFailure?: "error" | "new";
    };
```

`AgentSessionConfig.providerSession` is the authoritative startup intent:

```ts
providerSession: { kind: "new" }
```

always requests ACP `session/new`, while:

```ts
providerSession: {
  kind: "load",
  internalSessionId,
  onFailure: "error",
}
```

requests the exact existing provider thread.

The rules are:

- Omitted `providerSession` means `{ kind: "new" }`.
- A load defaults to `onFailure: "error"`; a requested thread is never silently replaced.
- `onFailure: "new"` explicitly permits fallback to ACP `session/new` when load fails or
  the harness does not advertise load support.
- Blank internal ids are rejected.
- Internal ids are opaque and are not normalized.
- Loading is rejected in degraded PTY mode because there is no ACP provider-session
  identity to load.
- Supplying both `providerSession` and the legacy `internalSessionId` is a configuration
  error rather than a precedence decision.

### Compatibility path

The flat `AgentSessionConfig.internalSessionId` remains temporarily available and is
marked deprecated. It translates to:

```ts
{
  kind: "load",
  internalSessionId,
  onFailure: "new",
}
```

This preserves the previous fallback behavior for existing consumers while new code gets
the safer fail-closed default.

The lower layers gained the same explicit policy:

- `SessionLoadFailure = "error" | "new"`.
- `AcpClientConfig.sessionLoadFailure`.
- `StartSessionOptions.loadFailure`.
- `AgentControllerConfig.sessionLoadFailure`.

`AcpClient.startSession()` now rejects a strict load both when the load RPC fails and when
the harness does not support `session/load`. `AgentController` propagates strict startup
failure and tears down the partially opened client instead of converting it into a
connected object with no usable session. Its existing unauthenticated-new-session behavior
remains unchanged for non-strict startup.

### Transcript path and directory semantics

Transcript configuration now has an explicit storage-only contract:

- No `transcriptPath` or `transcriptDir`: no library history file is created.
- `transcriptPath`: append to exactly that file.
- `transcriptDir`: derive `<encodeURIComponent(agentSessionId)>.jsonl` in that directory.
- Both supplied: configuration error.
- Missing directory/file: created by the first append (the initial open record).
- Existing valid file: append another open record and preserve earlier history.
- Existing malformed lines: leave them in place, append valid new records, and let the
  tolerant transcript reader skip malformed lines.
- File contents and filenames never select a provider thread.
- A directory is not scanned as an implicit catalog during session creation.

Omitting transcript persistence does not remove live AgentSession functionality. Prompt,
handoff, state, notifications, harness commands, and catalog routing still work. It only
removes library-owned persistent conversation history and handoff boundaries.

The resolved path is now public as:

```ts
session.transcriptPath: string | undefined
```

It is also stored as optional `SessionRecord.transcriptPath` and carried through merged
catalog results. This lets a consumer reopen the same logical history without remembering
whether the original caller supplied a direct path or a directory. It avoids treating a
filesystem scan as a second session catalog.

Transcript-directory discovery/recovery was deliberately not added in this part. A future
feature should be an explicit transcript-store or repair/import operation, not an implicit
side effect of constructing an AgentSession.

### Consumer-owned reopen flow

The operations smoke now implements its own small helper:

```ts
const record = await sessions.get(agentSessionId);
if (!record) throw new Error("unknown logical session");

const session = await AgentSession.create({
  adapter: await resolveAdapter(record.adapter),
  adapterId: record.adapter,
  agentSessionId: record.agentSessionId,
  providerSession: record.internalSessionId
    ? { kind: "load", internalSessionId: record.internalSessionId, onFailure: "error" }
    : { kind: "new" },
  mode: record.mode,
  cwd: record.cwd,
  title: record.title,
  sessions,
  ...(record.transcriptPath ? { transcriptPath: record.transcriptPath } : {}),
});
```

This is intentionally ordinary consumer code. Different orchestration libraries remain
free to resolve adapters, credentials, missing provider threads, duplicate live objects,
and transcript storage according to their own policies.

### Deterministic load failure fixture

The Part 1 fake harness accepts a `fail-load` label. It initializes successfully but
rejects `session/load`, allowing tests to distinguish:

- Strict default load rejection.
- Explicit `onFailure: "new"` fallback.
- Deprecated `internalSessionId` compatibility fallback.

### Files changed

- `src/agent-session.ts`
- `src/client.ts`
- `src/controller.ts`
- `src/index.ts`
- `src/session-manager.ts`
- `src/session-store.ts`
- `README.md`
- `smoke-tests/test5-operations/README.md`
- `smoke-tests/test5-operations/operations-smoke.ts`
- `smoke-tests/test5-operations/operations-agent.ts`
- `test/agent-session-startup.test.ts` (new)
- `test/agent-session-handoff.test.ts` (catalog transcript-path assertion)

### Tests added

The startup matrix suite verifies:

- Existing transcript metadata cannot override explicit new-provider intent.
- Supplied logical id and loaded provider id remain independent and stable.
- Explicit load fails closed by default.
- Fallback creates a new thread only when requested.
- Deprecated `internalSessionId` retains compatibility fallback.
- Competing selectors are rejected.
- Provider load in degraded mode is rejected.
- A malformed transcript receives a valid appended suffix but does not select startup.
- Omitting transcript options creates no library history storage.
- Resolved transcript path is observable.
- Supplied and minted logical ids are always returned on the live object.
- Catalog records retain the resolved transcript path across handoff.

### Verification

- `bun run check` passed: TypeScript plus the complete test suite.
- Full suite: 182 passed, 0 failed, 1002 expectations across 18 files.
- Focused startup/handoff/transcript suites passed.
- `git diff --check` passed.
- `bun run pack:dry` succeeded with the new public types and source changes.
- The operations smoke is fully green: 20/20 checks passed.
- The smoke reopens the handed-off logical session through consumer composition, retains
  both stable and internal ids, reuses the cataloged transcript path, and successfully
  prompts the loaded provider thread.
- Subprocess tests and smoke verification used only local deterministic fixtures; no
  network service or real harness was used.

### Known later concern

`FileSessionStore.get()` currently returns `null` for both a missing catalog file and a
malformed/unreadable one. Transcript readers already recover by skipping malformed lines,
but catalog corruption needs a separate explicit error/recovery policy in a later storage
pass rather than being silently inferred during AgentSession startup.

## Part 5.1 — Internal-session command terminology cleanup

Completed on 2026-08-15 on branch `feat/agent-session-operations`, before beginning the
single-AgentSession REPL pass.

### Reason

The Part 3 names `agentCommands`, `executeAgentCommand()`, and
`agent_commands_changed` incorrectly suggested that the commands belonged to the stable
high-level `AgentSession`. They actually come from ACP's replaceable provider backing and
can change whenever `internalSessionId` changes.

The terminology is now aligned with the identity model:

```text
AgentSession
  stable consumer-facing logical conversation
  agentSessionId remains fixed

internal session
  replaceable harness/provider thread
  internalSessionId can change
  internalSessionCommands belong here
```

### Layer-specific names

At the ACP protocol boundary, the library now mirrors ACP terminology:

```ts
client.availableCommands
client.subscribeAvailableCommands(listener)
```

The corresponding exported listener type is `AvailableCommandsListener`, normalization
is performed by `toAvailableCommands()`, and internal comparison/publication helpers use
the same name.

`AgentController` also exposes `availableCommands` and
`subscribeAvailableCommands()`, because it is the live connection/control-plane layer
directly forwarding the active ACP leaf.

At the stable logical-session boundary, ownership is made explicit:

```ts
session.internalSessionCommands
session.executeInternalSessionCommand(name, input?, handlers?)
```

and command changes use:

```ts
{
  kind: "internal_session_commands_changed",
  commands,
}
```

The command metadata types are now:

```ts
InternalSessionCommand
InternalSessionCommandInput
```

The generic activity event remains `kind: "commands"`, since it is a direct normalized
ACP update inside the prompt activity stream and already sits below AgentSession lifecycle
terminology.

### Clean migration policy

No deprecated aliases were retained for the Part 3 names. These APIs were introduced on
this feature branch and had not formed a released compatibility contract; keeping aliases
would preserve exactly the ownership ambiguity this cleanup removes.

The existing `createAgentCommands()` name in the REPL submodule was not changed in this
checkpoint. It names the legacy factory that creates a set of local interactive command
handlers, rather than the ACP-advertised command snapshot. Its naming and responsibility
belong to the next REPL architecture pass.

### Files changed

- `src/types.ts`
- `src/updates.ts`
- `src/client.ts`
- `src/controller.ts`
- `src/agent-session.ts`
- `src/index.ts`
- `src/repl/commands.ts` (dependency surface and help wording only)
- `test/updates.test.ts`
- `test/commands.test.ts`
- `test/agent-session-commands.test.ts`
- `test/agent-session-handoff.test.ts`
- `smoke-tests/test5-operations/operations-smoke.ts`
- `smoke-tests/test5-operations/README.md`

### Verification

- `bun run check` passed.
- Full suite: 182 passed, 0 failed, 1002 expectations across 18 files.
- Operations smoke: 20/20 checks passed.
- The smoke observes `internal_session_commands_changed`, reads
  `internalSessionCommands`, and executes `executeInternalSessionCommand()` against the
  deterministic harness.
- `git diff --check` passed.
- `bun run pack:dry` succeeded with the renamed public surface.
- No network service or real harness was used.

## Part 6 — Explicit REPL routing and the single-AgentSession CLI layer

Part 6 turns the three operation layers into an unambiguous input contract for an
interactive consumer. The previous REPL treated an unrecognized `/command` as an ordinary
prompt. That made a local command such as `/usage` travel through ACP to the harness when
the local handler did not recognize it—the failure that motivated this work.

The input namespaces are now:

```text
ordinary text     -> prompt the stable AgentSession
/command          -> local command for the current AgentSession
//command [input] -> command for the active internal/harness session
```

An unknown `/command` is rejected locally. It can never fall through into
`AgentClient.prompt()`. Harness command execution therefore requires the explicit `//`
namespace.

### Pure routing contract

`src/repl/repl.ts` now exports two terminal-independent helpers:

```ts
parseReplInput(raw): ReplInput
dispatchReplInput(input, actions): Promise<boolean>
```

`ReplInput` distinguishes `prompt`, `local_command`, `internal_session_command`, and
`exit`. Keeping parsing and dispatch independent of readline lets consumers reuse and test
the command policy without running an interactive terminal.

`ReplOptions` now has two separate extension points:

```ts
onSlashCommand(command, args)
onInternalSessionCommand(command, input, handlers)
```

Returning `false` from `onSlashCommand` now means “unknown local command,” not “send this
to the agent.” The generic `runRepl()` preserves the `//` escape hatch by sending the
equivalent `/name [input]` prompt when no explicit internal-session executor was supplied.
The higher-level session REPL supplies that executor directly.

### Opinionated single-AgentSession REPL

The new `src/repl/agent-session-commands.ts` exports:

```ts
createAgentSessionCommands(...)
runAgentSessionRepl(session, options?)
```

Its built-in local commands operate on exactly one stable logical session:

```text
/help
/session
/state
/commands
/handoff [SUMMARY]
/bridge
/exit
```

`/session` displays both `agentSessionId` and `internalSessionId`; `/state` exposes the
authoritative busy/queue/session snapshot; `/commands` renders ACP-advertised command
metadata as explicit `//name` invocations. `/handoff` calls the stable AgentSession method,
so the logical identity remains unchanged while its internal session is replaced.

`runAgentSessionRepl()` routes `//name [input]` through
`session.executeInternalSessionCommand(name, input, handlers)`. This is semantically the
same ACP prompt mechanism but gives consumers and tests a named, explicit operation and
keeps output streaming/activity rendering intact.

The one-session command set deliberately contains no `/new`, `/load`, `/sessions`, or
`/switch`. Those commands select or create logical AgentSessions and therefore belong to a
managed consumer/CLI above this layer. A consumer may add its own local commands through
the optional `onSlashCommand` extension without replacing the built-ins.

### Low-level controller REPL terminology

The pre-existing command factory directly mutates an `AgentController`'s ACP provider
session through `/new`, `/load`, `/resume`, and `/fork`. Calling it
`createAgentCommands()` obscured that lower-level responsibility, so it is now named:

```ts
createControllerCommands(...)
```

The related public types are now `InteractiveControllerClient`,
`ControllerCommandHandlerDeps`, and `ControllerCommandHandlers`. No compatibility aliases
were retained because the rename is occurring on the unreleased feature branch and the old
name preserved the architectural ambiguity being removed. The current CLI continues to be
the low-level controller CLI, now using the accurately named factory.

### Documentation and package surface

The README's interactive example now constructs an `AgentSession` and runs
`runAgentSessionRepl()`. It documents `/` versus `//`, the rejection of unknown local
commands, the continued availability of low-level `runRepl()` plus
`createControllerCommands()`, and the fact that a managed multi-AgentSession CLI is still a
separate layer.

The `@qlairoslabs/acp-client/repl` entry point exports the parser/dispatcher, both REPL
layers, their factories, and their structural consumer types.

### Files changed

- `src/repl/repl.ts`
- `src/repl/agent-session-commands.ts` (new)
- `src/repl/commands.ts`
- `src/repl/index.ts`
- `src/cli/index.ts`
- `README.md`
- `test/repl-routing.test.ts` (new)
- `test/commands.test.ts`

### Verification

- `bun run check` passed.
- Full suite: 192 passed, 0 failed, 1029 expectations across 19 files.
- Routing tests prove `/usage` invokes only the local/unknown actions and never the prompt
  action.
- Routing tests prove `//usage workspace` invokes only the internal-session action.
- Single-session command tests cover help boundaries, both identities, state, advertised
  command rendering, summary forwarding during handoff, and unknown-command behavior.
- Operations smoke: 20/20 checks passed.
- `bun run pack:dry` succeeded and includes `src/repl/agent-session-commands.ts`.
- The terminology audit found no stale `createAgentCommands`, `executeAgentCommand`, or
  old advertised-command names in source, tests, smoke tests, or README.
- `git diff --check` passed.
- No network service or real harness was used.

## Part 7 — Consumer integration guide

Added `CONSUMER_GUIDE.md` as the orchestration-oriented entry point for consumers. The
guide describes the library as three deliberately separate operation layers rather than
presenting slash commands as the architecture:

1. Consumer-owned logical session management through `SessionManager`, a consumer-owned
   map of live objects, and explicit `AgentSession.create()` composition.
2. Stable `AgentSession` operations such as prompt, state observation, interrupt, stop,
   bridge, and same-harness handoff.
3. Active internal/harness session discovery and execution through
   `internalSessionCommands`, `internal_session_commands_changed`, and
   `executeInternalSessionCommand()`.

The guide includes complete patterns for adapter resolution, custom adapters, catalog and
live-registry ownership, new logical sessions, reopening from catalog metadata, session
listing/selection, streaming prompts, permission handling, notification-driven scheduling,
shutdown, transcripts, harness commands, the low-level controller escape hatch, and a
custom non-readline command router.

### AgentSession command exposure

The guide answers the command-reuse question explicitly. Consumers can import from the
`@qlairoslabs/acp-client/repl` subpath:

```ts
createAgentSessionCommands(...)
runAgentSessionRepl(...)
parseReplInput(...)
dispatchReplInput(...)
```

`createAgentSessionCommands()` exposes the same handler used by the opinionated
single-session REPL. It currently handles `/help`, `/session`, `/state`, `/commands`,
`/handoff`, and `/bridge`; `/exit` belongs to the REPL loop.

The current asymmetry is documented rather than hidden: internal/harness commands expose
structured metadata through `session.internalSessionCommands`, while local AgentSession
commands currently expose only an executable handler, not a public metadata array. A
consumer can reuse the handler directly, but must presently define its own labels and
descriptions for a graphical command palette.

### Handoff boundary

The guide records the current handoff contract following the cross-harness design review:
handoff preserves the logical id but only creates a new thread on the current adapter. A
provided summary can bypass generation, but the summary-generation and continuation
prompts are otherwise fixed; the continuation is a user prompt, and ACP `session/new` has
no portable system-prompt field. Cross-adapter handoff and independent prompt policies are
identified as future API work.

### Publication

The README now links to the consumer guide near the start of Usage. The package `files`
list includes `CONSUMER_GUIDE.md`, ensuring that the relative README link resolves in an
installed/npm package instead of only in the repository.

### Files changed

- `CONSUMER_GUIDE.md` (new)
- `README.md`
- `package.json` (published-files list)

### Verification

- `bun run typecheck` passed.
- `bun run pack:dry` succeeded.
- The dry-run includes `CONSUMER_GUIDE.md` in the package (38 total files).
- `git diff --check` passed.

## Part 8 — Pi preset and custom-adapter CLI wiring

Confirmed the architectural boundary before implementation: the core library was already
adapter-agnostic. `Adapter` contains launch information only (`command`, optional
`ptyCommand`, and an optional display label), while capabilities, authentication,
configuration, session support, and harness commands are discovered after ACP
initialization. The hardcoded restriction existed only in the executable CLI, which typed
`--adapter` as `keyof ADAPTERS` and indexed the preset map directly.

### Pi convenience preset

Added:

```ts
ADAPTERS.pi = {
  command: ["pi-acp"],
  ptyCommand: ["pi"],
  displayName: "Pi",
};
```

The selected harness is `@automatalabs/pi-acp`, which embeds Pi through its published SDK
and speaks ACP over stdio. The npm package inspected during this work was version 0.6.3;
its published executable is `pi-acp`. The preset encodes only that launch mechanism; Pi's
actual ACP surface remains dynamically discovered. The native `pi` executable remains the
interactive PTY command used by bridge/degraded mode.

### Generic CLI adapter resolution

Added `src/cli/adapter.ts` with pure, tested helpers:

```ts
resolveCliAdapter(selection)
parseCommandArg(value, flag)
```

The CLI continues accepting presets:

```bash
acp-client chat --adapter pi
```

It now also accepts any custom ACP process:

```bash
acp-client chat \
  --adapter private \
  --adapter-command '["private-agent","serve","--acp"]' \
  --pty-command '["private-agent","chat"]' \
  --adapter-name "Private Agent"
```

`--adapter-command` and `--pty-command` accept a plain executable or an exact JSON argv
array. JSON arrays avoid lossy whitespace splitting and preserve paths/arguments containing
spaces. When a custom command omits `--adapter`, the CLI derives an id from the executable
basename. Unknown preset ids fail with the known preset list and custom-adapter guidance.

The resolved `adapterId` is also supplied to the existing controller command factory,
keeping catalog metadata coherent when that optional integration is used.

### Documentation

README now includes Pi in the supported/convenience list, shows both Pi and custom CLI
invocations, and states explicitly that presets are launch shortcuts rather than provider
feature definitions. The consumer guide includes `ADAPTERS.pi` in its resolver example and
explains the Pi RPC-to-ACP bridge.

### Files changed

- `src/adapters.ts`
- `src/cli/adapter.ts` (new)
- `src/cli/index.ts`
- `test/cli-adapter.test.ts` (new)
- `README.md`
- `CONSUMER_GUIDE.md`

### Verification

- `bun run check` passed.
- Full suite: 205 passed, 0 failed, 1055 expectations across 22 files.
- Focused CLI/adapter suite: 11 passed, 0 failed.
- Tests cover Pi preset resolution, the existing Kimi default, custom adapters, derived
  ids, unknown presets, exact JSON argv, and malformed/empty values.
- `git diff --check` passed.
- Pi itself is installed locally, but `pi-acp` is not; no live Pi ACP conversation was run.
