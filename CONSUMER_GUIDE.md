# Consumer guide

This guide is for applications embedding `@qlairoslabs/acp-client`, especially
orchestrators that own several logical agent sessions. The library owns ACP communication,
one live session's operation queue, metering, and optional persistence. The consumer owns
its collection of live objects, adapter resolution, user interface, and application policy.

The package requires Bun 1.3.5 or newer.

## Mental model

There are three different operation layers:

| Layer | Main API | Examples |
|---|---|---|
| Logical-session management | `SessionManager` | Create, list, load, restore, reconfigure, and delete logical sessions |
| One stable logical session | `AgentSession` | Prompt, interrupt, handoff, observe state, change configuration, and bridge |
| Active harness thread | ACP and `internalSessionCommands` | Harness-specific commands such as `/usage` and `/model` |

An `agentSessionId` is the stable identity exposed to the consumer. An
`internalSessionId` identifies the current provider or harness thread. Handoff and other
thread replacements may change the latter without changing the former.

```text
consumer
  └── SessionManager
        └── AgentSession agent-7           stable logical identity
              └── internal thread abc      replaceable harness identity
```

`SessionManager` persists and discovers logical sessions. It does not retain live
`AgentSession` objects. An orchestrator normally keeps those separately:

```ts
const liveSessions = new Map<string, AgentSession>();
```

## Install and import

```bash
bun add @qlairoslabs/acp-client
```

```ts
import {
  ADAPTERS,
  AgentSession,
  AuditLogReader,
  SessionManager,
  TranscriptReader,
  formatResponseMessages,
  type Adapter,
  type AgentSessionOpenStage,
  type AgentSessionNotification,
  type PromptHandlers,
} from "@qlairoslabs/acp-client";
```

Interactive helpers are a separate entry point:

```ts
import {
  createAgentSessionCommands,
  dispatchReplInput,
  getAgentSessionCommands,
  parseReplInput,
  runAgentSessionRepl,
} from "@qlairoslabs/acp-client/repl";
```

## Resolve adapters in the consumer

An adapter only tells the library how to launch a harness. Capabilities, authentication,
configuration, and harness commands are discovered after ACP initialization.

```ts
const adapters: Record<string, Adapter> = {
  opencode: ADAPTERS.opencode,
  codex: ADAPTERS.codex,
  claude: ADAPTERS.claude,
  pi: ADAPTERS.pi,
  internal: {
    command: ["internal-agent", "--acp"],
    ptyCommand: ["internal-agent"],
    displayName: "Internal agent",
  },
};

function resolveAdapter(adapterId: string): Adapter {
  const adapter = adapters[adapterId];
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
  return adapter;
}
```

The managed registry stores `adapterId`, not executable configuration or credentials.
Consequently, loading a session still requires the consumer to resolve that ID.

## Choose direct or managed sessions

Use a direct `AgentSession` when the application wants a transient ACP connection or owns
all persistence externally. Direct sessions perform no V2 persistence by default.

Use `SessionManager.open()` when the library should maintain a durable logical-session
registry and transcripts. Calling `SessionManager.open()` is the opt-in to managed local
persistence.

For most orchestrators, the managed path is the recommended starting point.

## Open a managed session manager

```ts
const sessions = await SessionManager.open({
  root: "/absolute/path/to/application-state",
  sessionDefaults: {
    transcript: { preset: "activity" },
    auditLog: false,
  },
});
```

Root resolution is:

1. An explicit `root`.
2. `ACP_CLIENT_HOME`.
3. `~/.acp-client`.

The default managed configuration enables an `activity` transcript and disables the
independent audit log. A session can override manager defaults unless a manager constraint
forbids the resulting configuration. For example, a product that must always retain
continuation history can separately set `sessionConstraints.transcript` to `"required"`;
that manager will intentionally reject the registry-only example below.

## Create a managed logical session

```ts
async function createSession(adapterId: string): Promise<AgentSession> {
  const session = await sessions.createAgentSession({
    adapter: resolveAdapter(adapterId),
    adapterId,
    cwd: process.cwd(),
    title: "Repository agent",
    defaultPermission: "cancel",
    persistence: {
      transcript: { preset: "activity" },
    },
    onOpenProgress: projectOpenProgress,
  });

  liveSessions.set(session.agentSessionId, session);
  return session;
}

function projectOpenProgress(event: AgentSessionOpenStage): void {
  // Project this ephemeral event into your own UI/WebSocket protocol.
  console.log(event.stage, event);
}
```

