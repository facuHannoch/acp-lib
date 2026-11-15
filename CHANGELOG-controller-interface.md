# Controller interface

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

- **`cause` on `turn_started`:** `{ kind: "messages", messageIds }` (the messages the turn carries; a combined steer run
  lists each original message) or `{ kind: "items", items }` (a turn nobody prompted). Record and presentation ids are
  unchanged: a run's turn id is its first message's id.
- **`harnessConnection()`** on `AgentSession` / `AgentConversation`: the live controller as a `HarnessController`, or
  `null` for a backend that isn't an external harness.
- **`conversationCapabilities`** on `HarnessController` and `AgentSession`: what the backend offers in neutral terms
  (`nativeSteering`, `backend: BackendCapabilities | null`; `backend` is `null` before the agent's `initialize` and in
  PTY mode). Safe to read before connecting.
- **New types and exports:** `ConversationController`, `TurnRun`, `TurnContent`, `PreparedTurn`, `TurnStarted`,
  `TurnTook`, `TurnEvent`, `TurnCause`, `StartResult`, `UsageListener`, `ConversationCapabilities`,
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

## Backend-scheduled controllers (for a later native backend; no ACP path reaches this)

- A reported `turn_started` with `sentBySession: false` joins the conversation's operation queue and runs in order
  (no user record, no ACP input; supervised and metered like any turn).
- `turn_took` extends a turn's cause; a message the session sent settles with the turn that takes it. A controller with
  `nativeSteering` receives each message separately (never combined, no cancel-to-steer), the queue operation ends when
  `send` resolves, and a `steer` message sent while a backend turn runs is handed over at once.
- A prepared turn that isn't `live` (replaying output the backend already produced) isn't stalled while it replays; the
  supervisor re-reads `live` each stall interval, so a turn that becomes live and goes silent is stalled (no later than its
  limit after the change; the interface has no change notification, see `errors/11-15-spec-live-transition-no-notification.md`).
- **Open, for the spec owner:** a prepared turn's `live` has no change notification (interval-granularity check for now); the interface has no message payload yet, so a backend-scheduled controller cannot read
  what the user wrote; an accepted message the backend never takes waits until stop; a mixed-kind `turn_took` cause keeps
  the first kind. See `errors/11-15-spec-*.md`.

## Behaviour notes (unchanged for ACP unless stated)

- `AgentSession.listSessions()` before the agent connects still throws `NotConnectedError`.
- A controller without `reconnect` (none today) is handled as a provider that lost the session: the conversation's
  continuation rule decides (`ProviderSessionReloadUnsupportedError`, an `UnsupportedError`).
- Test-only: the A1 characterization snapshots are unchanged except `cause`, plus a reviewed ordering exception for the
  two non-contractual orders (metering vs presentation events / the last in-progress assistant snapshot).
