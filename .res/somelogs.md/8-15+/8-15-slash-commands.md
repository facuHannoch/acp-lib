Yes—I think the missing distinction is real. I would name the three classes:

1. Host/application commands
   Owned by the consumer embedding `acp-lib`. In your case, the orchestration library owns `/usage`.

2. Client-control commands
   Owned by `acp-lib`, operating on `AgentController`, `AgentSession`, `SessionManager`, transcripts, modes, and local catalog state. Examples: `/new`, `/load`, `/sessions`, `/degrade`.

3. Agent commands
   Advertised by the ACP agent through `available_commands_update` and executed by sending the corresponding prompt to the harness.

The current bug is that “unrecognized locally” means “send it to the agent.” That conflates routing failure with agent-command invocation:

```text
/usage
→ acp-lib does not recognize it
→ false
→ REPL treats it as a prompt
→ harness receives /usage
```

That fallback should disappear. Unknown slash commands should never silently become prompts.

The distinction between host and client-control commands matters because they have different owners:

- The host decides what `/usage` means.
- `acp-lib` decides what `/sessions` means.
- The harness decides what its advertised `/usage` means.
- Adding an application command should not require changing `acp-lib`.
- Host commands may need orchestration state that `acp-lib` must not know about.
- Client commands should call typed library operations rather than ask the harness to emulate them.

I would separate two concepts:

```text
Command machinery
  parsing, registration, discovery, routing, help, collision handling

Command providers
  host provider
  acp-lib provider
  agent provider
```

The important point is that slash syntax is only an interactive adapter. `/sessions` should ultimately call a typed `listSessions()` operation. The command itself should not become the canonical state-management API.

A possible model:

```ts
type CommandSource = "host" | "client" | "agent";

interface SlashCommand {
  name: string;
  source: CommandSource;
  description: string;
  usage?: string;
  inputHint?: string;
  available: boolean;
}

interface CommandInvocation {
  name: string;
  rawInput: string;
}

type CommandResult =
  | { kind: "handled" }
  | { kind: "unknown" }
  | { kind: "ambiguous"; candidates: SlashCommand[] };
```

Then the router composes three providers:

```ts
createSlashCommandRouter({
  host: orchestrationCommands,
  client: createClientCommands({ controller, sessionManager }),
  agent: createAgentCommandProvider(client),
});
```

I would use these routing rules:

```text
Normal text       → prompt
Known /command    → route locally according to precedence
Unknown /command  → report “unknown command”; never prompt
//command         → forced agent invocation, retained for compatibility
```

For collisions, there are two reasonable designs.

A lightweight design:

```text
/usage       → host wins
/sessions    → acp-lib wins
//usage      → agent
```

Precedence would be:

```text
host → acp-lib → advertised agent
```

This is convenient, but it leaves no clean way to invoke a shadowed `acp-lib` command if the host registers the same name.

A stronger design adds explicit namespaces:

```text
/usage            → convenient resolution
/host:usage       → explicitly host
/acp:sessions     → explicitly acp-lib
/agent:usage      → explicitly agent
//usage           → short alias for /agent:usage
```

My preference is the stronger model. Most users can use short names, while every collision remains deterministically addressable.

One subtle decision: should a plain `/foo` invoke an advertised agent command? I think yes, but only if it is actually in the current session’s advertised command registry. It must not use the current “any unknown slash line goes to the harness” behavior.

That produces:

```text
/usage
├─ registered host command?       yes → host
├─ registered acp-lib command?    yes → client
├─ currently advertised by agent? yes → agent
└─ otherwise                           unknown command
```

Because agent commands can be advertised late, `//foo` remains useful: it explicitly says “send this to the agent even if discovery has not happened.”

There is also a naming problem in the current code: `createAgentCommands()` actually creates `acp-lib` control commands, not agent commands. I would likely rename it to something like `createClientCommands()` or `createBuiltinCommands()`. The actual ACP-advertised commands would be the agent command provider.

So, in short: classes 1 and 2 should share the same command infrastructure, but remain separate providers with separate ownership and dependencies. Collapsing them into one registry implementation is fine; collapsing their meaning and lifecycle is not.






Yes, with one correction: `SessionManager` is a sibling dependency of `AgentSession`, not underneath the controller.

The intended architecture is:

```text
Consumer / application
        │
        ├── owns SessionManager + SessionStore
        │
        └── owns one or more AgentSessions
                       │
                       ▼
                AgentController
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
         AcpClient           PtyClient
             │                   │
         ACP harness         native TUI
```

`AgentSession` is the durable conversation façade:

- Stable library-level `agentSessionId`.
- Tracks the harness’s `internalSessionId`.
- Persists its metadata through an optionally injected `SessionManager`.
- Records transcripts if configured.
- Owns the activity aggregator.
- Holds an `AgentController`.
- Automatically updates its record after prompts and mode changes.

`AgentController` is the live control plane:

- Starts and stops the agent.
- Prompts and interrupts.
- Creates, loads, resumes, and forks harness sessions.
- Switches normal/degraded mode.
- Exposes capabilities, config, auth, and advertised commands.

`SessionManager` is only a catalog:

- Stores routing metadata.
- Lists library-known sessions.
- Merges the local catalog with the harness’s `session/list`.
- Does not start agents or own live `AgentSession` instances.

So the consumer has to manage the collection of conversations:

- Choose the `SessionStore`.
- Construct the `SessionManager`.
- Resolve adapter IDs into actual adapters.
- Create or restore `AgentSession` instances.
- Decide which session is currently selected.
- Close or retain live sessions.
- Decide what application-level operations mean.

But once an `AgentSession` is created with a manager, the consumer should not need to manually persist its internal session ID after every turn. `AgentSession` handles that.

There is an implementation mismatch today: the CLI bypasses the intended front face:

```text
Current CLI
    → AgentController
    → AcpClient/PtyClient
```

It does not construct an `AgentSession`, `SessionManager`, or transcript. That is why `createAgentCommands()` awkwardly accepts an optional `sessionManager`: the interactive command layer is compensating for bypassing `AgentSession`.

The cleaner CLI would be:

```text
CLI
  → AgentSession
      → AgentController
```

Then the command architecture becomes clearer too:

```text
Consumer / CLI input
        │
        ▼
    Slash router
        │
        ├── application command
        │     e.g. orchestration /usage, /agents, /switch
        │
        ├── acp-lib command adapter
        │     e.g. selectedSession.newSession()
        │          selectedSession.listSessions()
        │          selectedSession.setMode()
        │
        └── advertised agent command
              e.g. selectedSession.prompt("/status")
```

This leads to an important refinement: technically, `acp-lib` does not independently receive slash commands. The UI or consumer receives text. What the library can provide is a standard set of command definitions and handlers backed by its typed APIs.

So I would describe the three sources as:

1. Application commands
   Defined and executed by the consumer.

2. Standard library command adapters
   Supplied by `acp-lib`, but enabled and routed by the consumer. They invoke typed operations on an `AgentSession`.

3. Agent commands
   Dynamically advertised by the selected agent and executed through that session.