`agentSessionId` and `creationId` are generated when omitted. A consumer that needs
idempotent retries across process failure may supply stable values itself.

To create a registry-only session:

```ts
const session = await sessions.createAgentSession({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  persistence: {
    transcript: false,
    auditLog: false,
  },
});
```

Registry-only mode preserves continuation state but not conversational history. It cannot
reconstruct the conversation if the provider thread becomes unavailable.

Managed creation and loading currently require normal ACP mode. Managed degraded/PTY
sessions are not implemented.

## Prompt and stream a turn

```ts
const handlers: PromptHandlers = {
  onChunk: (text) => process.stdout.write(text),
  onActivity: (event) => renderActivity(event),
  onRecord: (record) => publishFoldedActivity(record),
  onPermissionRequest: (request) => {
    const allow = request.options.find((option) => option.kind === "allow_once");
    return allow
      ? { outcome: "selected", optionId: allow.optionId }
      : { outcome: "cancelled" };
  },
};

const result = await session.prompt("Inspect the failing tests.", handlers);

console.log(result.status);
for (const message of result.messages) {
  renderAssistantMessage(message);
}
// Only when this consumer explicitly needs one string:
console.log(formatResponseMessages(result.messages, "\n\n"));
console.log(result.operationId);
console.log(result.metering);
```

Prompts, configuration changes, handoffs, and other mutations are serialized by each
`AgentSession`. Multiple different `AgentSession` objects may operate concurrently.

`result.messages` is the canonical response. A prompt operation may contain several
distinct assistant messages; render them separately when the UI supports that. The
deprecated `result.text` property is only a compatibility projection and inserts a blank
line between messages. `formatResponseMessages()` makes any deliberate flattening policy
consumer-owned.

## Observe state, context, and usage

Read a snapshot first, then subscribe to changes:

```ts
publishState(session.state);

const unsubscribe = session.subscribe((notification: AgentSessionNotification) => {
  publishNotification(notification);

  if (notification.event.kind === "state_changed") {
    publishState(notification.event.state);
  }

  if (notification.event.kind === "metering_recorded") {
    persistBillingMetadata(notification.event.record);
  }

  if (notification.event.kind === "presentation_recorded") {
    upsertChatItem(notification.event.item.id, notification.event.item);
  }
});
```

`onResponseChunk` and activity callbacks are provisional live streams. A
`presentation_recorded` notification means the displayed item revision has been appended
to the V2 transcript. Its ID, first position, revision, record sequence, and operation ID
are exactly the values the presentation reader returns after a restart. Upsert by `id`
and ignore revisions older than the one already rendered.

Useful live properties include:

```ts
session.state;
session.isBusy;
session.queuedOperationCount;
session.contextWindow;     // active thread only, or null
session.providerCost;      // provider telemetry, not asserted invoice truth
session.meteringSnapshot;  // logical-session totals and coverage
session.model;
session.providerId;
```

`contextWindow` describes the latest usage observation for the active internal thread. It
is cleared after a handoff until the new thread reports its context. Metering totals belong
to the stable logical session and continue across internal-thread changes.

Each completed token-consuming operation carries its own `OperationMeteringRecord`. Store
that record in the consumer's billing or analytics system if it is financially relevant;
do not use the transcript as an authoritative billing ledger.

Metering defaults to `best_effort` with the pinned models.dev pricing catalog. The other
enforcement modes have narrower meanings:

- `telemetry_required` stops after missing or invalid ACP usage, but ACP telemetry is not a
  billing guarantee.
- `billing_required` requires a registered certified per-inference integration. Plain ACP
  usage can never satisfy it.

```ts
const session = await sessions.createAgentSession({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  metering: {
    enforcement: "best_effort",
  },
});
```

Subscription authentication is not inferred as a metering mode. Treat subscription usage
as informative telemetry; use a certified integration and consumer-controlled API billing
when token costs must be enforceable.

## Interrupt, stop, and own live objects

```ts
session.interrupt();
session.interrupt({ clearQueue: true });

await session.stop();
liveSessions.delete(session.agentSessionId);
```

`stop()` is terminal for that object. The logical session remains in the manager and can
later be loaded into a new live object.

## List and inspect managed sessions

Listing is cursor-paginated and does not start a harness:

```ts
const page = await sessions.listAgentSessions({
  limit: 100,
  includeDeleted: false,
  order: "updated_desc",
});

for (const item of page.sessions) {
  console.log(item.agentSessionId, item.adapterId, item.lifecycle);
}
```

