# Consumer guide

This guide is for applications that embed `@qlairoslabs/acp-client`, especially
orchestrators that keep several agents alive at once. The library supplies the ACP
connection and stable-session primitives; the consumer owns the collection of live
`AgentSession` objects and decides whether operations appear as slash commands, buttons,
HTTP endpoints, jobs, or something else.

The package currently requires Bun 1.3.5 or newer.

## The three operation layers

Keep these layers separate in consumer code:

| Layer | Owner | Library surface | Typical operations |
|---|---|---|---|
| Logical session management | Consumer | `SessionManager`, `SessionStore`, `AgentSession.create()` | Create, catalog, list, reopen, stop, and select `AgentSession` objects |
| Stable session control | `AgentSession` | The live `AgentSession` instance | Prompt, observe state, interrupt, handoff, bridge, stop |
| Active harness session | ACP provider | `internalSessionCommands`, `executeInternalSessionCommand()`, `session.connection` | Run advertised commands and use provider capabilities/configuration |

An `agentSessionId` is the stable consumer-facing identity. An `internalSessionId` belongs
to the currently active provider thread and may change during a handoff or mode change.

```text
consumer registry
  └── AgentSession agent-7            stable object and agentSessionId
        └── internal session abc      replaceable provider thread
```

## Install and import

```bash
bun add @qlairoslabs/acp-client
```

Core session APIs come from the package root:

```ts
import {
  AgentSession,
  ADAPTERS,
  FileSessionStore,
  SessionManager,
  type Adapter,
  type AgentSessionNotification,
  type PromptHandlers,
} from "@qlairoslabs/acp-client";
```

Reusable interactive helpers are intentionally in a separate entry point:

```ts
import {
  createAgentSessionCommands,
  dispatchReplInput,
  parseReplInput,
  runAgentSessionRepl,
} from "@qlairoslabs/acp-client/repl";
```

## Resolve adapters in the consumer

An adapter only describes how to launch a harness. Presets are provided, but consumers
can supply any `Adapter` object.

```ts
const adapters: Record<string, Adapter> = {
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

The catalog stores `adapterId`, not executable configuration. This resolver therefore
belongs to the consumer.

Presets do not encode a provider's features. After the process starts, the library
discovers capabilities, authentication methods, configuration, sessions, and harness
commands through ACP. The Pi preset targets `@automatalabs/pi-acp`, which embeds Pi through
its published SDK and installs the `pi-acp` executable. The native `pi` command is used
only for interactive PTY mode.

Install the preset executable globally with `npm install -g @automatalabs/pi-acp`, or use
`{ command: ["npx", "-y", "@automatalabs/pi-acp"] }` as a custom adapter.

## Create the catalog and live-session registry

`SessionManager` is a metadata catalog, not a registry of running objects and not a
transcript store. Use `FileSessionStore` locally or implement `SessionStore` over the
consumer's database.

```ts
const sessionManager = new SessionManager(
  new FileSessionStore("/absolute/path/to/session-catalog"),
);

const liveSessions = new Map<string, AgentSession>();
```

The manager exposes:

```ts
await sessionManager.record(input);
await sessionManager.get(agentSessionId);
await sessionManager.list();
await sessionManager.delete(agentSessionId);
await sessionManager.listMerged(providerSessions, adapterId);
```

Normally the consumer does not call `record()` directly. An `AgentSession` given
`sessions: sessionManager` records itself on startup and updates the record when its
provider identity, mode, title, or transcript location changes.

## Create a logical session

```ts
async function createSession(adapterId: string): Promise<AgentSession> {
  const session = await AgentSession.create({
    adapter: resolveAdapter(adapterId),
    adapterId,
    providerSession: { kind: "new" },
    sessions: sessionManager,
    transcriptDir: "/absolute/path/to/transcripts",
    cwd: process.cwd(),
    defaultPermission: "cancel",
  });

  liveSessions.set(session.agentSessionId, session);
  return session;
}
```

If `agentSessionId` is omitted, the library creates one. Always return or store
`session.agentSessionId`; do not use `internalSessionId` as the orchestrator's key.

`providerSession` is explicit:

```ts
{ kind: "new" }
{ kind: "load", internalSessionId, onFailure?: "error" | "new" }
```

Loading fails closed by default. Use `onFailure: "new"` only when replacing a missing
provider thread is deliberate policy.

## Reopen a cataloged session

`SessionManager.get()` returns routing metadata. It does not start a process. Reopening is
consumer composition because only the consumer knows how to resolve adapters and where to
keep live objects.

```ts
async function reopenSession(agentSessionId: string): Promise<AgentSession> {
  const existing = liveSessions.get(agentSessionId);
  if (existing) return existing;

  const record = await sessionManager.get(agentSessionId);
  if (!record) throw new Error(`Unknown AgentSession: ${agentSessionId}`);

  const session = await AgentSession.create({
    adapter: resolveAdapter(record.adapter),
    adapterId: record.adapter,
    agentSessionId: record.agentSessionId,
    providerSession: record.internalSessionId
      ? {
          kind: "load",
          internalSessionId: record.internalSessionId,
          onFailure: "error",
        }
      : { kind: "new" },
    mode: record.mode,
    cwd: record.cwd,
    title: record.title,
    sessions: sessionManager,
    ...(record.transcriptPath
      ? { transcriptPath: record.transcriptPath }
      : {}),
  });

  liveSessions.set(session.agentSessionId, session);
  return session;
}
```

Transcript existence never selects a provider thread. `transcriptPath` and
`transcriptDir` only select history storage.

## List and select sessions

Use the manager to list the consumer's catalog without starting a harness:

```ts
const catalog = await sessionManager.list();
```

Once a session is connected, `session.listSessions()` merges that catalog with the active
adapter's ACP `session/list` response when the harness supports it:

```ts
const rows = await session.listSessions();