Therefore, the distinction between 1 and 2 is real, but it is not “two different command transports.” It is ownership and scope:

- Application commands operate on application/orchestration state, potentially across many sessions.
- Library commands operate on a selected `AgentSession` and the state encapsulated by the library.
- Both are local handlers composed into the same router.
- Only agent commands cross ACP to the harness.

The consumer remains the composition root. `acp-lib` supplies session-management capability and can supply ready-made slash-command handlers, but it should not assume it owns the consumer’s command namespace or global session orchestration.











Yes, there are three meaningful scopes—but we need to name them carefully because “session” currently refers to two different identities.

```text
Workspace / orchestration
    manages multiple AgentSessions
              │
              ▼
AgentSession / connection control
    manages one logical conversation
              │
              ▼
ACP harness
    owns its internal provider session
```

The repetition around “new,” “load,” and “sessions” is real because each layer acts on a different object.

| Scope | Target | Examples |
|---|---|---|
| Orchestration | Multiple library `AgentSession`s | create conversation, select/switch agent, couple agents, close conversation |
| AgentSession control | One selected conversation and its connection | prompt, interrupt, bridge, reconnect, mode, config, auth |
| Harness commands | Agent-specific behavior inside its internal session | advertised `/usage`, `/status`, `/sessions`, `/compact` |

## 1. Orchestration layer

This is where coupling agents eventually lives.

It should own:

- All live `AgentSession` instances.
- The currently selected `AgentSession`.
- Creating and closing logical conversations.
- Restoring conversations from the catalog.
- Switching between conversations.
- Routing messages between agents.
- Later: teams, parent/child relationships, inboxes, handoffs.

The existing `SessionManager` is not quite this. It is only a persistent catalog; it does not own live sessions or selection.

Conceptually, something else is missing:

```ts
class AgentWorkspace {
  sessions: Map<string, AgentSession>;
  activeSessionId: string | null;

  createSession(...): Promise<AgentSession>;
  openSession(agentSessionId: string): Promise<AgentSession>;
  switchSession(agentSessionId: string): AgentSession;
  closeSession(agentSessionId: string): Promise<void>;
}
```

The exact name could be `AgentWorkspace`, `AgentPool`, or `AgentSessionRegistry`. This object would use `SessionManager` for persistence.

Commands here might be:

```text
/new
/switch <agentSessionId>
/agents
/close
/couple <agentA> <agentB>
```

These commands must never reach a harness.

## 2. AgentSession control layer

This operates on one selected logical conversation.

It owns operations such as:

- `prompt()`
- `interrupt()`
- `bridge()`
- `setMode()`
- Authentication
- Configuration
- Capabilities
- Connecting and reconnecting
- Materializing the correct harness session

So yes, `bridge` belongs here. It applies to one selected `AgentSession` and changes how we interact with its underlying agent process.

Commands might be:

```text
/bridge
/config
/caps
/login
/degrade
/upgrade
```

The important question is where `new`, `load`, `resume`, and `fork` belong. Today they mutate the harness session inside an existing `AgentSession`, but that creates ambiguous semantics.

There are two identities:

```text
agentSessionId     Our stable logical conversation
internalSessionId  Harness/provider conversation
```

I think the higher-level meaning should be:

```text
/new              create a new AgentSession
/switch ID        select an existing AgentSession
/resume ID        restore/materialize an AgentSession from the catalog
/fork ID          create a new AgentSession derived from another
```

The lower-level ACP operations should then become implementation mechanisms:

```text
session/new
session/load
session/resume
session/fork
```

For example:

```text
workspace.openSession("logical-42")
  → read its catalog record
  → construct AgentSession
  → controller calls ACP session/load("provider-abc")
```

This keeps logical identity coherent. Loading an unrelated provider session into an existing `AgentSession` should probably be an internal or explicitly low-level operation, not what ordinary `/load` means.

## 3. Harness command layer

This is genuinely separate from structured ACP control.

ACP methods include:

```text
session/list
session/load
session/resume
session/set_config_option
session/prompt
```

Advertised commands are different:

```text
/usage
/status
/sessions
/compact
```

They are agent-defined textual commands sent through `session/prompt`. They may overlap with structured ACP methods, but they are not equivalent.

For example:

- ACP `session/list` returns structured session data.
- Harness `/sessions` might display prose, open a picker, or behave differently by provider.
- ACP config methods are structured and portable.
- Harness `/model` is provider-specific and may open interactive UI.

Therefore, harness commands should never be used to implement library state management. They are an explicit escape hatch into provider-specific functionality.

## The resulting command routing

I would make the orchestration layer own the slash router:

```text
Input
  │
  ├─ plain text
  │    → activeAgentSession.prompt(text)
  │
  └─ slash command
       ├─ orchestration command?
       │    → AgentWorkspace
       ├─ selected-session command?
       │    → active AgentSession
       ├─ advertised harness command?
       │    → activeAgentSession.executeAgentCommand(...)
       └─ unknown
            → local error, never silently sent to harness
```

Explicit qualification can resolve collisions:

```text
/new                 workspace command
/session:bridge      selected AgentSession control
/agent:usage         harness command
//usage              shorthand for /agent:usage
```

So my answer is: yes, there are three layers. But only the first two constitute library/application control. The third is provider functionality.

The most important architectural gap is not another handler in `createAgentCommands()`. It is the absence of a runtime object above `AgentSession` that manages multiple logical sessions. Without that layer, multi-agent coupling will always end up awkwardly embedded in CLI handlers or consumer-specific maps.





I think your original instinct was right: `acp-lib` should stop at `AgentSession`. The consumer is the orchestration layer.

Adding an `AgentWorkspace` above it would impose opinions about:

- How many agents stay live.
- Whether there is one “active” agent at all.
- How agents are identified.
- How messages are routed between agents.
- Whether agents form a tree, graph, team, or pool.
- When sessions are evicted or reconnected.
- How coupling and handoffs work.

Those are orchestration-library concerns, not ACP client concerns. A wrapper above `AgentSession` would either be too opinionated or mostly proxy every `AgentSession` method.

The intended model should therefore be:

```text
Orchestration consumer
  ├── owns SessionManager / SessionStore
  ├── owns N AgentSessions
  ├── decides routing and lifecycle
  └── optionally owns its own CLI
             │
             ▼
        AgentSession
             │
             ▼
       AgentController
             │
       AcpClient/PtyClient
```

The consumer might contain something as simple as:

```ts
class MyOrchestrator {
  readonly sessions = new Map<string, AgentSession>();
  readonly catalog: SessionManager;

  async createAgent(...): Promise<AgentSession>;
  async restoreAgent(agentSessionId: string): Promise<AgentSession>;
  async send(agentSessionId: string, prompt: string): Promise<PromptResult>;
  async stopAgent(agentSessionId: string): Promise<void>;
}
```

But `acp-lib` should not require this shape.

`AgentSession` already handles the important per-conversation responsibilities:

- Stable library identity.
- Internal harness session identity.
- Prompt queuing.
- Transcript writing to a consumer-selected location.
- Activity aggregation.
- Catalog persistence when a `SessionManager` is attached.
- Live controller ownership.
- Mode and connection state.