Inspect one session or its current continuation checkpoint:

```ts
const info = await sessions.getAgentSessionInfo(agentSessionId);
const resolved = await sessions.getAgentSessionCheckpoint(agentSessionId);

if (!info || !resolved) throw new Error("Unknown session");

console.log(resolved.source);        // "transcript" or "registry_projection"
console.log(resolved.authoritative);
console.log(resolved.checkpoint.internalSessionId);
```

Maintenance inspection is also offline:

```ts
await sessions.getSessionMaintenance(agentSessionId);
await sessions.listSessionMaintenance({ limit: 100 });
```

A prepared maintenance record means an interrupted create, restore, reconfiguration, or
deletion should be resumed or resolved before ordinary mutations continue.

## Load an existing session

The manager requires the adapter at runtime but selects continuation from persisted state:

```ts
async function loadSession(agentSessionId: string): Promise<AgentSession> {
  const info = await sessions.getAgentSessionInfo(agentSessionId);
  if (!info) throw new Error(`Unknown session: ${agentSessionId}`);

  const opened = await sessions.loadAgentSession(agentSessionId, {
    adapter: resolveAdapter(info.adapterId),
    adapterId: info.adapterId,
    defaultPermission: "cancel",
    onOpenProgress: projectOpenProgress,
  });

  console.log(opened.continuation);
  console.log(opened.recovery);
  console.log(opened.configuration);
  console.log(opened.promptability);
  console.log(opened.repairs);

  liveSessions.set(agentSessionId, opened.session);
  return opened.session;
}
```

Managed creation and loading report the same ordered progress vocabulary:

```text
initializing
→ initialized (ACP capabilities are available)
→ internal_session_acquired (created or resumed)
→ ready (managed persistence is finalized and promptability is known)
```

The callback exists because the live `AgentSession` is not available for subscription
until the operation returns. Progress is ephemeral and is not transcript or registry
authority. A failed operation does not report `ready`, and a retry begins a new sequence.
Callback failures are logged and do not fail or roll back the managed operation.

Loading never silently creates a replacement provider thread. By default it attempts the
persisted `internalSessionId`. If that thread is unavailable, continuation reports the
failure and the returned session may be non-promptable.

For cross-adapter or missing-thread recovery, supply an explicit ordered continuation
strategy, such as a consumer-owned continuation:

```ts
const opened = await sessions.loadAgentSession(agentSessionId, {
  adapter: resolveAdapter(targetAdapterId),
  adapterId: targetAdapterId,
  continuation: {
    strategies: [
      { kind: "load_internal_session" },
      {
        kind: "new_from_consumer_continuation",
        continuationId: "summary-v3",
        continuation: portableSummary,
      },
    ],
  },
});
```

The consumer should always inspect `promptability`. Do not assume that successfully
opening files means the provider state is safe to mutate.

## Resolve recovery and configuration blockers

An uncertain operation boundary is never guessed away. The consumer explicitly decides:

```ts
await session.resolveRecovery({
  strategy: "accept_harness_state",
});

// Or deliberately replace the provider thread:
await session.resolveRecovery({
  strategy: "start_new_internal_session",
  continuation: portableSummary,
});
```

If persisted configuration no longer matches what the harness announces:

```ts
await session.resolveConfigurationMismatch({
  strategy: "accept_effective",
});

// Or apply an exact ordered replacement target list:
await session.resolveConfigurationMismatch({
  strategy: "replace_restoration_targets",
  selections: [
    { configId: "model", value: "anthropic/claude-sonnet-4" },
  ],
});
```

These are separate state machines. Resolving recovery does not implicitly accept a
configuration mismatch.

## Handoff without losing logical identity

```ts
const handoff = await session.handoff();
```

The current thread generates portable continuation context, the library creates a new
thread on the same adapter, and the same `AgentSession` continues:

```ts
handoff.agentSessionId === session.agentSessionId;
handoff.toInternalSessionId === session.internalSessionId;
```

If the consumer already has a summary, bypass summary generation:

```ts
await session.handoff({
  summary: "Objective, decisions, current state, and next steps...",
});
```

V0 handoff uses the current adapter. The default summary-generation and new-thread
introduction prompts are library-defined, and introduction is an ordinary user prompt
because ACP has no portable system-prompt field.

## Harness configuration and commands

ACP configuration is available through the stable session:

```ts
console.log(session.configOptions);
await session.setConfig("model", "some-model");
await session.authenticate(methodId, { onOutput: showAuthOutput });
```