for (const row of rows) {
  console.log(
    row.agentSessionId,
    row.internalSessionId,
    row.adapter,
    row.source, // "catalog" | "agent" | "both"
  );
}
```

Selecting which `AgentSession` receives the next operation is consumer state. The library
does not maintain a global “current AgentSession.”

## Prompt and stream a turn

```ts
const result = await session.prompt("Inspect the failing tests.", {
  onChunk: (text) => process.stdout.write(text),
  onActivity: (event) => renderRawActivity(event),
  onRecord: (folded) => publishFoldedActivity(folded),
  onUpdate: (rawUpdate) => debugProtocolUpdate(rawUpdate),
  onPermissionRequest: (request) => {
    const allow = request.options.find((option) => option.kind === "allow_once");
    return allow
      ? { outcome: "selected", optionId: allow.optionId }
      : { outcome: "cancelled" };
  },
});

console.log(result.status, result.stopReason, result.text, result.usage);
```

Prompts and handoffs on one `AgentSession` are serialized. The consumer does not need a
separate mutex for them.

## Observe state without polling

Read the current snapshot first, then subscribe to future notifications:

```ts
function attachSession(session: AgentSession): () => void {
  publishState(session.state);

  return session.subscribe((notification: AgentSessionNotification) => {
    publishNotification(notification);

    switch (notification.event.kind) {
      case "state_changed":
        publishState(notification.event.state);
        break;
      case "turn_completed":
      case "turn_failed":
      case "handoff_completed":
      case "handoff_failed":
        scheduleDependentWork(session.agentSessionId);
        break;
    }
  });
}
```

Useful snapshots are:

```ts
session.state;
session.isBusy;
session.queuedOperationCount;
```

Notifications carry a monotonically increasing `seq`, timestamp, and stable
`agentSessionId`. A listener exception is isolated from the operation.

## Interrupt and stop

```ts
session.interrupt();                    // cancel the active operation
session.interrupt({ clearQueue: true }); // also discard queued operations

await session.stop();
liveSessions.delete(session.agentSessionId);
```

`stop()` is terminal for that object. Reopen from the catalog to obtain a new live object
with the same logical identity.

## Handoff within the current harness

```ts
const result = await session.handoff();
```

Without options, the old provider thread generates a portable summary. The session then
creates a new provider thread and introduces that summary through a user prompt.

The consumer may provide an already-generated summary:

```ts
const result = await session.handoff({
  summary: "Objective, decisions, current state, and next steps...",
});
```

The following remains true:

```ts
result.agentSessionId === session.agentSessionId;
result.toInternalSessionId === session.internalSessionId;
```

Current limitations are important:

- Handoff only creates a new thread on the current adapter/harness.
- The summary-generation prompt is currently fixed unless generation is bypassed by
  supplying `summary`.
- The new-thread introduction prompt is currently fixed.
- The introduction is an ordinary user prompt, not a system prompt.
- ACP `session/new` has no portable system-prompt field.
- Handoff requires normal ACP mode.

Cross-adapter handoff and independently configurable summary/introduction policies should
be treated as future API work, not emulated by mutating `internalSessionId` in consumer
code.

## Discover and execute harness commands

Commands advertised by the active ACP harness are exposed as immutable metadata:

```ts
for (const command of session.internalSessionCommands) {
  console.log(command.name, command.description, command.input?.hint);
}
```

Changes also arrive through the session listener as
`internal_session_commands_changed`.

Execute one explicitly without including the leading slash:

```ts
await session.executeInternalSessionCommand("usage");
await session.executeInternalSessionCommand("status", "verbose");
```

ACP represents these commands as ordinary prompts. The named method makes consumer intent
explicit and keeps the operation in the session queue, transcript, and lifecycle events.
Advertisement is discovery, not an allow-list: a harness may accept a command before it
advertises it.

## Reuse the AgentSession local command set

The same local handlers used by the opinionated one-session REPL are public:

```ts
const localCommands = createAgentSessionCommands({
  session,
  note: (message) => showNotice(message),
});