The consumer supplies the policy; `AgentSession` supplies the mechanics.

## Commands do not require a top-level orchestrator abstraction

The command system can be composable without requiring `acp-lib` to own multiple sessions.

The central observation is that commands live at the UI boundary:

```text
CLI/input
   → command router
       → consumer handler
       → selected AgentSession handler
       → selected harness command
```

The consumer builds that router and supplies whichever session should receive session-level or harness-level commands.

For example:

```ts
const router = createSlashCommandRouter({
  commands: [
    ...orchestratorCommands(orchestrator),
    ...createAgentSessionCommands(() => orchestrator.activeSession),
    ...createHarnessCommands(() => orchestrator.activeSession),
  ],
});
```

Notice that `acp-lib` does not need to know what an orchestrator is. It only needs a callback that returns the relevant `AgentSession`:

```ts
type SessionResolver = () => AgentSession | null;
```

That avoids a large wrapper interface.

The consumer owns commands such as:

```text
/agents
/switch
/spawn
/kill
/couple
/usage          if this means orchestration-wide usage
```

The library can contribute commands operating on the selected `AgentSession`:

```text
/session
/bridge
/config
/caps
/login
/degrade
/upgrade
```

And the dynamic harness provider contributes:

```text
/agent:usage
/agent:status
/agent:sessions
//usage
```

All three use the same parser and router, but only the consumer decides how they are composed.

## The two CLIs

I think the two-CLI idea is exactly right.

### 1. AgentSession CLI

A generic CLI shipped with `acp-lib` for talking to one conversation:

```text
acp-client chat
```

It should instantiate one `AgentSession`, optionally backed by:

- A `SessionManager`.
- A filesystem session store.
- A transcript path.
- A selected adapter.

Its commands would be limited to:

- Operations on that `AgentSession`.
- Commands advertised by its harness.
- Basic REPL commands such as `/help` and `/exit`.

It would not have `/agents`, `/switch-agent`, `/couple`, or orchestration concepts.

The current CLI is approximately this, but it constructs `AgentController` directly. To match the intended architecture, it should construct `AgentSession`.

### 2. Consumer/orchestration CLI

Owned by the orchestration library or application:

```text
orchestrator chat
```

It manages N `AgentSession`s and defines commands such as:

```text
/agents
/spawn codex
/switch researcher
/send reviewer "inspect this"
/couple researcher reviewer
```

When ordinary text is entered, the consumer decides which `AgentSession` receives it.

It can reuse:

- The REPL input/output machinery.
- The slash-command parser/router.
- Standard `AgentSession` command definitions.
- Harness-command discovery and execution.

But it adds its own command provider first.

## What `acp-lib` should expose

Rather than adding an orchestration class, I would expose these composable pieces:

```ts
parseSlashCommand(line)
createSlashCommandRouter(...)
createAgentSessionCommands(resolveSession)
createHarnessCommands(resolveSession)
runRepl(...)
```

The consumer then owns composition:

```ts
const router = createSlashCommandRouter([
  consumerCommands,
  createAgentSessionCommands(() => selectedSession),
  createHarnessCommands(() => selectedSession),
]);
```

The router should return an explicit result:

```ts
type RouteResult =
  | { kind: "handled" }
  | { kind: "not_command" }
  | { kind: "unknown_command"; name: string }
  | { kind: "ambiguous"; candidates: CommandDescriptor[] };
```

Most importantly, `unknown_command` must not mean “send it to the harness.”

So I would preserve the original boundary:

- `AgentSession` is the top-level conversation abstraction provided by this library.
- The consumer owns multiple `AgentSession`s.
- `SessionManager` provides optional persistence, not orchestration.
- The command system is a composition toolkit.
- The included CLI is a single-`AgentSession` consumer.
- An orchestration CLI is a different consumer that adds higher-level commands.

That gives the orchestration library full freedom without forcing it to rebuild parsing, help, collision handling, or harness-command discovery.







# final proposed form


Yes. The key is to stop calling every operation a “command.” Commands are only one UI representation of operations.

There are three operation scopes:

| Scope | Owner | Examples |
|---|---|---|
| AgentSession management | Consumer/orchestration layer | create, restore, select, switch, close, couple |
| Selected AgentSession control | `acp-lib` | prompt, interrupt, bridge, config, auth, mode |
| Harness-specific behavior | ACP agent | advertised `/usage`, `/status`, `/compact` |

Only the last category is inherently a slash command because the harness advertises it as one. The other two are typed APIs that a CLI may expose as slash commands.

A graphical consumer could represent them as:

- An agent sidebar for switching.
- A “New conversation” button.
- A model/configuration panel.
- A bridge button.
- A usage dashboard.
- A command palette.

No slash syntax is required.

## 1. AgentSession management

This is above an individual `AgentSession`:

```ts
const session = await AgentSession.create(...);
sessions.set(session.agentSessionId, session);
activeSession = session;
```

Operations include:

```ts
createAgentSession()
restoreAgentSession()
selectAgentSession()
closeAgentSession()
forkAgentSession()
coupleAgents()
```

The consumer owns those operations.

The library supplies the necessary pieces:

- `AgentSession`
- `SessionManager`
- `SessionStore`
- Catalog records
- Restore metadata

A CLI can map them to:

```text
/new
/sessions
/switch ID
/resume ID
/close ID
```

But those names and semantics belong to that CLI or consumer.

## 2. Operations on one AgentSession

These are methods on the selected session:

```ts
session.prompt(...)
session.interrupt()
session.bridge()
session.setMode(...)
session.setConfig(...)
session.authenticate(...)
```

Potential CLI bindings are:

```text
/bridge
/config
/caps
/login
/degrade
/upgrade
```

Ordinary text maps to:

```ts
session.prompt(text)
```

One design correction follows from this division: `/new`, `/load`, and `/resume` probably should not be single-session commands that replace the internal harness session inside an existing logical `AgentSession`.

At the managed CLI level:

```text
/new
```

should create a new `AgentSession`.

```text
/resume logical-id
```

should restore an `AgentSession`, which internally loads the associated harness session.

The low-level ACP `session/new` and `session/load` calls remain available as implementation mechanisms, but they do not need direct user-facing commands in the single-session REPL.

## 3. Harness-specific operations

These are the commands learned from:

```text
available_commands_update
```

Examples:

```text
/usage
/status
/compact
/sessions
```

They are dynamic, agent-specific, and forwarded to the selected harness.

I would expose a typed operation:

```ts
session.executeAgentCommand("usage", "");
session.executeAgentCommand("compact", "focus on the implementation");
```

Internally, that can use `prompt("/usage")`, but consumers should not have to construct the protocol convention themselves.

The CLI can render these as:

```text
/agent:usage
/agent:compact focus on the implementation
//usage
```

## Two REPL/CLI levels

Your two-implementation idea makes sense.

### A reusable single-AgentSession REPL

Something like:

```ts
await runAgentSessionRepl(session, {
  commands: consumerCommands,
});
```

