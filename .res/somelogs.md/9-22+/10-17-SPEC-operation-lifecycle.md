# Operation lifecycle: never invisible, never stuck

Status: spec, not implemented. 2026-10-17. Step 1 of the order in `10-17-NOTE-model-call-controller.md`, before the
10-13 requirements (`10-13-acp-client-requirements.md`). Builds on steering (`10-2-SPEC-steer-pending-messages.md`) and
the error records (`9-22-SPEC-conversation-error-records.md`).

## Problem

Every request to a provider should behave like an HTTP request from the consumer's point of view: it may or may not
work, but it is never (a) invisible to the consumer, and (b) never left hanging so that the conversation needs a manual
reset.

Today neither is guaranteed:

- **Silence is invisible.** While a prompt runs, the consumer sees updates when they arrive and nothing when they
  don't. Nothing says "sent 4 minutes ago, nothing back yet".
- **A stalled request is not bounded.** Measured on OpenCode (`10-4-LOG-adopt-provider-session.md`, 2 of 80 runs): the
  upstream request got no response headers, OpenCode's own header timeout fired at 300 s, it retried inside the same
  process, and the retry answered (310 s, 322 s total). The library saw one long silent prompt and no error. Other
  harnesses may have no such timeout, and then the prompt never ends.
- **Cancel is fire-and-forget.** `AcpClient.interrupt()` sends `session/cancel` (a notification, never acknowledged) and
  waits for the prompt to resolve on its own (`src/client.ts`, `interrupt`). If the harness ignores it, the turn never
  ends. Steering cancels at every steer boundary, so this path is used often.
- **A cancel leaves our own permission requests unanswered.** `AcpClient.handlePermission` awaits the consumer's
  handler with no way to end that wait. ACP requires the client to answer every pending `session/request_permission`
  with `cancelled` once it sends `session/cancel`. A Stop or a steer during an open permission prompt can therefore
  wait on us, not on the harness.
- **A dead process is not replaced.** When the process exits unexpectedly, `onCrash` clears the transport and the
  session id; the provider is only started again from `open()` (`AgentSession.start` / `startPersistent`). The next
  prompt on that conversation fails until the consumer reopens it.
- **Internal inference and recap wait without bound.** `HarnessInternalInferenceRuntime.run` awaits
  `controller.prompt`; `create()` with `adoption.recap` awaits the recap (known gap).

## Guarantee

For every operation (a conversation turn, an internal inference attempt, and a recap; control requests are out of
scope, see section 6):

1. **Visible.** Its state is always readable: what it is waiting on and since when.
2. **Ends when stale.** When it is stale (section 2), it ends in bounded time with a recorded reason.
3. **Cancel is bounded.** Any cancel ends it within the cancel grace, whatever the harness does.
4. **Usable afterwards.** After it ends, the next `prompt()` either runs, or is refused with a visible reason that
   does not change on retry (`continuation_unavailable`). How the conversation continues once its provider session is
   gone is decided by the existing continuation rules, not by this spec (section 4).

Not promised: a bound on how long a working operation takes. A turn that streams, or runs tools, for an hour is fine.
An operation waiting on something identified (a tool in flight, a pending permission) is not stale; it stays visible in
that stage, and a cancel still ends it within the grace.

## Terms

- **Output:** any `session/update` notification for the operation's session (text, thought, tool call, tool update,
  plan, usage, anything), and any request from the agent to the client (permission, file read/write, terminal).
- **Tool in flight:** a tool call announced and not yet `completed` or `failed`. The same tracking steering uses for
  its boundaries (`SteeringController.observeActivity`); it moves to one place and both read it.
- **Permission pending:** a permission request the consumer has not answered.

## 1. Visibility (always on)

Each running operation has a stage:

| Stage | Meaning |
|---|---|
| `waiting` | prompt sent, no output yet |
| `streaming` | output seen, no tool in flight |
| `tool_running` | at least one tool in flight |
| `awaiting_permission` | a permission request is pending |
| `cancelling` | a cancel was requested and the request has not ended |

Exposed on the session snapshot and on internal-inference handles:

```ts
interface OperationActivity {
  readonly operationId: string;
  readonly kind: "turn" | "internal_inference" | "recap";
  readonly stage: OperationStage;
  readonly startedAt: number;
  readonly lastOutputAt: number | null;
  readonly toolsInFlight: number;
  /** Set while cancelling: why, and when the cancel was first sent. */
  readonly cancel?: { readonly reason: CancelReason; readonly requestedAt: number };
}

type CancelReason = "interrupt" | "steer" | "stalled" | "stop" | "abort";
```

The snapshot also shows the provider connection: `connected` | `disconnected` (after a forced stop or an exit, until
the next operation reconnects, section 4) | `reconnecting`.

An event `operation_stage_changed` fires on stage changes only. `lastOutputAt` is read from the snapshot, not evented per
update.

## 2. When an operation is stale

Stale is a condition that must be met, not the absence of a list of good signs. An operation is active by default, and
stale only when **all** of these hold:

1. **The provider owes model output.** One of:
   - the prompt was sent and nothing has come back (`waiting`);
   - the last tool in flight ended and nothing has come after it: the model owes its next response;
   - a message was streaming and stopped before the turn ended.
2. **Nothing explains the silence.** No tool in flight, no pending permission, no harness signal recognised as work.
   That list starts empty; a harness notice for compaction or similar is added when the measurements (section 10) show
   one exists.
3. **It has lasted longer than the limit** for the situation:
   - `firstOutputMs`: the first case;
   - `nextOutputMs`: the other two.

Everything else is never timed: tools running, pending permissions, session loads with their replay, logins.

Provisional defaults, replaced by measurement: `firstOutputMs` 120 000, `nextOutputMs` 180 000. Both are below
OpenCode's own 300 s header timeout on purpose: a harness only cares about itself, and this library runs many of them.
An optional `toolMs` (off by default) bounds a single tool in flight, for consumers who would rather fail a hung tool
than wait.

When a stale operation is detected, it is cancelled (section 3) with reason `stalled`, and its phase is recorded:

- `no_response`: nothing arrived;
- `incomplete_response`: something arrived, then nothing.

Known false-stale risk: automatic compaction (Claude, Codex) can be minutes of silence after a tool result. Unless the
harness signals it, it meets condition 1, and `nextOutputMs` must cover it.

## 3. Bounded cancel (always on)

Every cancel goes through one path, whoever asks for it: `interrupt()`, steering, the stall policy, an
internal-inference abort signal.

1. Answer every pending permission request of the session with `cancelled`, and abort the consumer's permission handler
   (it receives an `AbortSignal`; a late answer is ignored).
2. Send `session/cancel`. Stage `cancelling`.
3. At half the grace, send it again (a notification can be lost or arrive before the harness is ready for it).
4. At `cancelGraceMs`, force-stop: kill the provider process (the existing SIGTERM, 500 ms, SIGKILL), end the in-flight
   request as forced, and mark the provider disconnected.

`cancelGraceMs` is per adapter, default 30 000. The measured OpenCode cancel latency is ~65 ms, so a forced stop means
the harness is not answering, not that it is slow.

The ending records how the cancel went: `cancel: "acknowledged" | "forced"`. A steer or interrupt that had to be forced
resolves exactly as an acknowledged one: the cancelled result, `endedBy: "steer" | "interrupt"`, the messages that
arrived, plus `cancel: "forced"`. The forced-stop rejection from the controller is converted, never surfaced. The
follow-up steer is then delivered after the reconnect.

`stop()` is not a cancel and is unchanged: it already sends `session/cancel` and kills the process right away. The
grace applies only to cancels after which the conversation carries on.

Killing the process is safe for the conversation because each conversation owns its provider process. Disposable
internal-inference sessions already end with `stop()`.

## 4. After a stale turn

The user's message was delivered and stays in the transcript as sent. What is missing is the model's reply, so the
turn ends with an error:

- `prompt()` **rejects** with `OperationStalledError` (code `stalled`, `phase`, `operationId`, the messages that did
  arrive, and `followedBy` when steers were delivered after it). It does not resolve normally: a consumer that does not
  check would take half a reply for a full one.
- The conversation recovers (below), then sends what the user said next.

