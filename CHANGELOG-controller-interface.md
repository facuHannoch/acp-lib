# Controller interface

## ACP startup

- An explicit stop or superseding ACP connection attempt rejects with `ConnectionCancelledError`
  and code `connection_cancelled`. Direct session factories accept a startup `signal`.
- Superseding a fresh-session start on an existing ACP connection intentionally closes that
  connection before starting its replacement. The cancelled session creation cannot finish on
  the old connection.
- Agent-owned normal ACP conversations default to `providerStart: "on_open"`. Set
  `conversationDefaults.providerStart` or override it with `runtime.providerStart: "on_first_use"`
  on creation or reopen to connect on the first provider-bound operation. Before first use,
  provider settings and commands are empty and ACP-only capabilities are unavailable.
- A failed session creation on deferred first use closes that connection and reports the
  provider error. Use eager startup when the connection must remain available for authentication.
- `OpenOwnedAgentConversationResult.providerSession` includes `"deferred"` for an open that has
  yet to connect. Consumers with exhaustive switches over this field can handle the new status.
  The startup policy is runtime configuration and can be selected anew on each reopen.
  First-use recovery is visible through recovery progress, the `provider_reconnected` event and
  persisted recovery records after the deferred open has returned.

## Worker observation

- `AgentEvent` includes worker lifecycle facts. Subscribe with `agent.events.subscribeWorkers` for
  worker events. Existing committed-record subscriptions retain their record payloads.

## Worker shutdown

- `agent.workers.delete(handle)` returns a `DeleteConversationResult` with the provider cleanup outcome.
- `orchestrator.workers.idleStopMs` defaults to ten minutes and accepts `false` to keep idle
  providers connected. An idle stop emits `worker_stopped` with reason `idle`; the next send reloads the worker.

## ACP worker results

- Worker assignments reserve their dispatch identity before the provider runs. ACP destinations receive
  the saved worker reply or failure in an out-of-band message with a stable delivery ID and worker
  metadata. The next prompt carries the message to the destination's provider.
- `agent.workers.check` and `list` include the latest staged outcome, including when its destination
  was deleted. A steer refused after enqueue emits `worker_failed` with reason `refused`, its cause and
  the conversation that sent the steer.
- A start refused before provider dispatch also notifies its sender. When a refusal is the latest
  outcome, `check` and `list` include the last successful result as `latestResult` if one exists.
- Native destinations receive durable worker notices through the harness. Opening the harness
  retries eligible notices and recovers prior assignments by ID without redispatching work.
- Worker `check` and `list` report `deliveryState` for the latest staged assignment. Consumers
  can call `agent.workers.retryDelivery(handle)` to retry the worker's newest policy-blocked notice
  explicitly. It rejects when the worker has no policy-blocked delivery.

## Worker permission forwarding

- A forwarded `permission_requested` event carries a `source` with the worker handle and conversation ID.
  `turnId` is optional only on a request with a worker source. Ordinary requests require it. The public `WorkerPermissionSource` type describes the source, and the giving
  conversation answers through its existing `answerPermission` method.
- Forwarded asks shown to a non-owner hide `allow_always` and reject it as an answer.
- Consumer-opened workers use `orchestrator.defaults.workerPermissions`. An unattended ask is refused.

## Conversation permission events

- ACP and native conversations emit `permission_requested` for a request and exactly one
  `permission_resolved` with its outcome and source. Sources are `handler`, `consumer`, `default`,
  `timeout`, and `turn_ended`. The last means the turn's lifecycle closed the request, including
  force stop or conversation stop. `permission_resolved` is delivered in a microtask after the
  request closes, so all request listeners see the request first. Native host responder decisions
  are reported as `handler`.
  Agent-owned permission records keep their existing format.
- Set `answersPermissions: true` on a conversation or in `conversationDefaults` to answer an
  open ask with `await conversation.answerPermission(id, optionId)`. The result contains
  `accepted`. Closed, expired, unknown, handler-owned, and invalid-option answers return false.
  Native answers use the offered `allow_once` or `deny` options.
- `permissionTimeoutMs` defaults to five minutes and applies only to consumer waits. Those requests
  include `expiresAt` as epoch milliseconds. Set a positive integer below 600,000 ms to override it.
  Time starts at ACP client or native host receipt.
  A native request recovered by observation uses the first time that host sees it, and replay
  preserves that timestamp. Expiry refuses the request. The native harness still has its own
  ten-minute timeout. A local detach, force stop, or stop sends a denial for an open
  conversation-owned approval. A host responder retains authority if only its observer detaches.
- Final policy levels resolve immediately. For ask, a prompt handler takes precedence, then a
  declared consumer can answer, and an unattended ask is refused. Prompt handlers retain their
  existing lifetime. The permission rule callback receives the neutral native tool name and the
  original argument string and validates its return level at runtime.