It receives an already-created `AgentSession`. It does not decide how sessions are stored, selected, or restored.

It provides:

- Ordinary prompt handling.
- Streaming output.
- Interrupt keys.
- Standard selected-session commands.
- Advertised harness commands.
- A hook for consumer commands.

Its command space might look like:

```text
/help
/bridge
/config
/caps
/login
/degrade
/upgrade
/agent:usage
//usage
```

This is what an orchestration consumer could launch temporarily for one of its agents:

```ts
await runAgentSessionRepl(orchestrator.getAgent("researcher"));
```

The consumer retains ownership of that session before and after the REPL.

### An opinionated managed CLI

This would own:

- A `SessionStore`.
- A `SessionManager`.
- A collection of live `AgentSession`s.
- An active session.
- Adapter selection.
- Creation and restoration policy.
- Transcript locations.

It would add commands such as:

```text
/new
/sessions
/switch
/resume
/close
```

Then delegate selected-session commands and harness commands to the reusable REPL machinery.

Conceptually:

```ts
const managed = createManagedSessionCli({
  store: new FileSessionStore(...),
  resolveAdapter,
  transcriptDir,
});

await managed.run();
```

This opinionated implementation can be exported as a convenience, but it should be built on top of public primitives. It should not become a required wrapper around `AgentSession`.

## The layering

```text
Reusable REPL engine
  parsing, rendering, streaming, command routing
             ▲
             │
Single-AgentSession REPL
  selected-session commands + harness commands
             ▲
             │
Opinionated managed CLI
  session management commands + active session
```

An orchestration consumer can choose any level:

```text
Own UI entirely
    → call AgentSession methods directly

Reuse single-session REPL
    → supply an AgentSession

Reuse managed CLI
    → accept the library's session-management opinions
```

The current CLI is between the second and third levels: it talks to one controller, but also contains `/new`, `/sessions`, and `/load`. That mixture is why the ownership boundaries feel unclear.

I would reshape it so the single-session REPL is genuinely session-scoped, and the managed CLI is the place where `/new`, `/switch`, and catalog-level `/sessions` acquire their opinionated meanings.



#  TODO


Your list is right, with one important reshaping: `SessionManager` should remain a catalog, while live creation/loading/handoff belongs to `AgentSession` or a small factory. Otherwise `SessionManager` would need adapters, credentials, MCP configuration, transcript paths, permissions, and runtime ownership—and would quietly become the orchestration layer we decided not to build.

## 1. Consumer-facing session lifecycle

The consumer needs a complete path for each operation:

```text
New
  AgentSession.create(config)

List
  sessionManager.list()

Load
  sessionManager.get(agentSessionId)
  → resolve adapter/config
  → AgentSession.restore(...)

Handoff
  existingAgentSession.handoff(...)
  → persist updated routing through SessionManager
```

What is missing is a good restoration API. Today the consumer must:

1. Read a `SessionRecord`.
2. Resolve `record.adapter`.
3. Copy the record fields into `AgentSession.create()`.
4. Supply the manager and transcript configuration again.

That works mechanically, but it is too easy to get wrong. Something like this would be useful:

```ts
const session = await AgentSession.restore({
  agentSessionId,
  sessions: manager,
  resolveAdapter,
  transcriptDir,
  // shared runtime defaults
  mcpServers,
  defaultPermission,
});
```

The consumer still supplies all policy and adapter resolution; the library handles reconstruction.

So I would not add:

```ts
sessionManager.new()
sessionManager.load()
```

I would keep:

```ts
sessionManager.record()
sessionManager.get()
sessionManager.list()
sessionManager.delete()
```

and add stronger `AgentSession.create/restore` lifecycle helpers.

## 2. `AgentSession` surface

The public surface should be sufficient for an orchestrator to operate an agent without reaching into `.connection`.

Minimum useful surface:

```ts
session.prompt(...)
session.interrupt(...)
session.bridge(...)
session.stop()

session.isBusy
session.queuedPromptCount

session.agentCommands
session.executeAgentCommand(...)

session.capabilities
session.configOptions
session.setConfig(...)
session.authenticate(...)
session.setMode(...)

session.activitySnapshot()
```

Possibly also a consolidated state snapshot:

```ts
interface AgentSessionState {
  agentSessionId: string;
  internalSessionId: string | null;
  adapterId: string;
  mode: AgentMode;
  connected: boolean;
  busy: boolean;
  queuedPrompts: number;
}
```

For orchestration, `isBusy` alone may be insufficient. These are different states:

```text
active turn running
queued work waiting
connected but idle
stopped/disconnected
handoff in progress
```

Initially, `isBusy` plus `queuedPromptCount` is enough, but we should define `isBusy` precisely. I suggest:

```text
isBusy === an active turn is running
```

Then expose the queue independently. Otherwise an orchestrator cannot distinguish “agent is thinking” from “there are merely queued prompts.”

A state-change subscription may eventually be necessary:

```ts
session.onStateChange(...)
```

Polling getters is adequate for the first version.

## Handoff needs an exact definition

If by handoff you mean:

> Keep the same `agentSessionId` and transcript, but replace its underlying adapter/controller with another agent.

then this is a genuine `AgentSession` operation:

```ts
await session.handoff({
  adapter: ADAPTERS.claude,
  adapterId: "claude",
  context: ...,
});
```

Its behavior would be:

1. Refuse or queue while the session is busy.
2. Prepare the context that the new agent will receive.
3. Start a replacement controller.
4. Create a new internal harness session.
5. Deliver the handoff context.
6. Atomically replace the old controller.
7. Preserve `agentSessionId` and transcript.
8. Update `adapter`, `adapterId`, and `internalSessionId`.
9. Persist the updated routing record.
10. Stop the old controller.

That conflicts with a current invariant in [agent-session.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent-session.ts:9): adapter switching currently means creating a new `AgentSession`. The controller and adapter identity are effectively fixed. Supporting this kind of handoff is therefore substantial but coherent work.

It should not also be a `SessionManager.handoff()` method. The `AgentSession` performs the live operation and then persists itself through the attached manager.

There is another possible meaning:

> Agent A hands work to an already-existing Agent B.

That belongs entirely to the orchestration consumer because two `AgentSession` identities remain involved.

We should pin down which meaning you want before implementation. Your “keep the AgentSession” wording sounds like the first one.

## 3. Harness-specific commands

The consumer already has partial read access through:

```ts
session.agentCommands
```

But this needs hardening:

- Preserve ACP’s `input` metadata and hint.
- Validate malformed advertised commands.
- Scope updates to the current internal session.
- Clear/update commands consistently across new/load/resume/handoff.
- Avoid exposing the mutable internal array directly.
- Provide an observable update mechanism.
- Add explicit invocation.

For example:

```ts
interface AgentCommand {
  name: string;
  description: string;
  input?: {
    kind: "unstructured";
    hint: string;
  };
}

session.executeAgentCommand(
  "compact",
  "preserve the implementation decisions",
  handlers,
);
```

Internally this can call:

```ts
session.prompt("/compact preserve the implementation decisions", handlers);
```