Configuration selected through `AgentSession` is checkpointed according to the configured
`sessionConfiguration` persistence policy and reapplied during loading.

Harness slash commands are discovered as metadata:

```ts
for (const command of session.internalSessionCommands) {
  console.log(command.name, command.description, command.input?.hint);
}

await session.executeInternalSessionCommand("usage");
await session.executeInternalSessionCommand("status", "verbose");
```

ACP sends a harness command as a prompt. `executeInternalSessionCommand()` makes the layer
explicit and routes it through the logical session's queue, lifecycle, transcript, and
metering machinery. Advertisement is discovery rather than an allow-list.

## Discover commands for a UI

The library exposes command metadata separately for the two local operation layers. A UI
bound to one stable logical session can read the AgentSession command registry:

```ts
const clientCommands = getAgentSessionCommands(session);

for (const command of clientCommands) {
  renderCommand({
    name: command.id,
    description: command.description,
    arguments: command.arguments,
    disabled: !command.available,
    disabledReason: command.unavailableReason,
  });
}
```

This registry contains `/handoff`, `/bridge`, and the introspection commands implemented
by `createAgentSessionCommands()`. Its availability is recomputed from current session
state. `/exit` is intentionally absent because it belongs to a particular REPL, not to an
`AgentSession`.

The lower-level controller exposes its own dynamically negotiated registry:

```ts
for (const command of controller.getCommands()) {
  console.log(command.id, command.description, command.arguments);
  if (!command.available) console.log(command.unavailableReason);
}
```

These are provider-thread and transport controls such as `/load`, `/fork`, `/config`, and
`/degrade`; they are not aliases for logical-session operations. Harness-advertised
commands remain the third source in `session.internalSessionCommands` and are invoked
explicitly with `executeInternalSessionCommand()`. A consumer can merge all three sources
for display while retaining their origin so dispatch never crosses layers accidentally.

## Configure transcripts

Transcripts and audit logs are separate artifacts:

- A transcript supports conversation display, continuation, debugging, and restoration.
- An audit log supports a filtered operational history without copying conversation text.
- The registry is the managed inventory and current routing projection.

Configure them per session:

```ts
const session = await sessions.createAgentSession({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  persistence: {
    transcript: {
      path: "/absolute/path/to/transcripts", // directory or exact file
      preset: "detailed",
      capture: {
        permissions: "decision",
        protocol: "none",
      },
    },
    auditLog: {
      path: "/absolute/path/to/audit",
      capture: {
        tools: "input",
        usage: true,
      },
    },
    sessionConfiguration: {
      values: "typed",
      exclude: ["secret-option"],
    },
  },
});
```

If a configured path is an existing directory, the library derives the filename from
`agentSessionId`. A file path is used exactly. Default managed locations are beneath the
manager root in separate transcript and audit directories.

Available transcript presets are:

| Preset | Intended use |
|---|---|
| `conversation` | User/assistant text with minimal transition metadata |
| `activity` | End-user operation history without reasoning or tool contents |
| `detailed` | Reasoning, tool input/output, and richer transition details |
| `diagnostic` | Full diagnostic capture, including raw protocol records |

Capture filtering happens before persistence. Selecting a more detailed preset is an
explicit decision to persist more sensitive content. Limits and truncation protect record
size; structural identity is never truncated merely to force an invalid record to fit.

The files are plaintext. The library does not provide encryption, tamper resistance, a
billing source of truth, or automatic retention policy. Apply filesystem permissions,
retention, backup, and deletion policy appropriate to the application.

## Read a transcript with pagination

Resolve its authoritative path without starting the harness:

```ts
const resolved = await sessions.getAgentSessionCheckpoint(agentSessionId);
const path = resolved?.checkpoint.transcript?.path;
if (!path) throw new Error("This session has no transcript");

const reader = new TranscriptReader(path);
```

The reader offers three projections:

```ts
const conversation = await reader.readPage({
  view: "conversation",
  limit: 50,
});

const timeline = await reader.readPage({
  view: "timeline",
  types: ["message", "activity", "transition"],
  limit: 50,
});

const records = await reader.readPage({
  view: "records",
  limit: 50,
});
```

For an end-user chat timeline, prefer the folded presentation projection:

```ts
const presentation = await reader.readPresentationPage({ limit: 50 });

for (const item of presentation.items) {
  // message, reasoning, or activity; activity revisions are already folded.
  renderOrReplace(item.id, item);
}
```

