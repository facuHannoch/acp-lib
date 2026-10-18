# Plan: building the operation lifecycle

2026-10-18. How to build `10-17-SPEC-operation-lifecycle.md` without duplicating what exists and without growing
`agent-session.ts` (4.5k lines). Two parts: what already exists and is reused, and where the new code goes.

## 1. What already exists

Each row: what the spec needs, what is there today, and what to do with it.

| Need | Exists today | Plan |
|---|---|---|
| Tools in flight | Tracked twice: `SteeringController.#active.tools` (`steering/controller.ts:81`, for boundaries) and `ActivityAggregator.tools()` (`activity.ts:283`, for presentation). | One small tracker in `operations/`; steering reads it. The aggregator stays a presentation fold and is not used for timing. |
| Seeing provider output | Only through the per-prompt handlers built in `runPrompt` (`agent-session.ts` ~3330). Internal prompts (`meteredInternalPrompt`, `HarnessInternalInferenceRuntime`) call `controller.prompt(text)` with no handlers, so they see nothing. | A controller-level output subscription, same pattern as the existing `subscribeUsageUpdate` (`controller.ts:186`), fed by `AcpClient` for every update and every agent→client request. The supervisor subscribes; no handler plumbing. |
| Cancel | `AcpClient.interrupt` (`client.ts` ~765) sends `session/cancel` once. Called from three places: `AgentSession.interrupt`, the steering host's `cancelProviderTurn` (`agent-session.ts:560`), the internal-inference abort (`harness-runtime.ts`). | All three call the supervisor's `cancel(reason)`. `AcpClient.interrupt` stays the controller's `cancel()` primitive. |
| Pending permissions | `AcpClient.handlePermission` awaits the consumer's handler with no way out (`client.ts:887`). | Belongs in `AcpClient`, because it holds the ACP request: track pending permission requests, answer them `cancelled` on cancel, pass an `AbortSignal` to the handler. Part of the `cancel()` primitive. |
| Killing the process | `AcpTransport.stop` already does SIGTERM, 500 ms, SIGKILL. The ACP SDK rejects every pending request when the stream closes (`ACP connection closed`), so killing ends the in-flight prompt. | `forceStop()` reuses `stop()` on the leaf and marks the controller disconnected. No new kill logic. |
| A dead process | `onCrash` (`client.ts:349`) clears the transport and session id, but `AgentController.current` stays set, so `controller.start()` returns early as if alive (`controller.ts:191`). **A latent bug.** | Fixed in the controller: a dead leaf is dropped. `reconnect(sessionId)` brings a new leaf up through the existing `bringUp(mode, sessionId)`, which already loads. |
| A failed turn | `runPrompt`'s catch (`agent-session.ts` ~3480) already writes the partial reply (status `error` / `failed` through `promptFailed`), closes metering as `error`, emits `turn_failed`, and rejects with `AgentSessionOperationError`. | A stall is thrown into this same path. Nothing parallel. |
| Error records | Written only by `ConversationManager.recordConversationError` (`conversation-manager.ts:906`): transaction, capture level, audit, committed-record bus. `AgentSession` cannot reach it. | Move its body to a shared writer the manager and the owner lifecycle both call. `AgentSession` reports through `ownerLifecycle`, as it does for `promptFailed`. |
| Load or recover | `ConversationManager.open` (~440–545): load, classify the failure, fall back to a checkpoint, `buildRecoverySeed`, a **new** `AgentConversation` started with `this.start`, `seedRecoveryContext`, `persistProviderSession`. | Reconnect cannot replace the object the consumer holds. Load in place goes through the controller (above). Checkpoint recovery in place: extract the open() recovery block into one manager method that seeds a given live conversation, used by both open() and reconnect. **The biggest refactor; its own phase.** |
| Delivery and pending messages | `SteeringController`: the boundary, `endedBy`, `via`, `followedBy`, `withdraw`, message events. | The stall boundary and the hold are added there. It already owns the pending list and its events. |
| Internal inference retry | `coordination/manager.ts`: attempts, backoff, `recordFailure` with `failureDetails`. | Unchanged. A stall is one more failure that flows through it. |
| State and events | `emitStateIfChanged`, `AgentSessionState`, the `AgentSessionEvent` union, the committed-record bus. | New fields and event kinds only. |
| Timers | No clock abstraction in `src/`. `setTimeout` is used directly (internal-inference backoff, transport stop). | A small injectable `Timers` in `operations/`, so tests run in milliseconds. |
| Process exit during a request | `AcpTransport.raceExit` exists and is used for `initialize`. | Control-request deadlines sit next to it in `AcpClient`: one helper wrapping the transport calls. |

## 2. Findings that change the spec

1. **Partial reply status.** The failure path already stores it as `error` / `failed`. Reuse that instead of a new
   `incomplete` status; the error record carries the phase.
2. **Checkpoint recovery on reconnect is only for Agent-owned conversations.** There are three persistence paths:
   - Agent-owned (`ownerLifecycle`, `ConversationManager`);
   - SessionManager (`v2Transcript`);
   - catalog or no persistence.

   Only the first has checkpoints. On the others, reconnect means load; if the load fails, the operation fails and the
   next one tries again.