It is still valuable as a distinct method because it:

- Encodes invocation correctly.
- Makes intent explicit.
- Can check or warn about discovery.
- Can preserve raw input spacing.
- Gives us a stable place for future ACP changes.

I agree that there should not be a core `compact()` method. Unless ACP standardizes compaction, it is harness-specific:

```ts
await session.executeAgentCommand("compact");
```

A consumer can build a convenience method if its supported harnesses provide compatible behavior.

## 4. CLI work

I see three reusable levels, but only two actual CLI experiences.

### REPL engine

```ts
runRepl(client, options)
```

This handles terminal input, streaming, rendering, interruption, and delegates command routing. It should remain low-level.

### Single-AgentSession REPL

New convenience:

```ts
runAgentSessionRepl(session, {
  commands: consumerCommands,
});
```

It supplies:

- Selected-session commands such as bridge/config/caps.
- Harness-command discovery and execution.
- Consumer command composition.
- No ownership of multiple sessions.

This is the embeddable one an orchestrator can launch for one agent.

### Managed CLI

The opinionated executable owns:

- File-backed `SessionManager`.
- AgentSession creation and restoration.
- Current session selection.
- `/new`, `/sessions`, `/switch`, `/resume`.
- Transcript defaults.
- Adapter selection.

This is useful, but correctly lower priority.

The current CLI needs review because it directly constructs `AgentController`; it should likely become either the single-`AgentSession` CLI or the managed CLI instead of sitting between both.

## 5. Custom adapters

For library consumers, custom adapters technically already work:

```ts
await AgentSession.create({
  adapter: {
    command: ["my-agent", "--acp"],
    ptyCommand: ["my-agent"],
    displayName: "My Agent",
  },
  adapterId: "my-agent",
});
```

The missing parts are mostly ergonomics and CLI support:

- The CLI only resolves keys from `ADAPTERS`.
- No adapter registry/resolver abstraction exists.
- Runtime validation is minimal.
- Restoration requires the consumer to resolve stored `adapterId` manually.
- Tests and documentation could be stronger.

A small public resolver shape would help both custom adapters and restoration:

```ts
type AdapterResolver =
  (adapterId: string) => Adapter | Promise<Adapter>;
```

Then the same resolver can power:

- `AgentSession.restore()`
- The managed CLI
- Custom adapters
- Consumer-defined adapter registries

## Suggested priority

1. Define the exact handoff semantics and identity invariants.
2. Harden `AgentSession` as the complete consumer-facing abstraction:
   `isBusy`, queue state, restoration, and no required `.connection` escape.
3. Complete advertised command discovery and execution.
4. Add/test custom adapter resolution.
5. Refactor the single-session REPL around `AgentSession`.
6. Build the opinionated managed CLI later.

The most important thing missing from your list is restoration and state observability. Creation and transcript persistence already exist; confidently reconstructing and supervising an `AgentSession` is what an orchestration consumer currently cannot do cleanly.










# handoff

Yes. I agree with you, and my earlier suggestion treated `AgentSession` too much like a fixed provider conversation.

The stable `agentSessionId` is precisely a virtualization layer:

```text
Consumer’s stable handle
        AgentSession A
        agentSessionId = A     ← never changes
               │
               ├── internalSessionId = provider-thread-1
               │
          handoff boundary
               │
               └── internalSessionId = provider-thread-2
```

The consumer keeps the same object, subscriptions, transcript location, queue, and logical identity. Only the backing provider thread changes.

The repository already hints at this intended design. `SessionRecord.internalSessionId` is documented as mutable so a portable conversation can span multiple agent sessions, and `setMode()` already changes the internal session while preserving `agentSessionId`. Handoff is a natural extension of that model.

## Where handoff belongs

Handoff belongs on `AgentSession`:

```ts
const before = session.agentSessionId;

await session.handoff();

session.agentSessionId === before; // always true
session.internalSessionId !== oldInternalSessionId;
```

It should not primarily be a `SessionManager` operation:

- `AgentSession` owns the live queue and controller.
- It can ensure no prompt overlaps the transition.
- It owns the transcript.
- It knows the current internal session.
- It can create and seed the replacement thread.
- It already persists its state through the attached manager.

`SessionManager` records the result, but it does not perform the live handoff.

## Handoff semantics

A default handoff would be:

```text
1. Reach a turn boundary.
2. Ask the current agent for a handoff summary.
3. Start a fresh internal ACP session.
4. Seed it with the summary and continuation instructions.
5. Replace AgentSession’s internal backing session.
6. Persist the new internalSessionId.
7. Continue accepting prompts through the same AgentSession.
```

Conceptually:

```ts
interface HandoffResult {
  agentSessionId: string;
  previousInternalSessionId: string | null;
  internalSessionId: string;
  summary: string;
}

const result = await session.handoff();
```

This is fundamentally different from compacting:

- `compact` modifies or compresses the current provider thread.
- `handoff` creates a new provider thread.
- `compact` is generally harness-specific.
- `handoff` can be a provider-independent library operation.
- The stable logical `AgentSession` survives a handoff.

So I agree: no generic `compact()` is required. Harnesses can expose that through `executeAgentCommand("compact")`.

## The important implementation constraints

### Handoff must participate in the operation queue

A handoff cannot race with prompts:

```text
prompt A running
handoff requested
prompt B requested
```

The correct order should be:

```text
prompt A → handoff → prompt B on the new internal session
```

This suggests changing the current prompt-only queue into an `AgentSession` operation queue:

```ts
type SessionOperation =
  | { kind: "prompt"; ... }
  | { kind: "handoff"; ... };
```

Calling `session.prompt()` from inside an already-queued handoff would deadlock, so summarization and seeding need internal turn methods rather than recursively entering the public queue.

### The swap should be transactional

If summarization or creation of the replacement thread fails, the old backing session should remain usable.

Ideal behavior:

```text
summarization fails       → remain on old session
new session fails         → remain on old session
seeding fails             → preferably remain on old session
commit succeeds           → switch internalSessionId and persist
```

The strongest implementation would create a replacement controller in parallel:

```text
old controller remains live
        │
        ├── produce summary
        │
new controller starts fresh thread
        ├── receives summary
        └── proves usable
                │
             commit
                │
AgentSession swaps controller
old controller stops
```

That is more robust than calling `currentController.newSession()` immediately, because after an in-place switch some agents may not support loading the old thread again for rollback.

It also prepares the architecture for a future cross-adapter handoff.

### Preserve logical history, not just the latest pointer

The catalog currently stores only the current `internalSessionId`. That is enough to restore the latest backing thread, but not enough to explain the lineage.

We should record handoff boundaries somewhere. The transcript is the natural minimum:

```json
{
  "t": "meta",
  "event": "handoff",
  "agentSessionId": "A",
  "fromInternalSessionId": "provider-thread-1",
  "toInternalSessionId": "provider-thread-2",
  "ts": 123
}
```

Eventually the catalog could retain segments:

```ts
interface SessionSegment {
  internalSessionId: string;
  adapterId: string;
  startedAt: string;
  endedAt?: string;
  reason?: "handoff" | "mode_change" | "reconnect";
}
```