## Breaking permission configuration

- `permissions: { default, rules? }` replaces `defaultPermission`. Migrate `"cancel"` to
  `{ default: "ask" }` and `"approve"` to `{ default: "allow" }`. Omitting the setting defaults to ask.
  Raw clients and direct sessions accept it alongside Agent settings. For Agent conversations, the
  Agent setting is overridden by `conversationDefaults`, then the conversation setting, then its
  `runtime` setting. Each setting replaces the whole previous object, including its rule map.
- `permissionRule(request)` can return a level before rule matching. Among matching rules, the most
  restrictive level wins, so a `command:` allow cannot override a stricter `kind:` rule. Invalid keys and
  levels throw when configuring the client or conversation.
- Allow and deny are final. A prompt handler is called only for ask, so an unmatched request with
  default allow skips the handler. ACP refusal selects `reject_once` when offered, and cancels otherwise.
- Callback requests include `tool` when the producer supplies tool data. Native asks use only
  `permissionRule` and the configured default. In particular, default allow approves native asks.
  The prompt handler answers native ask when present, and native refusal sends harness `deny`.

A refactor with no new behaviour for ACP conversations, in any of the three persistence modes (Agent-owned,
managed, detached). It separates a message going in from a turn running, puts the session on a turn-based
`ConversationController` interface, and makes ACP-only features optional or capability-gated, so a second
backend can be plugged in later. Spec: `.res/somelogs.md/11-11+/library/11-11-SPEC-controller-interface.md`.

## Renames (the old names keep working)

- `AgentController` is now **`HarnessController`**. `AgentController` stays exported, as a deprecated alias (a value
  and a type); both names are the same class.
- `AgentControllerStartEvent` is now **`ControllerStartEvent`**. The old name stays as a deprecated alias.
- `AgentControllerConfig` keeps its name. Error messages keep "AgentController is not started — call start() first".

## Added

- **Durable channel intents:** Agent backends can expose the optional `channels` repository
  (`ChannelPersistence`) and advertise it through `capabilities.channels`. SQLite persists each channel's
  latest intent and version. Native conversation deletion commits the retirement intent with the conversation
  deletion.
- **Native host records:** With a durable channel backend, the channel methods on `host.records` throw.
  Use the async `host.pendingChannelChanges()` to read pending intents. Submission methods continue to
  use the configured host records.
- **Native operator errors:** `HarnessUnavailableError` exposes a readonly `code` of `not_running`,
  `failed`, `stopped`, `open_timeout`, `start_failed`, or `reopen_failed`. The async operator
  `suspendChannel()` and `resumeChannel()` methods reject with `not_running` while offline.
  `resumeChannel()` also rejects with `channel_retired` while a retirement is pending.
- **Stored controller kind:** Agent conversation rows record `controller_kind` as `acp` or `native`. The SQLite
  schema 16 to 17 migration leaves older rows unset. Native deletion uses the stored kind to retire channels,
  including conversations that never completed a prompt. Switches and handoffs across controller kinds reject
  with `UnsupportedError` before transition events or records.
- **`beforeDispatch` prompt option:** session-scheduled turns await this hook after durable prompt preparation
  and before provider dispatch. Each hook receives its own message ID. Combined steer messages run their hooks
  in message order. A rejection fails the whole ACP run, calls `abandonTurn` and emits `turn_failed`. The owned
  failure callback and an error metering record still run for that undispatched operation. Native awaits every
  hook before the first push, so rejection fails the send before the harness creates a turn.
- **Owned turn finalization:** `afterPrompt` receives the turn's `messageIds` with every returned terminal status,
  including cancellation and error. `promptFailed` also receives those IDs for rejected turns. The IDs include native
  inputs folded into a running turn. The operation ID still identifies the turn.
- **`cause` on `turn_started`:** `{ messageIds?, items? }`, at least one present: the messages the turn carries (a
  combined steer run lists each original message) and/or the backend items it took (a turn nobody prompted; a native
  backend often takes a worker reply and a user message into one turn, so a cause can hold both). Record and
  presentation ids are unchanged: a run's turn id is its first message's id.
- **`TurnRun.messages`:** `send` receives the messages themselves (`{ id, text, messageParts?, attachments?,
  participantId?, consumerMetadata? }`, the objects the queue holds, in `messageIds` order; a combined steer run lists each
  original message), so a backend-scheduled controller gets what the user wrote without reaching into the session. ACP
  controllers ignore it: the session builds their content and passes it in `prepareTurn`.
- **`harnessConnection()`** on `AgentSession` / `AgentConversation`: the live controller as a `HarnessController`, or
  `null` for a backend that isn't an external harness.
