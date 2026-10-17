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
- **A dead process is not replaced.** When the process exits unexpectedly, `onCrash` clears the transport and the
  session id; the provider is only started again from `open()` (`AgentSession.start` / `startPersistent`). The next
  prompt on that conversation fails until the consumer reopens it.
- **Internal inference and recap wait without bound.** `HarnessInternalInferenceRuntime.run` awaits
  `controller.prompt`; `create()` with `adoption.recap` awaits the recap (known gap).

## Guarantee

For every operation (a conversation turn, an internal inference attempt, a recap, and the control requests below):

1. Its state is always visible: what it is doing and since when.
2. It always ends, in bounded time once it stops making progress, with a recorded reason.
3. After it ends, the conversation accepts the next prompt with no call other than `prompt()`.

It does **not** bound how long a working operation may take. A turn that streams, or runs tools, for an hour is fine.

## Terms

- **Activity:** any `session/update` notification for the operation's session (text, thought, tool call, tool update,
  plan, usage, anything), and any request from the agent to the client (permission, file read/write, terminal).
- **Tool in flight:** a tool call announced and not yet `completed` or `failed`. The same tracking steering uses for
  its boundaries (`SteeringController.observeActivity`); it moves to one place and both read it.
- **Permission pending:** the agent is waiting on the consumer. Never a stall.

## 1. Visibility (always on)

Each running operation has a stage:

| Stage | Meaning |
|---|---|
| `waiting` | sent, no activity yet |
| `streaming` | activity seen, no tool in flight |
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
  readonly lastActivityAt: number | null;
  readonly toolsInFlight: number;
  /** Set while cancelling: why, and when the cancel was first sent. */
  readonly cancel?: { readonly reason: CancelReason; readonly requestedAt: number };
}
```

An event `operation_stage_changed` fires on stage changes only. `lastActivityAt` is read from the snapshot, not
evented per update.

## 2. Stall policy (on by default, every kind)

A stall is silence where silence is not explained:

| Stage | Limit |
|---|---|
| `waiting` | `firstActivityMs` |
| `streaming` | `idleMs` since the last activity |
| `tool_running` | none (a build or test may run for a long time) |
| `awaiting_permission` | none (waiting on us) |

When a limit is reached, the operation is cancelled (section 3) with reason `stalled`, and its phase is recorded:

- `no_response`: nothing arrived (stalled in `waiting`);
- `incomplete_response`: something arrived, then nothing (stalled in `streaming`).

Provisional defaults, to be replaced by measurement (section 9): `firstActivityMs` 120 000, `idleMs` 180 000. They are
deliberately below OpenCode's own 300 s header timeout: a harness only cares about itself, and this library runs many
of them.

`idleMs` also covers the silent gap between two model requests inside one turn (after a tool result, before the next
model response). Thinking models normally stream thought chunks, which count as activity.

## 3. Bounded cancel (always on)

Every cancel goes through one path, whoever asks for it: `interrupt()`, steering, the stall policy, `stop()`, an
internal-inference abort signal.

1. Send `session/cancel`. Stage `cancelling`.
2. At half the grace, send it again (a notification can be lost or arrive before the harness is ready for it).
3. At `cancelGraceMs`, force-stop: kill the provider process (the existing SIGTERM, 500 ms, SIGKILL), end the in-flight
   request as forced, and mark the provider disconnected.

`cancelGraceMs` is per adapter, default 30 000. The measured OpenCode cancel latency is ~65 ms, so a forced stop means
the harness is not answering, not that it is slow.

The result records how the cancel ended: `cancel: "acknowledged" | "forced"`. A steer or interrupt that had to be
forced still ends with `endedBy: "steer" | "interrupt"`; it is the same ending, reached the hard way.

Killing the process is safe for the conversation because each conversation owns its provider process. Disposable
internal-inference sessions already end with `stop()`.

## 4. After the operation ends

### Conversation turn

The turn ends with an error. The user's message was delivered and stays in the transcript as sent; what is missing is
the model's reply.

- `prompt()` **rejects** with `OperationStalledError` (code `stalled`, `phase`, `operationId`, and the messages that did
  arrive). It does not resolve normally, because a consumer that does not check would take half a reply for a full
  one.
- A partial assistant message is stored with status `incomplete`.
- An error record is written: code `stalled`, source `operation`, recoverability `retryable`, with the phase.

**Resend.** With `turns.resendUnanswered: true` and phase `no_response`, the library sends the same prompt once more,
in the same operation, before giving up. If the second attempt also stalls, the turn rejects as above. It never
resends after `incomplete_response`: tools may already have acted. Default `false`: one prompt is one attempt, the
consumer learns of the failure after one wait instead of two, and the harness's history never gets the prompt twice
unless someone asked for it. To try again, the consumer calls `prompt()` again; there is no separate retry API.

### Recovery of the conversation (always)

Self-healing is not a setting.

- **Cancel acknowledged:** the process and the session are untouched. Nothing to do.
- **Forced stop, or the process exited on its own** (the same path; today's crash case is included): the next operation
  that needs the provider (the resend, the next prompt, a config change) starts a new process and loads the session
  with `session/load`, falling back to checkpoint recovery under the existing recovery rules. An event
  `provider_reconnected` reports which (`loaded` | `recovered`).
- Prompts queued meanwhile wait for the reconnect; they do not fail.
- If the reconnect fails, that operation fails with the existing codes (`provider_session_load_failed`,
  `recovery_failed`) and the next operation tries again. The conversation never enters a state that only a call other
  than `prompt()` can leave.

### Internal inference attempt

The attempt fails with code `stalled` in its `failureDetails`; the existing retry policy (`retry.maxAttempts`,
`backoffMs`) runs the next attempt in a fresh session. No change to how attempts are counted.

### Recap

The recap is abandoned; the adoption still succeeds. An `adoption_recap_failed` record carries code `stalled`, and the
checkpoint floor is placed without a recap (`adoption_baseline`). This closes the "`create()` waits on the recap with no
timeout" gap.

### Control requests

`initialize`, `session/new`, `session/load`, `session/set_config_option`, `session/set_mode`, `session/list` and
`session/delete` are not inference. They get a plain deadline, `control.requestMs` (default 60 000; `session/load` of a
long history may need more, measure). On expiry the request fails with code `provider_request_timeout`, the process is
force-stopped, and recovery is as above.

### Upstream accounting

A cancelled or forced attempt keeps its metering record with status `cancelled` and usage `null` when the provider did
not report any. A gateway in front of the provider must account for cancelled upstream requests on its own; the
library records what it saw and never invents usage.

## 5. Records and the turn ending

New error codes in `CONVERSATION_ERROR_CODES`: `stalled`, `provider_request_timeout`.

The turn ending extends `PromptEndedBy` from `"steer" | "interrupt"` to `"steer" | "interrupt" | "stalled" | "error"`.
Persisting it with the turn is requirement 3 of `10-13-acp-client-requirements.md`; this spec fixes the values, and
requirement 3 stores them, so after a reload a client can show "Redirected", "Stopped" or "No response".

## 6. Settings (per operation kind)

```ts
interface OperationLifecycleConfig {
  readonly turns?: {
    readonly firstActivityMs?: number | false;
    readonly idleMs?: number | false;
    /** Resend the prompt once when nothing came back. Default false. */
    readonly resendUnanswered?: boolean;
  };
  readonly internalInference?: { readonly firstActivityMs?: number | false; readonly idleMs?: number | false };
  readonly recap?: { readonly firstActivityMs?: number | false; readonly idleMs?: number | false };
  readonly control?: { readonly requestMs?: number };
}
```

- Set on the Agent config; `false` turns a limit off for that kind.
- `cancelGraceMs` is per adapter (adapter config), not per kind: it depends on how the harness answers a cancel.
- Bounded cancel and recovery have no switch.
- Not in this step: per-conversation overrides through the resolver, and a per-prompt override for a known-long
  request. Both fit the shape later.

## 7. Where it lives

```
 queue (AgentConversationQueue) ──► OperationSupervisor ──► controller
                                     │  stage, lastActivityAt     prompt(), cancel(), forceStop()
                                     │  stall timers
                                     │  cancel escalation
 steering ── requestCancel("steer") ─┘  (reads stage / tools in flight)