Nothing is resent. A resend would duplicate the prompt in the harness's history, is awkward with attachments, and
makes the user wait twice to see the error. To try again, the user sends a message.

### Recovery of the conversation (always)

Self-healing is not a setting.

- **Cancel acknowledged:** the process and the session are untouched. Nothing to do.
- **Forced stop, or the process exited on its own** (the same path; today's crash case is included): the next operation
  that needs the provider starts a new process and loads the session with `session/load`. An event
  `provider_reconnected` reports how it continued (`loaded` | `recovered`).
- **The load fails** (the harness no longer has the session): this spec adds no rule of its own. The conversation
  applies the same rule it applies when it is opened:

  | Conversation | Existing rule (at open) | After a crash |
  |---|---|---|
  | Agent-owned | `onLoadFailure`: checkpoint recovery (`ConversationManager`, extracted as `recoverAfterLoadFailure`) | the same, in place (`recoverInPlace`); already implemented |
  | SessionManager | the conversation's `ContinuationStrategy` list, in order (`acquireOpeningContinuation`): load, then `new_from_transcript`, then `new_from_consumer_continuation` as configured | the same list; the part of `acquireOpeningContinuation` that only opening needs (transcript bootstrap) is separated so both call it |
  | no persistence | `sessionLoadFailure` (`"new"` starts a fresh session, `"error"` fails) | the same |

  When the rule has nothing left (for SessionManager, the default list is load only: a replacement session spends
  tokens and changes routing, so it is used only when the consumer configured it), the conversation is marked
  "can't continue": `promptability` reports `continuation_unavailable` with the attempts and their reasons, and
  `prompt()` is refused with it, instead of failing on every prompt with a load error.
- **A transient failure** (the process could not be started, the load request itself failed rather than reporting the
  session missing) fails that operation with the existing codes (`provider_session_load_failed`, `recovery_failed`),
  and the next operation tries again.
- `ensureProvider` owns only noticing that the process is gone, starting a new one, and handing a failed load to the
  conversation's rule. It does not decide how the conversation continues.

### Pending messages after a failed turn

A stall is a steer boundary: the turn is already lost, so cancelling costs nothing.

- **Steers** waiting at the head of the queue are delivered as soon as the conversation has recovered, combined into one
  prompt as at any other boundary (`message_delivered` with `via: "stall"`). In
  `work on X` → stall → `what happened?` + `anddd...??`, the two steers are the next prompt. This applies to both phases:
  the steers are the user's new words, not a repeat.
  The steers combined are those **up to the next queued message, not including it**. A held queued message keeps its
  place: steers sent after it run after it, in order. In
  `work on X` → stall → `what happened?` (steer) + `deploy the website` (queue) + `and update the record` (steer),
  the recovery prompt is `what happened?` alone; when it completes, the hold is released and `deploy the website`
  runs, then `and update the record`.
- **Queued** messages are for the happy path: they assume the turn before them did what it was meant to do. After a
  turn that ends `stalled` or `error`, every queued message is **held** (`message_held`, naming the failed turn).
- While held:
  - a new message sent with `steer` (the default delivery) runs right away, even though the conversation is idle;
  - a new message sent with `queue` goes to the end of the held queue. `queue` is an explicit choice and is respected;
  - `withdraw()` works as usual.
- The held queue is **released** (`message_released`) by the next consumer turn that completes normally (internal prompts such as a recap do not release it). Its messages then run in
  order, including those added while held.

Accepted consequence: a consumer that sends only `queue` (for example `busyDelivery: "queue"`) sees everything pile up
after a failure until it sends one prompt with `delivery: "steer"` or withdraws. It is visible: every held message has
its event, and the snapshot shows the hold. No release call is added.

Holding applies only after `stalled` and `error`, and only for a turn the provider received. A prompt rejected before it
was sent (blocked, invalid input, the provider could not be reached) did not fail at the provider and holds nothing;
it fails on its own as today. After `interrupt` and `steer`, pending messages behave as today.

## 5. Internal inference and recap

- **Internal inference attempt:** a stale attempt fails with code `stalled` in its `failureDetails`; the existing retry
  policy (`retry.maxAttempts`, `backoffMs`) runs the next attempt in a fresh session. No change to how attempts are
  counted.
- **Recap:** a stale recap is abandoned and the adoption still succeeds. The `adoption_recap_failed` record carries the
  stall in its details, and the checkpoint floor is placed without a recap (`adoption_baseline`). This closes the
  "`create()` waits on the recap with no timeout" gap.

## 6. Control requests

Revised 2026-10-18: no deadlines. Requests that are not inference (`initialize`, `session/new`, `session/load`,
`session/list`, `session/delete`, `session/set_config_option`, `authenticate`) wait for the harness's answer, as they
did before this spec. They end when the harness answers or when the process exits: the ACP SDK rejects every pending
request when the connection closes.

A first implementation gave each kind a fixed deadline (`control.requestMs`, `initializeMs`, `loadIdleMs`, default
60 s) that force-stopped the process on expiry. It was removed because it contradicted "active by default":

- no hanging control request was ever observed; the clock only guessed at one;
- a slow `session/list` sent during a healthy turn killed the turn;
- a large session can take a minute or more to load, possibly before any replay update. A deadline would kill that
  load on every attempt, turning a slow conversation into an unusable one.

Long sessions that load slowly are a separate topic (automatic rotation or handoff).

## 7. Records and events

What a stale turn leaves, all through the existing write paths:

| Kind | Where |
|---|---|
| error record: code `stalled`, phase, operation id; source `operation`, recoverability `retryable` | database, and the committed-record event bus |
| the partial assistant message, with the status the existing failure path already writes (`failed`) | database |
| the metering record: outcome `cancelled`, usage `null` if the provider reported none | database |
| what the load or checkpoint recovery path already writes | database |
| how the turn ended: `stalled` (requirement 3) | database |
| `turn_failed` with the stall error | live event |
| `provider_reconnected` (`loaded` / `recovered`) | live event |
| `message_delivered` (`via: "stall"`), `message_held`, `message_released` | live events |

The library has no setting to hide a failure or a recovery. Every piece is typed, so a consumer that wants a quiet UI
filters out the `stalled` record, and one that wants it explicit shows "No response, recovered".

New error code in `CONVERSATION_ERROR_CODES`: `stalled`.

**The turn ending.** `PromptEndedBy` goes from `"steer" | "interrupt"` to `"steer" | "interrupt" | "stalled" | "error"`:

- `stalled`: section 2;
- `error`: the process exited mid-turn, or the request failed for any other reason.

Live, a turn ending `stalled` or `error` rejects, so these two values appear only in persisted history. Persisting it
with the turn is requirement 3 of `10-13-acp-client-requirements.md`; this spec fixes the values, and requirement 3
stores them, so after a reload a client can show "Redirected", "Stopped" or "No response".

**Upstream accounting.** A cancelled or forced attempt keeps its metering record; the library never invents usage. A
gateway in front of the provider must account for cancelled upstream requests on its own.

Metering stays one record per operation. A record is one provider request's reading (one `usage.status`, one report,
one `nextState` in the chain, keyed `(agent_conversation_id, operation_id)`), so steers delivered after a stall are
their own operation and record, as after any steer.