const handled = await localCommands.onSlashCommand("state", []);
```

The built-in set currently handles:

```text
/help
/session
/state
/commands
/handoff [SUMMARY]
/bridge
```

`/exit` is handled by the REPL loop rather than the command factory.

The factory currently exposes the handler, not a declarative metadata array for local
commands. A consumer can reuse the handler directly; a custom command palette must define
its own local labels/descriptions for now. Harness commands do have declarative metadata
through `session.internalSessionCommands`.

## Run the opinionated single-session REPL

```ts
try {
  await runAgentSessionRepl(session, {
    activity: true,
    spinner: true,
    note: (message) => process.stderr.write(`${message}\n`),
    onSlashCommand: async (command, args) => {
      // Consumer-local extension, tried after the built-in AgentSession commands.
      if (command !== "tag") return false;
      await addTag(session.agentSessionId, args.join(" "));
      return true;
    },
  });
} finally {
  await session.stop();
}
```

Input routing is deliberately unambiguous:

```text
ordinary text     -> session.prompt(...)
/command          -> local AgentSession command
//command [input] -> session.executeInternalSessionCommand(...)
```

An unknown `/command` is rejected locally and never falls through to the harness.

## Reuse routing in a custom UI

Consumers do not need to use readline. `parseReplInput()` and `dispatchReplInput()` are
terminal-independent:

```ts
const local = createAgentSessionCommands({ session, note: showNotice });
const promptHandlers: PromptHandlers = {
  onChunk: (text) => renderText(text),
  onActivity: (event) => renderActivity(event),
};

await dispatchReplInput(parseReplInput(input), {
  prompt: async (text) => {
    await session.prompt(text, promptHandlers);
  },
  localCommand: (command, args) => local.onSlashCommand(command, args),
  internalSessionCommand: async (command, value) => {
    await session.executeInternalSessionCommand(command, value, promptHandlers);
  },
  unknownLocalCommand: (command) => {
    showNotice(`Unknown local command: /${command}`);
  },
  missingInternalSessionCommand: () => {
    showNotice("A command name is required after //");
  },
});
```

A graphical consumer may skip slash parsing entirely and bind these operations directly
to buttons, menus, RPC methods, or orchestration events.

## Use the lower-level control plane when needed

`session.connection` exposes the live `AgentController` for operations that do not belong
to the stable session abstraction:

```ts
session.capabilities;
session.configOptions;
await session.setConfig("model", "some-model");
await session.authenticate(methodId, { onOutput: showAuthOutput });

const controller = session.connection;
await controller.listSessions();
await controller.loadSession(internalSessionId);
```

Use controller session-switching methods carefully: they operate directly on the provider
thread. Prefer `AgentSession` methods when a stable logical-session equivalent exists, so
the catalog, lifecycle notifications, and transcript remain coherent.

## Transcript policy

Choose exactly one history destination:

```ts
transcriptPath: "/absolute/path/to/conversation.jsonl"
// or
transcriptDir: "/absolute/path/to/transcripts"
```

Omit both to disable transcript writes. This does not disable prompting, handoff, catalog
management, or lifecycle notifications.

Enable settled activity records when the consumer needs tool/thinking/plan history:

```ts
transcriptActivity: {
  checkpointOnInput: true,
  rawOutput: false,
  maxBytes: 64_000,
}
```

Use `readTranscript()` for logical user/assistant messages and `readTranscriptLines()` for
the complete typed stream, including activity and handoff boundaries.

## Recommended ownership rules

- Key orchestration state by `agentSessionId`, never `internalSessionId`.
- Keep the map of live `AgentSession` objects in the consumer.
- Treat `SessionManager` as routing metadata, not a process manager.
- Read `session.state` before subscribing to notifications.
- Use `executeInternalSessionCommand()` instead of constructing slash prompts manually.
- Keep consumer/local commands separate from harness commands in the UI.
- Resolve adapters in the consumer and fail explicitly on unknown adapter ids.
- Stop every live session during consumer shutdown.
- Do not infer provider loading from transcript filenames or contents.