`readPresentationPage()` preserves the order in which logical items first appeared. A
tool that settles later keeps its original position, and distinct assistant messages stay
separate around intervening activity. The raw `timeline` view intentionally remains
available when the consumer needs every physical lifecycle revision rather than a chat
projection. Presentation pagination scans the snapshot with bounded item memory and does
not require the consumer to load the entire transcript.

Each page is ordered oldest-first within that page, while the initial page selects the
newest matching records. Navigate using `olderCursor` and `newerCursor`:

```ts
const older = timeline.olderCursor
  ? await reader.readPage({
      view: "timeline",
      types: ["message", "activity", "transition"],
      cursor: timeline.olderCursor,
      limit: 50,
    })
  : null;
```

Navigation cursors are bound to the snapshot, view, and filter. Reusing one with another
view or filter fails explicitly. Appends after the snapshot do not reorder the page being
read, while rewrites before its boundary invalidate the cursor.

Presentation navigation uses its own cursor type and the same stable snapshot semantics.
V1 and older V2 records without presentation metadata remain readable through `readPage`
but are not assigned invented interleaving in the folded V2 presentation view.

Fold revisioned activities at the same snapshot:

```ts
const activity = await reader.listActivityStates({
  at: timeline.snapshot,
  status: "open",
  order: "updated_desc",
  limit: 100,
});
```

An activity that was open at the snapshot remains `historically_open`; the reader does not
claim that a tool is still executing in a process it cannot observe.

## Read the independent audit log

```ts
const audit = new AuditLogReader(knownAuditLogPath);

const page = await audit.readPage({
  types: ["operation", "activity", "permission", "metering_reference"],
  limit: 100,
});
```

Audit pagination has the same stable-snapshot behavior. V0 summaries expose whether an
audit log is available but do not expose its path. A consumer that enables an audit log
should retain the configured path or derive it as part of its own persistence policy.

## Reconfigure persistence offline

Stop the live session before reconfiguration. Transcript and audit mutations are separate
fenced V0 operations.

```ts
const info = await sessions.getAgentSessionInfo(agentSessionId);
const resolved = await sessions.getAgentSessionCheckpoint(agentSessionId);
if (!info || !resolved) throw new Error("Unknown session");

await sessions.reconfigureAgentSessionPersistence(agentSessionId, {
  reconfigurationId: crypto.randomUUID(),
  expectedIncarnationId: info.incarnationId,
  expectedRecordRevision: info.recordRevision,
  transcript: {
    action: "replace",
    config: {
      path: resolved.checkpoint.transcript!.path,
      preset: "conversation",
    },
    checkpoint: resolved.checkpoint,
    acknowledgeContinuationLoss: true,
  },
});
```

V0 replacement changes the generation and policy while retaining the recorded path.
Disablement permanently removes that artifact and requires the corresponding explicit
acknowledgement. Use the managed CLI when an operator-facing confirmation flow is desired.

## Delete and restore managed sessions

Deletion is tombstoning by default. The consumer supplies incarnation and revision CAS
tokens so a delayed request cannot delete a newly reused logical identity.

```ts
const info = await sessions.getAgentSessionInfo(agentSessionId);
if (!info) throw new Error("Unknown session");

await sessions.deleteAgentSession(agentSessionId, {
  deletionId: crypto.randomUUID(),
  expectedIncarnationId: info.incarnationId,
  expectedRecordRevision: info.recordRevision,
  deleteTranscript: false,
  deleteAuditLog: false,
  removeRegistryEntry: false,
});
```

Hard registry removal is allowed only when all retained artifacts are deleted in the same
operation. Prefer tombstones when restoration or identity history matters.

Restore a tombstone explicitly:

```ts
const deleted = await sessions.getAgentSessionInfo(agentSessionId, {
  includeDeleted: true,
});
if (!deleted) throw new Error("Unknown session");

const opened = await sessions.restoreAgentSession(agentSessionId, {
  adapter: resolveAdapter(deleted.adapterId),
  adapterId: deleted.adapterId,
  restorationId: crypto.randomUUID(),
  expectedIncarnationId: deleted.incarnationId,
  expectedRecordRevision: deleted.recordRevision,
});
```

Retained artifacts are reused. If an artifact was deleted, restoration requires an
explicit `false` or an absolute normalized replacement filename; directory shorthand is
not accepted because restoration IDs must remain stable if filesystem state changes. It
never silently recreates the previous file. The returned value has the same continuation, recovery, configuration,
promptability, and repairs report as ordinary managed loading.

## Use the command layers in a UI

The one-session REPL uses unambiguous routing:

```text
ordinary text     -> session.prompt(...)
/command          -> local AgentSession command
//command [input] -> session.executeInternalSessionCommand(...)
```

```ts
try {
  await runAgentSessionRepl(session, {
    activity: true,
    onSlashCommand: async (command, args) => {
      if (command !== "tag") return false;
      await addTag(session.agentSessionId, args.join(" "));
      return true;
    },
  });
} finally {
  await session.stop();
}
```

Built-in local commands include `/session`, `/state`, `/commands`, `/handoff`, and
`/bridge`. Unknown `/...` commands never fall through as prompts. A graphical application
can skip slash parsing and bind the same methods directly to buttons, RPC methods, jobs,
or orchestration events.

The packaged managed CLI is a reference consumer:

```bash
acp-client create [AGENT_SESSION_ID] --adapter opencode
acp-client open AGENT_SESSION_ID
acp-client sessions --json
acp-client info AGENT_SESSION_ID
acp-client checkpoint AGENT_SESSION_ID
acp-client maintenance [AGENT_SESSION_ID]
acp-client restore AGENT_SESSION_ID
acp-client reconfigure AGENT_SESSION_ID --replace-transcript --preset detailed --yes
acp-client delete AGENT_SESSION_ID --delete-transcript --yes
```

## Direct sessions

Direct sessions are intentionally persistence-free unless configured:

```ts
const session = await AgentSession.create({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  providerSession: { kind: "new" },
});
```

Direct V2 persistence requires stable logical and creation identities because there is no
manager catalog to discover generated ones after a crash:

```ts
const session = await AgentSession.create({
  adapter: ADAPTERS.opencode,
  adapterId: "opencode",
  agentSessionId,
  creationId,
  providerSession: { kind: "new" },
  persistence: {
    root: "/absolute/application-state",
    transcript: { preset: "activity" },
  },
});
```

In V0 this direct transcript path is a preview convenience, not a crash-resumable creation
transaction. A failure after the transcript header is installed can leave an initialized
artifact which must be opened or cleaned up explicitly. Direct audit persistence is
rejected instead of creating an audit file which the live session cannot safely own.

For durable persistent applications, use `SessionManager.createAgentSession()` and
`SessionManager.loadAgentSession()`. The manager owns prepared creation, registry fencing,
audit attachment, retry discovery, and completion receipts.

## Legacy compatibility

`FileSessionStore`, `sessions:`, `transcriptPath`, `transcriptDir`, and
`transcriptActivity` remain for compatibility with the earlier flat catalog/transcript
model. They should not be used for new managed implementations.

Legacy transcript conversion and registry import are explicit:

```ts
await migrateLegacyTranscript(options);
await sessions.importLegacySessions(legacyStore);
```

Migration preserves the legacy prefix for presentation and establishes a new V2 authority
boundary. Strict V2 creation never claims an already initialized legacy file implicitly.

## Current V0 boundaries

- Managed creation and loading support normal ACP mode only.
- Direct V2 creation supports transcript-only persistence and is not crash-resumable;
  direct V2 audit persistence is rejected.
- Direct V2 opening currently requires an explicit `agentSessionId` and transcript;
  checkpoint-only and exact-file identity inference are deferred.
- Handoff creates a new thread on the current adapter.
- Tombstone restoration currently loads only the recorded provider thread; reconstruction
  strategies remain available to ordinary managed loading but are deferred for restoration.
- Transcript and audit reconfiguration are separate operations.
- Replacement reconfiguration retains the existing artifact path.
- Generic ACP load cannot prove what happened after a crash; uncertainty requires an
  explicit consumer decision.
- Session logs are plaintext and do not provide encryption or tamper resistance.
- Metering records are application telemetry, not an invoice or trusted billing ledger.
- A transcript or audit generation has one active writer, enforced by a writer lock.
- Retention policy and automatic pruning belong to the consumer.

## Recommended ownership rules

- Key application state by `agentSessionId`, never `internalSessionId`.
- Keep live `AgentSession` objects in the consumer; use the manager for durable discovery.
- Resolve adapter IDs in the consumer and fail explicitly when one is unknown.
- Inspect `AgentSessionOpenResult.promptability` before dispatching work.
- Read state before subscribing so no initial snapshot is missed.
- Persist operation metering records separately when they matter financially.
- Use transcript presets deliberately; detailed and diagnostic capture can contain secrets.
- Keep local commands distinct from harness commands.
- Stop every live session during application shutdown.
- Do not infer provider loading from a transcript path or file contents.
