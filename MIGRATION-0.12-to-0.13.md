# Migrating from 0.12.1 to 0.13

For consumers of the published `@qlairoslabs/acp-client` 0.12.1, including
`~agents` (`libs/agents/agents-core`). See the [consumer guide](CONSUMER_GUIDE.md)
for complete examples.

**Status.** These changes are on `alpha`. The package version remains 0.12.1
and 0.13 is unpublished. For a local trial, point a disposable
consumer checkout at a local archive of the target code and use a copy of the
database. For example, use a `file:/absolute/path/to/acp-client-archive`
dependency in the trial checkout or replace its local package link. Make the
archive's dependencies available before starting the consumer.

## Before you upgrade

- **Back up the SQLite Agent databases before opening them with the new code.**
  A 0.12.1 schema-16 database opens at schema 22 on the reminders build.
  The migration is one way. Older code refuses a migrated database. To roll back, restore the old database
  backup with the matching library version.
- The upgrade adds the schema-17 durable channel intents and nullable
  `controller_kind`, schema-18 worker assignment and delivery storage, schema-19
  worker records, schema-20 assignment and delivery columns, schema-21
  native metering proof on the operation index, and schema-22 reminder intents,
  cache and wake state. The upgrade also adds the worker
  `role` to conversation rows where it is absent.
- Separate persisted native harness data from the Agent database. If using
  native conversations, retain the harness home across restarts. The harness
  has its own storage version. Its first durable reminder write activates
  format 7, which older harness binaries refuse.

## Breaking changes for 0.12.1 consumers

The package entry at `510e2a7` retained all 828 exports from 0.12.1 and
had 913 exports. At `fb20ed6` it has 915, including the new
`MessageStatus` and `MessageStatusEvent` types. The package exports map and
dependencies are unchanged through `fb20ed6`. With one-off reminders, the package
entry has 924 exports, including nine new reminder names.
`AgentController` remains a deprecated value and type alias of
`HarnessController`.

| What changed | What to do |
| --- | --- |
| `defaultPermission` was removed. | Replace `"approve"` with `permissions: { default: "allow" }` and `"cancel"` with `permissions: { default: "ask" }`. Omitting the setting means ask. |
| Permission defaults and rules can settle requests before the prompt handler. | Install a handler or declare a consumer for asks. Update ACP refusal handling for `reject_once` where offered and cancellation otherwise. |
| `AgentController` and `AgentControllerStartEvent` have new names. | Use `HarnessController` and `ControllerStartEvent`. The deprecated aliases still work. |
| `conversation.connection` is a `ConversationController`. | Use the shared interface where possible and use `conversation.harnessConnection()` for ACP-specific members. Handle its null return. |
| Launcher kind includes `"native-harness"`. | Handle the new kind in custom launcher unions and switches. Route it explicitly or reject it if unsupported. |
| Custom persistence backends must supply `capabilities.channels: boolean`. | Use `channels: false` without a durable channel repository. The repository itself is optional. |
| Adapter registration now accepts `AgentAdapter` (`Adapter \| NativeAdapter`). | Narrow `AgentAdapterRegistration.adapter`, entries in `AgentConfig.adapters`, and arguments to `AgentAdapterRegistry.register` before reading ACP fields such as `command`. `list()` still returns entries with an `Adapter`. |
| `PromptHandle` gains required `withdrawAsync(): Promise<boolean>` and `readonly status: MessageStatus`. | Add both members to test doubles and other implementations of `PromptHandle`. |
| ACP startup can be deferred or cancelled. | Handle `"deferred"` in reopen status switches and distinguish `ConnectionCancelledError` from an ordinary connection failure. |
| `AgentConversationEvent` and `AgentSessionEvent` add permission events and `items_receipt`. `turn_started` now requires `cause`. | Update exhaustive switches and mocks that construct a turn-start event. |
| `AgentSessionEvent` and `AgentConversationEvent` gain `message_status`; `ActivityEvent` gains `provider_notice`. | Update exhaustive event and activity switches. |
| The reminders build adds local and wire reminder events to `AgentSessionEvent` and `AgentConversationEvent`. | Extend exhaustive switches even if reminders are disabled in your application. |
| `AgentEvent` includes `WorkerEvent`. `AgentEventBus` gains required `subscribeWorkers`. | Update exhaustive switches and bus doubles. `AgentEventNotification` still defaults to committed-record notifications, so ordinary `subscribe` listeners retain their type. |
| `MeteringProvenance.source` gains `"native_ledger"`. | Extend exhaustive provenance switches, even if the application currently uses ACP only. |

