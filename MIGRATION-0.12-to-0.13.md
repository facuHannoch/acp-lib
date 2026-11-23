# Migrating from 0.12.1 to 0.13

For consumers of the published `@qlairoslabs/acp-client` 0.12.1, including
`~agents` (`libs/agents/agents-core`). See the [consumer guide](CONSUMER_GUIDE.md)
for complete examples.

**Status.** These changes are on `alpha` as of `510e2a7`. The package version has
not been bumped and 0.13 is not published. For a local trial, point a disposable
consumer checkout at a local archive of the target code and use a copy of the
database. For example, use a `file:/absolute/path/to/acp-client-archive`
dependency in the trial checkout or replace its local package link. Make the
archive's dependencies available before starting the consumer.

## Before you upgrade

- **Back up the SQLite Agent databases before opening them with the new code.**
  A 0.12.1 schema-16 database opens at schema 21. The migration is one way.
  Older code refuses a migrated database. To roll back, restore the old database
  backup with the matching library version.
- The upgrade adds the schema-17 durable channel intents and nullable
  `controller_kind`, schema-18 worker assignment and delivery storage, schema-19
  worker records, schema-20 assignment and delivery columns, and schema-21
  native metering proof on the operation index. The upgrade also adds the worker
  `role` to conversation rows where it is absent.
- Separate persisted native harness data from the Agent database. If using
  native conversations, retain the harness home across restarts.

## Breaking changes checklist

| What changed | What to do |
| --- | --- |
| `defaultPermission` was removed. | Replace `"approve"` with `permissions: { default: "allow" }` and `"cancel"` with `permissions: { default: "ask" }`. Omitting the setting means ask. |
| Permission defaults and rules can settle requests before the prompt handler. | Install a handler or declare a consumer for asks. Update ACP refusal handling for `reject_once` where offered and cancellation otherwise. |
| `AgentController` and `AgentControllerStartEvent` have new names. | Use `HarnessController` and `ControllerStartEvent`. The deprecated aliases still work. |
| `conversation.connection` is a `ConversationController`. | Use the shared interface where possible and use `conversation.harnessConnection()` for ACP-specific members. Handle its null return. |
| Launcher kind includes `"native-harness"`. | Handle the new kind in custom launcher unions and switches. Route it explicitly or reject it if unsupported. |
| Persistence resolvers can see the optional worker role. | Accept the current `ConversationPersistenceContext` shape and use one resolved package instance for branded IDs. |
| Native channel and worker handling can use new persistence repositories. | Keep unused repositories optional. Advertise capabilities only when the corresponding repository is present. |
| Native stop, close, suspension and resume have new behavior. | Await native channel operations, read typed error codes, and handle `NativeInputStoppedError` for submitted, untaken prompts on shutdown. |
| ACP startup can be deferred or cancelled. | Handle `"deferred"` in reopen status switches and distinguish `ConnectionCancelledError` from an ordinary connection failure. |
| Conversation and Agent event unions have new variants. | Update exhaustive switches for permission and receipt events and inspect the worker subscription API. |
| Native turns now produce metering evidence. | Read `nativeUsage` and partial coverage fields. Treat missing usage and pricing as unknown. |

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
`capabilities.workerDelivery`. Native operation can fall back to host channel
records if there is no durable channel repository. Orchestration requires
both worker repositories and message content capture. Where channels are
durable, reading the channel portion of `host.records` throws. Use
`await host.pendingChannelChanges()`. Submission records still belong to the
configured host records.

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
work. See the [orchestrator guide](CONSUMER_GUIDE.md#orchestrator-and-worker-delivery).

## agents-core specifically

A scratch type-check compared the current agents-core checkout against its
installed 0.12.1 and the `510e2a7` archive. The baseline already has type
errors. The archive adds 13 diagnostics across the following four groups.

| Location under `src/` | Exact edit |
| --- | --- |
| `agent/chat/session.ts` | Keep the app's `default_permission` and CLI option names. Change `libraryPermission` to return `PermissionSettings`, returning `{ default: policy === "approve" ? "allow" : "ask" }`. Set `permissions: libraryPermission(defaultPermission ?? agentCfg.default_permission)` on the session config. Pass `permissions: config.permissions` to both `loadAgentSession` and `createAgentSession`. |
| `agent/chat/sqlite-session.ts` | In `conversationDefaults` set `permissions: { default: (canonical ? canonical.input.permission.policy : opts.defaultPermission ?? agentCfg!.default_permission) === "approve" ? "allow" : "ask" }`. Update the comment in `hub/index.ts` about the prompt handler. It runs for ask only, and an unattended ask fails closed. |
| `__tests__/integration/docker-image-candidate-acp.test.ts`, `__tests__/integration/opencode-model-catalog.test.ts`, `gateway/docker-delivery.test.ts` | Replace the library-level `defaultPermission: "cancel"` with `permissions: { default: "ask" }`. |
| `agent/chat/launcher.ts` | For the current ACP-only launcher add `if (kind === "native-harness") throw new Error("Native harness launch is unsupported by this runtime");` before passing `kind` to `prepareProcessLaunch`. To enable native launches later, extend `RuntimeProcessKind` and its runtime handlers to route the new kind explicitly. |
| `hub/index.ts` | Keep the degraded PTY special case. Replace `session.connection.currentClient.isConnected` with `session.harnessConnection()?.currentClient.isConnected ?? false` inside the existing try/catch. Update session test doubles used by that branch to supply `harnessConnection()` with the expected client state. |
| `configuration/recording/acp-contract.test.ts` | Remove the public-package import of `ConversationPersistenceContext` from this fixture. Type `context` as `Parameters<ConversationSettingsResolver["settingsFor"]>[0]` using the fixture's existing resolver import. The error in the linked archive is a split branded type identity from mixing relative package internals with a public package type. The resolver contract test can stay on its test-only internal import path. |

If an app-level `cancel` policy must refuse even when an app handler is
accidentally attached, use `default: "deny"` for that explicit app policy and
reserve `default: "ask"` for the app's approval workflow. That is an app policy
choice separate from the library's 0.12.1 mapping above.