- **`conversationCapabilities`** on `HarnessController` and `AgentSession`: what the backend offers in neutral terms
  (`nativeSteering`, `backend: BackendCapabilities | null`; `backend` is `null` before the agent's `initialize` and in
  PTY mode). Safe to read before connecting.
- **New types and exports:** `ConversationController`, `TurnRun`, `TurnContent`, `PreparedTurn`, `TurnStarted`,
  `TurnTook`, `TurnEvent`, `TurnCause`, `ItemRef`, `StartResult`, `UsageListener`, `ConversationCapabilities`,
  `BackendCapabilities` and `UnsupportedError` (package entry). The factory `createController` and `fromAcp` are
  internal (`src/conversation-controller`).
- **`UnsupportedError`:** thrown by a controller or session asked for something its backend can't do (an optional member
  it doesn't have). Callers guard first, so it signals a bug.

## Changed

- **`AgentSession.connection`** is now typed `ConversationController` (it was `AgentController`). Code that needs the
  ACP controller uses `harnessConnection()`. The raw ACP `capabilities` on controllers, sessions and conversations keeps
  its shape and throws in the same cases (before the agent connects; in PTY mode).
- **The controller turn path:** `send`, `subscribeTurns`, `prepareTurn`, `prepareInternalPrompt` and `abandonTurn` on
  `HarnessController`. The session runs every turn the same way, from the controller's `turn_started`; completion
  (`turn_completed` / `turn_failed`) stays the session's, after metering, the transcript and `afterPrompt`.
- **Internal readers of ACP capabilities** (media in prompts, session listing) read the neutral `backend` capabilities.

## Backend-scheduled controllers (including the native backend)

- A reported `turn_started` with `sentBySession: false` joins the conversation's operation queue and runs in order
  (no user record, no ACP input; supervised and metered like any turn).
- `turn_took` extends a turn's cause (messages and items both kept); a message the session sent settles with the turn that
  takes it. A controller with `nativeSteering` receives each message separately (never combined, no cancel-to-steer), the
  queue operation ends when `send` resolves, and a `steer` message sent while a backend turn runs is handed over at once.
- **The wait after acceptance** (a message a backend-scheduled controller accepted and no turn has taken) is cancellable:
  `stop` drops it as cancelled, `handle.withdraw()` withdraws it locally (resolves cancelled; the backend is not told), and
  `interrupt({ clearQueue: true })` drops it like a queued message. A later turn that names a withdrawn message still runs;
  the session ignores that message ID for settlement. The wait has no
  time limit: it is the normal case (a message accepted while a long turn runs waits for the next turn). A backend that never
  starts a turn is a backend bug.
- A prepared turn that isn't `live` (replaying output the backend already produced) isn't stalled while it replays; the
  supervisor re-reads `live` each stall interval, so a turn that becomes live and goes silent is stalled no later than its
  limit after the change, and possibly up to one limit earlier. Accepted behaviour (owner, 2026-11-15): stall limits are
  minutes long, so an explicit "now live" signal would add an interface member for no practical gain. It applies only when a
  stall limit is enabled and no permission exemption applies.
- **Cancel grace:** `ConversationController.cancelGraceMs` is `number | undefined`; the supervisor defaults an undefined value
  to 30 s (the code was right; the spec text said `number`).

## Behaviour notes (unchanged for ACP unless stated)

- `AgentSession.listSessions()` before the agent connects still throws `NotConnectedError`.
- A controller without `reconnect`, such as NativeController, is handled as a provider that lost the session: the conversation's
  continuation rule decides (`ProviderSessionReloadUnsupportedError`, an `UnsupportedError`).
- Native prompts with unsupported media parts or attachments reject with `UnsupportedError` before any message in
  the run is submitted. This applies to queued and steered prompts.
- A same-adapter handoff on a native conversation rejects directly with `UnsupportedError` when fresh contexts are
  unsupported, before any handoff events or reset records are created.
- Test-only: the A1 characterization snapshots are unchanged except `cause`, plus a reviewed ordering exception for the
  two non-contractual orders (metering vs presentation events / the last in-progress assistant snapshot).


## Native input withdrawal

- `PromptHandle.withdrawAsync()` and `AgentSession.withdrawAsync(id)` request confirmed
  withdrawal of submitted native input. Synchronous withdrawal is local for native.
  A `taken` result leaves the prompt following its turn. An unresolved reply can reject.
- Native submission recovery suppresses push replay while a withdrawal is pending.
  The built-in file store retains the intent across Agent reopen. Custom host records
  can implement `markWithdrawing` to support withdrawal of submitted input.
- Native `interrupt({ clearQueue: true })` clears local inputs and leaves submitted
  input to the harness. Stop and close reject handles that the session stops observing.
  `TurnEvent` now includes the controller's `input_withdrawn` confirmation.
