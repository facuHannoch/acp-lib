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
- Test-only: the A1 characterization snapshots are unchanged except `cause`, plus a reviewed ordering exception for the
  two non-contractual orders (metering vs presentation events / the last in-progress assistant snapshot).