## 8. Settings (per operation kind)

```ts
interface OperationLifecycleConfig {
  readonly turns?: StaleLimits;
  readonly internalInference?: StaleLimits;
  readonly recap?: StaleLimits;
}

interface StaleLimits {
  readonly firstOutputMs?: number | false;
  readonly nextOutputMs?: number | false;
  /** Off by default. */
  readonly toolMs?: number | false;
}
```

- Set on the Agent config; `false` turns a limit off for that kind.
- `cancelGraceMs` is per adapter (adapter config), not per kind: it depends on how the harness answers a cancel.
- Bounded cancel, recovery, and steer delivery after a stall have no switch.
- Not in this step: per-conversation overrides through the resolver, and a per-prompt override for a known-long
  request. Both fit the shape later.

## 9. Where it lives

```
 queue (AgentConversationQueue) ──► OperationSupervisor ──► controller
                                     │  stage, lastOutputAt       prompt(), cancel(), forceStop()
                                     │  stale timers
                                     │  cancel escalation, pending permissions
 steering ── requestCancel("steer") ─┘  (reads stage / tools in flight)
```

- `OperationSupervisor` (new, `src/operations/`) wraps one provider request: it starts it, observes output, runs the
  stale timers, and owns every cancel. Steering stops calling `controller.interrupt()` directly and asks the supervisor;
  its boundary detection reads the supervisor's tool tracking, and a stall is one more boundary for it.