That is not required for the first implementation, but we should avoid designing the record format as though only one internal session ever existed.

### “Consumer unaware” should mean identity-stable

The consumer should be unaware in the sense that it does not need to replace references or reconnect its UI:

```ts
const agent = orchestrator.getAgent(id);
await agent.handoff();
await agent.prompt("continue");
```

But handoff should remain observable for:

- Audit trails.
- Cost tracking.
- Debugging.
- UI status.
- Failure reporting.

So it should return a result and probably emit a state event, while preserving the stable handle.

### Summary strategy should be replaceable

The default can ask the current agent:

```ts
await session.handoff({
  instruction: "Summarize the work so another fresh thread can continue it.",
});
```

But an orchestrator may already have a transcript summarizer or want deterministic formatting. The API should permit:

```ts
await session.handoff({
  summary: precomputedSummary,
});
```

or:

```ts
await session.handoff({
  summarize: async (context) => mySummarizer(context),
});
```

That keeps handoff independent from a particular model or harness command.

## Same-adapter versus cross-adapter handoff

I would stage this:

### First version

Same adapter, fresh internal session:

```text
Codex thread 1 → summary → Codex thread 2
```

Stable:

- `agentSessionId`
- `adapterId`
- transcript
- object reference

Changed:

- `internalSessionId`
- live controller or backing connection

### Later version

Cross-adapter handoff:

```text
Codex thread → summary → Claude thread
```

Still preserve `agentSessionId`, but now `adapterId` also changes. This requires relaxing the current immutable-adapter design and recording adapter per segment.

The first version establishes the core invariant without forcing the larger adapter migration immediately.

## Effect on the smoke test

This makes `test5-operations` more valuable. Its central assertion should be:

```text
AgentSession identity survives backing-session replacement.
```

A deterministic, non-interactive fake harness is best initially. The test could exercise:

1. Create a `SessionManager`.
2. Create an `AgentSession`.
3. Record its `agentSessionId` and first `internalSessionId`.
4. Prompt once so advertised commands arrive.
5. Print and invoke a harmless advertised command.
6. Call `handoff()`.
7. Assert `agentSessionId` is unchanged.
8. Assert `internalSessionId` changed.
9. Prompt again and verify the new thread received the handoff context.
10. List the catalog and verify there is still one logical session, pointing at the new internal session.
11. Verify the transcript contains both sides and a handoff boundary.

That smoke test captures all three levels:

- `SessionManager`: one stable catalog entry.
- `AgentSession`: prompt, state, handoff.
- Harness: advertised command discovery and invocation.

It does not need to be interactive. Interactivity would mostly test readline and command parsing; this test should prove the consumer API and identity model. A separate live-agent mode can later verify that real Codex/Kimi/Claude accept the handoff sequence.

So yes: preserving `agentSessionId` across handoffs is not merely a convenience. It is one of the strongest architectural reasons for having `AgentSession` exist above the raw ACP session at all.




Yes. A handoff has two audiences:

- The caller that initiated it needs a result.
- Other observers of the stable `AgentSession` need a notification.

So the same payload can serve both:

```ts
const result = await session.handoff();

session.onNotification((notification) => {
  if (notification.kind === "handoff_completed") {
    // Update UI, metrics, audit view, etc.
  }
});
```

The library notifies the consumer; the consumer decides whether and how to notify the user.

## Session-level notifications

These should be separate from `ActivityEvent`.

`ActivityEvent` describes what the harness does during a prompt:

```text
thinking
tool call
plan
usage
agent command update
```

A handoff is a lifecycle event produced by `AgentSession` itself:

```ts
type AgentSessionNotification =
  | {
      kind: "handoff_started";
      handoffId: string;
      agentSessionId: string;
      fromInternalSessionId: string | null;
    }
  | {
      kind: "handoff_completed";
      handoffId: string;
      agentSessionId: string;
      fromInternalSessionId: string | null;
      toInternalSessionId: string;
      summary: string;
    }
  | {
      kind: "handoff_failed";
      handoffId: string;
      agentSessionId: string;
      fromInternalSessionId: string | null;
      error: string;
    };
```

Potential future notifications include:

```text
busy_changed
queue_changed
connection_changed
internal_session_changed
mode_changed
commands_changed
```

But I would start with handoff rather than designing a giant event union prematurely.

The result and completion notification should share one type:

```ts
interface HandoffResult {
  handoffId: string;
  agentSessionId: string;
  fromInternalSessionId: string | null;
  toInternalSessionId: string;
  summary: string;
}

type AgentSessionNotification =
  | { kind: "handoff_started"; ... }
  | ({ kind: "handoff_completed" } & HandoffResult)
  | { kind: "handoff_failed"; ... };
```

The initiating caller receives `HandoffResult`; subscribers receive `handoff_completed`.

## The transcript should span the handoff

The transcript belongs to the stable logical `AgentSession`, not to one internal provider thread. Therefore, it should remain the same file across handoffs:

```text
agentSessionId = logical-A
transcript     = logical-A.jsonl

provider-thread-1 messages
handoff boundary
provider-thread-2 messages
```

That is one of the main advantages of the stable identity.

The transcript should explicitly record the boundary:

```json
{
  "v": 1,
  "t": "handoff",
  "event": "completed",
  "handoffId": "handoff-123",
  "ts": 123456,
  "agentSessionId": "logical-A",
  "fromInternalSessionId": "provider-thread-1",
  "toInternalSessionId": "provider-thread-2",
  "summary": "The user is building...",
  "reason": "manual"
}
```

Then the logical transcript looks like:

```text
msg(user)
activity...
msg(assistant)

handoff(started)
handoff(completed, summary, old ID, new ID)

msg(user)
activity...
msg(assistant)
```

`readTranscript()` can continue returning only user/assistant messages. A richer reader using `readTranscriptLines()` sees the handoff boundary.

## Do not record the summarization machinery as ordinary chat

Suppose handoff asks the old agent:

```text
“Summarize this conversation for a replacement thread.”
```

That is an internal library operation, not necessarily something the user typed. If recorded as:

```text
msg(user): Summarize this conversation...
msg(assistant): Here is the summary...
```

then normal chat history becomes polluted with implementation details. It would also make a UI present the library’s synthetic instruction as though the user sent it.

Instead:

- Run the summarization turn internally.
- Record its output in the `handoff` line.
- Record its usage/status in the same handoff data.
- Do not add it to the normal `msg` projection.

For example:

```ts
interface TranscriptHandoffLine {
  v: 1;
  t: "handoff";
  event: "started" | "completed" | "failed";
  handoffId: string;
  ts: number;

  fromInternalSessionId: string | null;
  toInternalSessionId?: string;

  summary?: string;
  summaryUsage?: Usage | null;
  seedUsage?: Usage | null;

  error?: string;
}
```

The same applies to seeding the replacement thread. The synthetic prompt containing the summary should not appear as a normal user message. It is represented by the handoff record.

## The summary should be persisted

The handoff summary is not merely a display artifact. It is the exact context boundary between the two internal sessions.