## New behavior when you enable native conversations or orchestration

| What changed | What to do |
| --- | --- |
| Native channels and workers can use new persistence repositories. | Enable each capability only with its repository. Configure both worker repositories and message content capture for orchestration. |
| Persistence resolvers can see the optional worker role. | Use `ConversationPersistenceContext.role` to set worker-specific retention if needed. |
| Native stop, close, suspension and resume have backend-specific behavior. | Await channel operations, read typed error codes, and handle `NativeInputStoppedError` for submitted, untaken prompts on shutdown. |
| Native turns produce metering evidence. | Read `nativeUsage` and partial coverage fields. Treat missing usage and pricing as unknown. |
| Worker results have durable assignment and delivery state. | Read outcomes through the worker API and retry blocked native notices explicitly. |

## Message status and provider notices

Read `handle.status` for the latest state of an individual prompt and handle
`message_status { id, status, turnId? }` for live updates. `turnId` is optional.
Status is live only and history reads after a restart do not restore it.
Native conversations use harness milestones. ACP approximates delivery at
dispatch and marks a message seen at the first provider output. Use the
prompt result to determine how its turn ended. Existing message events still
work. See [Message status](CONSUMER_GUIDE.md#message-status).

If you render activities, handle `provider_notice` for provider retries,
warnings and reported failures. ACP clients now advertise version 1 of the
JetBrains AIR `sessionFailure` extension in `clientCapabilities._meta`.
Agents may send AIR notices in response to this advertisement. acp-client
also recognizes the Codex ACP fallback shape. Raw activity callbacks can
read optional `meta` on `session_info` and `usage` for unmodeled update
metadata. Narrow the value before reading adapter-specific fields. See
[Provider notices](CONSUMER_GUIDE.md#provider-notices-retries-warnings-and-failures).

## Native reminders

Use `conversation.reminders` on Agent-owned native conversations and page
all reminder views through `agent.reminders.list({ after, limit })`.
Check `conversationCapabilities.reminders`. Native support is provisional
until negotiation. A compatible harness advertises `capabilities.reminders`
and `reminderLimits`. ACP has no reminder support. For repeating schedules,
check `conversationCapabilities.routines` after executable open. A
0032-compatible harness must advertise both routine and unattended guard
support. Set `harness.config.limits.unattendedTurns` when enabling the guard.
The harness persists that limit and refuses later attempts to change it.

Custom backends can optionally expose a `reminders` repository and the
`capabilities.reminders` flag. SQLite supplies the repository. Without
durable storage, stopped mutations that need to write reject with `reminders_unavailable`
as the `ReminderError.code`. SQLite journals
offline changes for the next executable open. The library keeps SQLite schema
22 and accepts existing one-off journal rows. Routine and retry metadata fit
in the existing JSON values. A 0032 harness binds its unattended-turn guard
using its own session format 8. Reads while stopped show
last-confirmed cached rows and local intents. A refused intent stays visible
as blocked. Use `discardBlocked` to remove it locally and create a new ID
when correcting a blocked create. The harness remains authoritative.

The local `reminder_intent_recorded`, `reminder_intent_confirmed`,
`reminder_intent_blocked` and `reminder_intent_discarded` events track
writes. The harness separately reports `reminder_changed`, `reminder_fired`,
`reminder_cancelled` and `reminder_expired`. A fired event means a notice
was queued. Routine consumers can also receive `routine_disposition` and
`routine_migration_blocked`. Extend exhaustive event switches and handle
routine rows, which can be active after a fire and may carry remaining count,
timezone data and migration status. Historical events are not replayed.
See [Reminder routines](CONSUMER_GUIDE.md#reminder-routines).

Only the file-backed SQLite owner schedules a cold wake, while the Agent
is running. Explicit harness stop retains the wake. Closing the Agent
clears the timer and the next Agent open rearms from storage. Idle stop
is opt-in through `harness.idleStopMs`. See the
[one-off reminders guide](CONSUMER_GUIDE.md#one-off-reminders-experimental)
for scheduling, expiry, cache freshness, tools, wake limitations and
configuration.

## Permissions

The replacement applies to raw ACP clients, direct and managed sessions, Agent
configuration, conversation defaults and conversation runtime settings. For an
Agent-owned conversation, each more specific `permissions` object replaces the
whole inherited object, including its rules. The order is Agent,
`conversationDefaults`, conversation settings, then `runtime`.

`permissionRule(request)` can override the decision before ACP rule matching.
Rules use `kind:` and exact `command:` keys. The stricter match wins. Native asks
use the callback and default, while the harness itself grants or denies tools
by name. Allow and deny are final. In particular, default allow can skip a
prompt handler that previously ran. An ask with no handler and no eligible
consumer is refused. Use `answersPermissions`, `permissionTimeoutMs` and
`answerPermission` to implement a conversation approval UI. See
[permission configuration and events](CONSUMER_GUIDE.md#permissions-and-approval-ui).

## Controllers, launchers and persistence

Use `conversationCapabilities` for backend-neutral capability checks.
For raw ACP access, narrow with `harnessConnection()`. Raw ACP capabilities
still require a connected ACP harness. `AgentControllerConfig` keeps its name.
The package exports `ConversationController`, `TurnRun`, `TurnContent`,
`PreparedTurn`, `TurnStarted`, `TurnTook`, `TurnEvent`, `TurnCause`, `ItemRef`,
`StartResult`, `UsageListener`, `ConversationCapabilities`, `BackendCapabilities`,
`UnsupportedError`, `ItemsReceipt`, `NativeInputStoppedError` and
`ConnectionCancelledError`. Permission, orchestrator and worker types include
`PermissionSettings`, `PermissionLevel`, `WorkerPermissionSource`,
`OrchestratorConfig`, `WorkerConsumerApi` and `WorkerEvent`.
For the full list and behavioral details, see the
[controller changelog](CHANGELOG-controller-interface.md).

An `AcpLauncher.prepare()` implementation now receives `"acp"`, `"pty"`, or
`"native-harness"`. The latter launches the configured native host command.
A persistence resolver gets the conversation ID, participants, optional title
and metadata, `adopted` and optional `role: "worker"`. Existing resolvers can
ignore role if they do not distinguish worker retention. Owned turn finalization
also receives `messageIds` on successful, cancelled and failed operations.

For a custom Agent persistence backend, the optional repositories are
`channels`, `workers` and `workerDelivery`, with matching
`capabilities.channels`, `capabilities.workers` and
`capabilities.workerDelivery`. The only newly required member of an existing
persistence backend or configuration interface is
`PersistenceCapabilities.channels: boolean`. Use `false` without a channel
repository. `capabilities.workers` and `capabilities.workerDelivery` are optional
booleans. Native operation can fall back to host channel
records if there is no durable channel repository. Orchestration requires
both worker repositories and message content capture. Where channels are
durable, reading the channel portion of `host.records` throws. Use
`await host.pendingChannelChanges()`. Submission records still belong to the
configured host records.

Structural test doubles of the concrete classes can also need new members.
`Agent` now exposes `nativeHarness` (null when no native harness is configured).
`AgentAdapterRegistry` adds `native(id)`.
`SqliteAgentPersistence` exposes required `channels` and `workers` repositories.
`HarnessController` and its deprecated alias gain `conversationCapabilities`,
`send`, `subscribeTurns`, `prepareTurn`, `prepareInternalPrompt` and
`abandonTurn`. `AgentConversation` and its `AgentSession` alias gain
`conversationCapabilities`, `harnessConnection`, `answerPermission`,
`withdrawAsync` and `attachObservation`.

## Startup and native shutdown

Agent-owned ACP defaults to `providerStart: "on_open"`. Set
`conversationDefaults.providerStart` or the conversation's
`runtime.providerStart` to `"on_first_use"` for lazy startup. A deferred reopen
can report `providerSession: "deferred"`. Direct factories accept a startup
signal. An explicitly stopped or superseded connection rejects with
`ConnectionCancelledError` and code `connection_cancelled`.

`await host.suspendChannel(id)` and `await host.resumeChannel(id)` can reject.
`HarnessUnavailableError.code` distinguishes `not_running`, `failed`,
`stopped`, `open_timeout`, `start_failed` and `reopen_failed`. Resume can
also reject with `channel_retired` while retirement is pending.

Local withdrawal is synchronous. Use `withdrawAsync` for a submitted native
input. During stop and close, the library gives submitted unclaimed inputs a
bounded withdrawal attempt before interrupting. Submitted inputs never taken
by a turn reject with `NativeInputStoppedError`. A taken prompt resolves as
cancelled and includes any completed reply text and its metering record.
Stopping before the first message completes returns empty text. The Agent
attempts to recover committed replies for persistence.

## Native metering and delivery

Native metering uses the harness call ledger with `best_effort` by default.
It retains per-attempt evidence, uncertainty and partial coverage. Native
metering ignores consumer pricing policies and inference sources. Known
usage of earlier turns can be recorded separately in `unallocatedUsage`.
The current native wire cannot satisfy `billing_required`. See
[Native turn metering](CONSUMER_GUIDE.md#native-turn-metering) and the
[metering changelog](CHANGELOG-metering.md).

Worker delivery stores the assignment identity and its outcome. An ACP
destination receives an out-of-band message. A native destination receives a
durable notice. Eligible notices can be retried without redispatching worker
work. See the [orchestrator guide](CONSUMER_GUIDE.md#orchestrator-and-worker-delivery-experimental).

## Other native harness changes

The standalone native harness managed session config can opt into `timelineTools: true` to make
`search_timeline` and `read_message` available under tool policy. Search can
span channels in the same session. Model-call pagination now uses bounded
page reads without loading full session history. The standalone development
CLI also has new controls for instructions and debug tools. See the
[native harness guide](src/native-harness/README.md).

## agents-core specifically

A scratch type-check compared the current agents-core checkout against its
installed 0.12.1 and the `510e2a7` archive. The baseline already has type
errors. The archive adds 13 diagnostics across the following four groups.

| Location under `src/` | Exact edit |
| --- | --- |
| `agent/chat/session.ts` | Keep the app's `default_permission` and CLI option names. Import `PermissionSettings` from the package and make it the return type of `libraryPermission`, returning `{ default: policy === "approve" ? "allow" : "ask" }`. Set `permissions: libraryPermission(defaultPermission ?? agentCfg.default_permission)` on the session config. Pass `permissions: config.permissions` to both `loadAgentSession` and `createAgentSession`. |
| `agent/chat/sqlite-session.ts` | In `conversationDefaults` set `permissions: { default: (canonical ? canonical.input.permission.policy : opts.defaultPermission ?? agentCfg!.default_permission) === "approve" ? "allow" : "ask" }`. Update the comment in `hub/index.ts` about the prompt handler. It runs for ask only, and an unattended ask fails closed. |
| `__tests__/integration/docker-image-candidate-acp.test.ts`, `__tests__/integration/opencode-model-catalog.test.ts`, `gateway/docker-delivery.test.ts` | Replace the library-level `defaultPermission: "cancel"` with `permissions: { default: "ask" }`. |
| `agent/chat/launcher.ts` | For the current ACP-only launcher add `if (kind === "native-harness") throw new Error("Native harness launch is unsupported by this runtime");` before passing `kind` to `prepareProcessLaunch`. To enable native launches later, extend `RuntimeProcessKind` and its runtime handlers to route the new kind explicitly. |
| `hub/index.ts` | Keep the degraded PTY special case. Replace `session.connection.currentClient.isConnected` with `session.harnessConnection()?.currentClient.isConnected ?? false` inside the existing try/catch. Update session test doubles used by that branch to supply `harnessConnection()` with the expected client state. |
| `configuration/recording/acp-contract.test.ts` | Remove the public-package import of `ConversationPersistenceContext` from this fixture. Type `context` as `Parameters<ConversationSettingsResolver["settingsFor"]>[0]` using the fixture's existing resolver import. The error in the linked archive is a split branded type identity from mixing relative package internals with a public package type. The resolver contract test can stay on its test-only internal import path. |

Update the loose session doubles as well. Add
`harnessConnection() { return this.connection; },` next to the existing
`connection` property in these files under `src/`:

- `__tests__/integration/steer-delivery.test.ts:35`
- `__tests__/integration/user-chat-acceptance.test.ts:36`
- `__tests__/kit/harness.ts:17`
- `__tests__/unit/hub.test.ts:752`. Keep the connection mutations on lines
  624 and 660. The method must return the same mutable object.

The type-check alone cannot detect these doubles. The two integration files
pass all 9 and 11 tests respectively with the method in place. The unit
`hub.test.ts` could not be run in the scratch layout because of a macro
import.

If an app-level `cancel` policy must refuse even when an app handler is
accidentally attached, use `default: "deny"` for that explicit app policy and
reserve `default: "ask"` for the app's approval workflow. That is an app policy
choice separate from the library's 0.12.1 mapping above.