- The controller supplies two primitives and nothing else for this: `cancel()` (today's `interrupt`) and `forceStop()`
  (new: kill the process, reject the in-flight prompt with a forced-stop error, become disconnected). For a later
  model-call controller these are "abort the stream" and "drop the connection".
- `HarnessInternalInferenceRuntime.run` and the recap run their prompt through the same supervisor.
- Reconnect-on-demand lives in `AgentSession` (`ensureProvider`). After a failed load it calls the conversation's
  existing continuation rule (section 4); it has no load-or-recover logic of its own.
- The hold is steering state: it already owns the pending list and its events.

**What it does not own.** Updates keep their current path: transport → `AcpClient` (response accumulation, prompt
handlers) → `AgentSession`, which fans them out to record capture, presentation, steering and metering. The supervisor
is one more observer of that stream; it never holds or rewrites content. It owns only timing, the stage, the stale
timers, the cancel escalation and the ending reason.

**How it reports.** Through the existing channels, no new mechanism: the snapshot (`emitStateIfChanged`), the
`AgentSessionEvent` stream next to `turn_started` / `turn_failed`, the normal persistence writes (hence the
committed-record event bus, `src/observation/agent-event-bus.ts`), and the internal-inference handle subscriptions
(`coordination/handles.ts`).

This is the first slice of the provider-session interface (step 3 of the note's order).

## 10. Measurements before the defaults

Run at the end, before the release: they only set default values. Spend tokens; approved by the user; throwaway
sessions only; models not set.

- Cancel latency (cancel sent → prompt resolved) on Codex and Claude; OpenCode has ~65 ms.
- Time to first output, per adapter.
- The longest silent gap mid-turn with no tool in flight, including automatic compaction, and whether any harness
  signals compaction over ACP.
- `session/load` duration and replay gaps for a long history.

## 11. Tests

Replay-agent fixture modes (env-driven, like the existing `REPLAY_AGENT_*`), timers injectable so they run in
milliseconds:

- silent after a prompt → `stalled` / `no_response`, rejection, error record, conversation usable;
- partial text then silence → `stalled` / `incomplete_response`, partial message stored as `failed`;
- stall with steers pending → steers delivered after recovery, `via: "stall"`, `followedBy` on the error;
- stall with queued messages → held; a `queue` message joins them; a `steer` message runs and its completion releases
  them in order; `withdraw()` works while held;
- ignores `session/cancel` → second cancel at half grace, forced stop at grace, `cancel: "forced"`, the steer or
  interrupt result unchanged otherwise, next prompt reconnects with `session/load`;
- cancel during a pending permission → the request is answered `cancelled`, the handler aborted;
- exits mid-turn → turn fails with `endedBy` `error`, queue held, next prompt reconnects;
- the harness lost the session after a crash → Agent-owned recovers from a checkpoint; SessionManager follows its
  strategy list (`new_from_transcript` when configured); with nothing left, `continuation_unavailable` is visible in
  `promptability` and the next prompt is refused with it rather than retrying the load;
- a long tool call with no other output → not stale; with `toolMs` set → stale;
- pending permission for longer than every limit → not stale;
- internal inference stall → attempt fails `stalled`, retry in a fresh session;
- recap stall → adoption succeeds, baseline floor, `adoption_recap_failed`;
- an unanswered control request during a running turn → neither fails nor stops the turn.

## 12. Open

- A harness that sends periodic `usage` updates while otherwise silent would hide a stall. Not observed; left open.
  If it shows up, usage updates stop counting as output.
- Consumers: requirement 12 suggests agents-core retires and reopens a conversation it sees as disconnected.
  Reconnect-on-demand changes what consumers see; the release notes say so.