Persisting it gives us:

- An audit of what context was transferred.
- A way to explain why the new thread behaved differently.
- The ability to reconstruct the logical conversation.
- A future route to retry a failed seed.
- Evidence that information was lost or distorted during summarization.

The transcript already contains sensitive conversation content, so the summary does not introduce a fundamentally new sensitivity class. It should still obey any transcript truncation or redaction policy.

## Started, completed, and failed records

Because the transcript is append-only, I would record handoff lifecycle explicitly:

```json
{"t":"handoff","event":"started","handoffId":"h1", ...}
{"t":"handoff","event":"completed","handoffId":"h1", ...}
```

or:

```json
{"t":"handoff","event":"started","handoffId":"h1", ...}
{"t":"handoff","event":"failed","handoffId":"h1","error":"...", ...}
```

This lets a reader distinguish:

- No handoff occurred.
- A handoff was attempted and failed.
- The process crashed during a handoff.
- The handoff completed successfully.

The old internal session remains authoritative unless a `completed` line was written and the new routing record was persisted.

## Commit ordering

To keep the catalog and transcript consistent:

```text
1. Write handoff_started.
2. Produce summary.
3. Create and seed replacement session.
4. Update AgentSession’s live backing.
5. Persist the new internalSessionId in SessionManager.
6. Write handoff_completed.
7. Emit handoff_completed notification.
8. Resolve handoff() with HandoffResult.
```

If something fails before the commit:

```text
1. Keep or restore the old backing session.
2. Write handoff_failed.
3. Emit handoff_failed.
4. Reject handoff().
```

There is a small crash-consistency question between steps 5 and 6. The catalog points to the current live backing, so it should be persisted first. If the process dies before the completion transcript line, restoration still goes to the correct internal session; the transcript can identify it as an interrupted finalization rather than route back to the old thread.

## Stable event identity

A `handoffId` matters because:

- Started and completed transcript entries correlate.
- Notifications correlate with persisted records.
- A UI can show one progress item.
- Retries can be distinguished.
- Multiple historical handoffs can be reconstructed.

The invariant becomes:

```text
agentSessionId: stable logical identity
handoffId: identity of one transition
internalSessionId: current physical/provider backing
```

That is a strong model. It turns the transcript from “messages emitted by one harness thread” into what it should be at the `AgentSession` level: the durable history of one logical conversation, including transitions between its underlying threads.
















# Plan


Here is the proposed implementation plan. We’ll treat each part as a review checkpoint before moving to the next.

## Guiding invariants

These should be pinned by the first smoke test:

- `agentSessionId` never changes during an `AgentSession`’s lifetime.
- `internalSessionId` may change after restore, mode switch, or handoff.
- Consumers retain the same `AgentSession` reference through a handoff.
- The transcript belongs to the stable `AgentSession`, spanning internal sessions.
- Consumer operations are typed APIs; slash commands are optional UI bindings.
- Unknown slash commands never silently reach the harness.
- Session state is observable without polling tricks.
- Listener failures never break session operations.

## Part 1 — `test5-operations` as the executable contract

Create:

```text
smoke-tests/test5-operations/
  README.md
  operations-smoke.ts
```

It should be non-interactive and use a deterministic fake ACP harness by default. A real-agent mode can be added afterward.

The script acts like a small orchestration consumer:

```ts
const store = new FileSessionStore(tempCatalog);
const manager = new SessionManager(store);

const session = await AgentSession.create({
  agentSessionId: "stable-agent",
  adapter: fakeAdapter,
  adapterId: "fake",
  sessions: manager,
  transcriptDir,
});

const unsubscribe = session.subscribe(printNotification);
```

The completed scenario should demonstrate:

1. Create an `AgentSession`.
2. Observe its initial state.
3. Prompt it.
4. Observe busy/turn lifecycle notifications.
5. Read its advertised harness commands.
6. Execute an advertised harness command.
7. Perform a handoff.
8. Verify `agentSessionId` did not change.
9. Verify `internalSessionId` did change.
10. Verify handoff notifications.
11. Verify the catalog still contains one logical session for that identity.
12. Verify the transcript contains a handoff boundary.
13. Create a second logical `AgentSession`.
14. List both through `SessionManager`.
15. Stop and restore the first session from its catalog record.
16. Verify restoration retains its stable identity and current internal session.

The README should explain which of the three operational levels every action exercises.

The smoke script does not need to be interactive. Interactivity would mostly test readline and slash parsing; this test is intended to validate the consumer API.

Because some desired APIs do not exist yet, we should first write the scenario and fixture as the contract, then make each section executable as its implementation lands. We should not leave the repository with permanently uncompilable code between checkpoints; unit tests can be red within the active part, while committed checkpoints should typecheck.

Decision to settle here: whether the first handoff implementation supports only a fresh thread on the same adapter or also accepts a replacement adapter. The API should not preclude cross-adapter handoff.

Exit criterion: the desired consumer flow is explicit and agreed upon.

## Part 2 — Observable `AgentSession` state

Add an authoritative state snapshot:

```ts
type AgentSessionPhase =
  | "idle"
  | "prompting"
  | "handoff"
  | "stopped";

interface AgentSessionState {
  phase: AgentSessionPhase;
  isBusy: boolean;
  queuedOperationCount: number;
  agentSessionId: string;
  internalSessionId: string | null;
  adapterId: string;
  mode: AgentMode;
}
```

Expose:

```ts
session.state
session.isBusy
session.queuedOperationCount
```

I suggest:

```text
isBusy = an operation is actively executing
queuedOperationCount = operations waiting behind it
```

This avoids hiding queue state inside a single boolean.

Add subscription:

```ts
const unsubscribe = session.subscribe(listener);
```

A notification envelope should carry ordering information:

```ts
interface AgentSessionNotificationEnvelope<E> {
  seq: number;
  ts: number;
  agentSessionId: string;
  event: E;
}
```

Initial events:

```ts
type AgentSessionEvent =
  | { kind: "state_changed"; state: AgentSessionState }
  | { kind: "turn_started"; turnId: string }
  | { kind: "turn_completed"; turnId: string; result: PromptResult }
  | { kind: "turn_failed"; turnId: string; error: string };
```

Rules:

- Mutate state before notifying.
- Notification order is stable.
- Sequence numbers never restart during the object’s lifetime.
- Listener exceptions are isolated.
- `turn_completed` is emitted even if another prompt remains queued.
- State does not briefly report idle between adjacent queued operations.
- Late subscribers read `session.state`, then listen for later events.

This part should also generalize the prompt-only queue into an operation queue capable of carrying handoff later.

Exit criterion: a consumer can react precisely to busy, completion, failure, and queue changes.

## Part 3 — Harness command API

Harden discovery:

```ts
interface AgentCommand {
  name: string;
  description: string;
  input?: {
    kind: "unstructured";
    hint: string;
  };
}
```

Required changes:

- Preserve ACP input metadata.
- Validate malformed entries.
- Return immutable snapshots.
- Reset commands consistently across internal-session changes.
- Filter updates by current internal session.
- Surface changes through `AgentSession` notifications.