3. **The SessionManager path has its own manual recovery.** When the library itself died mid-turn, the transcript
   reducer reopens the conversation as `uncertain` (`persistence/reducer.ts:465`), and prompts are blocked
   (`recovery_required`) until `resolveRecovery()`. That is about our process dying, not the harness. Out of scope for
   this step; noted as a later candidate under the same "never stuck" rule.
4. **The crash bug** (row "A dead process"). Fixed as part of phase 4, with a test that fails today.

## 3. Where the new code goes

```
src/operations/
  contracts.ts        stages, OperationActivity, CancelReason, StaleLimits, OperationLifecycleConfig
  errors.ts           OperationStalledError, ProviderRequestTimeoutError, ForcedStopError
  timers.ts           Timers interface + the real one
  activity-tracker.ts pure: tools in flight, permission pending, lastOutputAt, stage
  stale-policy.ts     pure: tracker state + limits + now → next deadline, or stale with its phase
  supervisor.ts       OperationSupervisor: one provider request, its timers and its cancel escalation
  index.ts
```

- **Pure where possible.** The tracker and the policy have no I/O and no timers, so most behaviour is unit-tested
  without a harness. Same discipline as `activity.ts`.
- **The supervisor depends on a narrow interface,** not on `AgentController` or `AgentSession`:

  ```ts
  interface SupervisedProvider {
    prompt(): Promise<PromptResult>;          // the request, already bound
    subscribeOutput(listener): () => void;    // the controller's new subscription
    cancel(): void;                           // session/cancel + pending permissions
    forceStop(): Promise<void>;
  }
  ```

  That is the first slice of the provider-session interface from the model-call note, and the reason the internal
  inference runtime can use it without an `AgentSession`.
- **The supervisor reports through callbacks** (stage changed, stale, cancel forced). The owner turns them into state,
  events and records. It never writes records or emits events itself.

Changes outside `operations/`:

| File | Change |
|---|---|
| `client.ts` | Output subscription source; pending-permission tracking with abort on cancel; the control-request deadline helper. |
| `controller.ts` | `subscribeOutput`, `cancel()` (today's `interrupt`), `forceStop()`, `reconnect()`, dead-leaf detection. |
| `types.ts` | The permission handler gets an optional `signal`. |
| `steering/controller.ts` | Reads the shared tracker instead of its own map; stall boundary; hold and release; `via: "stall"`. |
| `steering/contracts.ts` | `PromptEndedBy` and `MessageDeliveryVia` values, `message_held` / `message_released`. |
| `agent-session.ts` | Wiring only: one private `supervisedPrompt()` used by `runPrompt` and `meteredInternalPrompt`; `ensureProvider()` at the start of each queue item that needs the provider; state fields. Target: small net growth. |
| `agent/conversation-manager.ts` | The error-record writer and the checkpoint recovery block extracted for reuse. |
| `agent/persisted-lifecycle.ts`, `agent-conversation-owner.ts` | Owner hooks: `operationFailed` (writes the error record), `recoverInPlace`. |
| `internal-inference/runtime/harness-runtime.ts` | The prompt goes through a supervisor. |
| `agent/config.ts`, `adapters.ts` | `OperationLifecycleConfig` on the Agent; `cancelGraceMs` on the adapter. |
| `persistence/error-records.ts` | Codes `stalled`, `provider_request_timeout`. |

## 4. Phases

Each phase: tests, a log entry in `10-4-LOG-adopt-provider-session.md`, a commit with explicit paths. Phase 0 changes no
behaviour, so the full suite has to pass unchanged after it.

0. **Preparatory extractions, no behaviour change:**
   - the shared error-record writer;
   - the tool tracker, with steering switched to it;
   - the controller's `subscribeOutput`;
   - `Timers`.
1. **Supervisor, visibility, bounded cancel.**
   - The supervisor around `runPrompt` and `meteredInternalPrompt`; stage and `OperationActivity` on the snapshot;
     `operation_stage_changed`.
   - `cancel()` with pending permissions answered; re-send at half grace; `forceStop()` at the grace.
   - A forced steer or interrupt converted into the normal cancelled result.

   Fixtures: ignores cancel; permission pending during cancel.
2. **Stale detection.** The policy, the limits config, `OperationStalledError` thrown into the existing failure path,
   the error record through the owner hook.

   Fixtures: silent after the prompt; partial text then silence; long tool; pending permission.
3. **Internal inference and recap.** The harness runtime through the supervisor; the recap's stall handled as a recap
   failure. Small, because both failure paths exist.
4. **Reconnect.**
   - Dead-leaf fix and `reconnect()` in the controller; `ensureProvider()` in `AgentSession`; the connection state on
     the snapshot; `provider_reconnected`.
   - Load in place first, then the extracted checkpoint recovery for Agent-owned conversations.

   Starts by reading the open/continuation path end to end. If it does not fit, stop and report before changing it.
5. **Steers after a stall, and the hold.** Steering only.
6. **Control request deadlines.** `AcpClient` only.
7. **Measurements and defaults** (tokens; approved), then release notes.

## 5. Risks

- **Phase 4.** Reconnect touches the continuation and ownership path, which is the least uniform part of the codebase
  (three persistence paths). It comes late so that phases 1–3 deliver on their own.
- **Steering moving to the shared tracker** (phase 0) can shift boundary timing subtly. The steering tests must pass
  unchanged, and that is the check.
- **Output from `AcpClient` for every update** must stay cheap: the supervisor only stores timestamps and counters,
  never content.