```

- `OperationSupervisor` (new, `src/operations/`) wraps one provider request: it starts it, observes activity, runs the
  stall timers, and owns every cancel. Steering stops calling `controller.interrupt()` directly and asks the supervisor;
  its boundary detection reads the supervisor's tool tracking.
- The controller supplies two primitives and nothing else for this: `cancel()` (today's `interrupt`) and `forceStop()`
  (new: kill the process, reject the in-flight prompt with a forced-stop error, become disconnected). For a later
  model-call controller these are "abort the stream" and "drop the connection".
- `HarnessInternalInferenceRuntime.run` and the recap run their prompt through the same supervisor.
- Reconnect-on-demand lives in `AgentSession`, next to `startPersistent`, reusing its load-or-recover logic.

This is the first slice of the provider-session interface (step 3 of the note's order).

## 8. Non-goals

- No limit on total duration.
- No automatic resend after any reply arrived.
- No retry API.
- No limit while a tool runs or a permission is pending.
- No change to the provider's own retries: if a harness retries internally and streams within our limits, we never
  notice.

## 9. Measurements before the defaults

Spend tokens; run with the user's authorization, throwaway sessions only, models not set.

- Cancel latency (cancel sent → prompt resolved) on Codex and Claude; OpenCode has ~65 ms.
- Time to first activity distribution per adapter.
- The longest silent gap mid-turn with no tool in flight (between model requests, thinking models).
- `session/load` duration for a long history (for `control.requestMs`).

## 10. Tests

Replay-agent fixture modes (env-driven, like the existing `REPLAY_AGENT_*`):

- silent forever after a prompt → `stalled`/`no_response`; with `resendUnanswered` one resend, then reject;
- partial text then silence → `stalled`/`incomplete_response`, partial message `incomplete`, no resend;
- ignores `session/cancel` → second cancel at half grace, forced stop at grace, `cancel: "forced"`, next prompt
  reconnects with `session/load`;
- exits mid-turn → turn fails `provider_process_exited`, next prompt reconnects;
- a long tool call with no other activity → no stall;
- pending permission → no stall;
- steer against a harness that ignores cancel → delivered after the forced stop, `endedBy: "steer"`;
- internal inference stall → attempt fails `stalled`, retry in a fresh session;
- recap stall → adoption succeeds, baseline floor, `adoption_recap_failed`;
- control request deadline → `provider_request_timeout`, recovery.

Timers injectable so the tests run in milliseconds.

## 11. Open details

- Metering of a resent turn: one operation with two provider requests. Either one record with the second attempt's
  usage plus a note, or one record per attempt under the same operation id. Decide with requirement 1 (operation ids on
  all records).
- A harness that sends periodic `usage` updates while otherwise silent would hide a stall. Count only non-usage updates
  if measurement shows this happens.
- Whether `stop()` should skip the grace (force immediately after one cancel), since the caller is tearing down anyway.