Add:

```ts
session.getAgentCommands();
// or immutable session.agentCommands

session.executeAgentCommand(
  name,
  input?,
  handlers?,
): Promise<PromptResult>;
```

Invocation remains a normal ACP prompt internally:

```text
executeAgentCommand("status")       → "/status"
executeAgentCommand("foo", "a b")   → "/foo a b"
```

But the typed method preserves intent and gives us a stable future extension point.

Add an event:

```ts
{ kind: "agent_commands_changed"; commands: AgentCommand[] }
```

The method should allow explicit execution before discovery when requested, because some agents advertise commands only after the first turn. It can optionally report whether the command was advertised.

Exit criterion: consumers can observe, render, and invoke harness commands without implementing slash serialization.

## Part 4 — Stable-identity handoff

Add:

```ts
session.handoff(options?): Promise<HandoffResult>;
```

Possible options:

```ts
interface HandoffOptions {
  summary?: string;
  summarize?: (context: HandoffContext) => Promise<string>;
  instruction?: string;

  // Depending on the Part 1 decision:
  target?: {
    adapter: Adapter;
    adapterId: string;
  };
}
```

Default behavior:

1. Enter the session operation queue.
2. Emit `handoff_started`.
3. Produce or accept the summary.
4. Create a replacement internal session/controller.
5. Seed the replacement with the summary.
6. Commit the backing-session swap.
7. Persist the new routing.
8. Append the completed handoff transcript record.
9. Emit `handoff_completed`.
10. Resolve with `HandoffResult`.

On failure:

- Preserve the old backing session where possible.
- Append `handoff_failed`.
- Emit `handoff_failed`.
- Reject `handoff()`.

Events:

```ts
type HandoffResult = {
  handoffId: string;
  agentSessionId: string;
  fromInternalSessionId: string | null;
  toInternalSessionId: string;
  summary: string;
};

type HandoffEvent =
  | {
      kind: "handoff_started";
      handoffId: string;
      fromInternalSessionId: string | null;
    }
  | ({ kind: "handoff_completed" } & HandoffResult)
  | {
      kind: "handoff_failed";
      handoffId: string;
      fromInternalSessionId: string | null;
      error: string;
    };
```

Prompt ordering must be guaranteed:

```text
prompt A → handoff → prompt B
```

A prompt submitted while handoff is running waits and executes against the new backing session.

Exit criterion: stable object, stable `agentSessionId`, changed `internalSessionId`, preserved transcript and listeners.

## Part 5 — Handoff transcript contract

Add a dedicated line type:

```ts
interface TranscriptHandoffLine {
  v: 1;
  t: "handoff";
  event: "started" | "completed" | "failed";
  handoffId: string;
  ts: number;

  fromInternalSessionId: string | null;
  toInternalSessionId?: string;

  summary?: string;
  summaryUsage?: Usage | null;
  seedUsage?: Usage | null;
  error?: string;
}
```

Rules:

- Synthetic summarization prompts do not appear as normal user messages.
- Synthetic seed prompts do not appear as normal user messages.
- `readTranscript()` continues returning only the chat projection.
- `readTranscriptLines()` includes handoff boundaries.
- The same transcript path is used before and after handoff.
- A started event without completed/failed means the process died during handoff.
- Summary truncation/redaction follows transcript policy.

Add transcript tests for:

- Successful handoff.
- Failed handoff.
- Message projection unaffected.
- Handoff between two normal turns.
- Restoration after a completed handoff.

This may be implemented together with Part 4, but reviewed as a separate data-contract decision.

## Part 6 — Consumer lifecycle and restoration

Keep `SessionManager` as a catalog:

```ts
manager.record()
manager.get()
manager.list()
manager.delete()
manager.listMerged()
```

Avoid turning it into a runtime orchestrator.

Add a convenient restoration path:

```ts
const session = await AgentSession.restore({
  agentSessionId,
  sessions: manager,
  resolveAdapter,
  transcriptDir,
  // shared runtime configuration
});
```

Introduce:

```ts
type AdapterResolver =
  (adapterId: string) => Adapter | Promise<Adapter>;
```

Restoration should:

1. Read the catalog record.
2. Resolve its current adapter.
3. Restore mode, cwd, title, and internal session ID.
4. Reuse the stable `agentSessionId`.
5. Reopen the same transcript.
6. Persist only after successful startup.

Clarify lifecycle terminology:

```text
create  → new logical AgentSession
restore → rebuild logical AgentSession from our catalog
load    → low-level ACP mechanism used during restoration
```

Exit criterion: consumers can create, list, stop, and later restore sessions without manually copying routing fields.

## Part 7 — Custom adapters

Raw adapters already work for direct construction:

```ts
{
  command: ["my-agent", "--acp"],
  ptyCommand: ["my-agent"],
  displayName: "My Agent",
}
```

This pass should add:

- Adapter validation with useful errors.
- Resolver-based restoration.
- Tests using the fake adapter from `test5`.
- Documentation for consumer-defined registries.
- No requirement to mutate the built-in `ADAPTERS` object.

Potential helper:

```ts
defineAdapter({
  command: [...],
  ptyCommand: [...],
  displayName: "...",
});
```

This helper is optional if validation during session creation is sufficient.

Exit criterion: a custom adapter can be created, persisted by ID, and restored through a consumer resolver.

## Part 8 — Single-AgentSession REPL review

Add or reshape:

```ts
runAgentSessionRepl(session, options);
```

It should compose:

- Prompt input.
- Rendering and interruption.
- Standard per-session operations.
- Harness command discovery/execution.
- Consumer-defined command handlers.

Review current commands:

```text
Keep session-scoped:
  /bridge
  /config
  /caps
  /login
  /degrade
  /upgrade
  /handoff

Move out of the single-session layer:
  /new
  /sessions
  /load
  /resume
  /switch
```

Unknown slash commands must produce a local unknown-command result. `//name` can remain forced harness invocation.

The current low-level `runRepl()` can remain available.

Exit criterion: an orchestration consumer can temporarily attach a REPL to any existing `AgentSession` without surrendering lifecycle ownership.

## Part 9 — Documentation and managed CLI boundary

Document the three operational scopes:

```text
Consumer-managed AgentSessions
Selected AgentSession operations
Harness-advertised commands
```

Update examples for:

- Creating with an arbitrary transcript location.
- Listening to state changes.
- Rendering busy/finished state.
- Executing harness commands.
- Handoff with stable identity.
- Restoring through an adapter resolver.
- Attaching the single-session REPL.

The opinionated multi-session managed CLI remains a later layer. We can sketch it, but it should not block the consumer APIs.

## Explicitly out of scope

- A generic `compact()` method.
- A required workspace/orchestrator wrapper.
- Agent coupling policy.
- A production multi-session managed CLI.
- Provider-specific slash commands promoted into core methods.
- Replacing the consumer’s own UI/session selection model.

The first concrete part is therefore `test5-operations`: README, deterministic fake harness, and the consumer scenario that pins stable identity, notifications, command discovery, handoff, catalog behavior, and restoration.