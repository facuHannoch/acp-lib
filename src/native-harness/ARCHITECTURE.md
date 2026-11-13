# Native harness architecture

Status: agreed target architecture; implementation has not started. The initial
learning milestone is described in [README.md](README.md). The detailed
[project spec](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-project.md)
and [v1 spec](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-v1.md)
define the broader work.

## Entity and execution model

A session is one agent entity: configuration, system prompt, policies, timeline,
shared state and channels. Two sessions are separate entities. One process opens
and locks one session; its channels can run concurrently.

A channel is one conversation with its own context and inbox. Each channel is a
sequential actor. The inner loop calls the model, executes requested tools and
appends their results until the model answers without tools. The outer loop
starts turns on inbox events, including messages and worker replies. Steering
items join a running turn at its next context-building boundary.

The turn state machine is pure:
`idle → building → calling → running_tools → building → … → idle`, with an
interrupting path. A separate runner performs I/O through contracts.

## Small kernel, explicit contracts

The kernel coordinates extension points, pairs tool results with calls, saves
progress, emits lifecycle events and honors abort signals. Rendering, provider
formats, retries, permission rules, compaction and specific tools belong outside
it. Judgment goes to inference; policy goes to code.

| Extension point | Responsibility |
| --- | --- |
| Model client | Neutral requests in, neutral streaming events out; abortable |
| Model chain | Retries and model-call logging |
| Context pipeline | Ordered pure stages producing the next request |
| Renderers | Inbox items to neutral messages, registered by kind |
| Compactors | Reduce context with an explicit compaction marker |
| Context store | Versioned context log, load, append, compaction, export and import |
| Tool providers and registry | List definitions and execute configured, MCP and own tools |
| Tool chain | Validation, permission gate, timeout, truncation and usage |
| Permission gate and policy engine | Resolve rights and allow, deny or ask for each call |
| Guards | Limit calls, unattended turns and usage |
| Event sources and lifecycle events | Feed inboxes and report execution |
| Function registry | Host implementations of configured function tools |
| Delegation backend | Open, message, check, stop and list workers |
| History sources | Search and read past conversations |
| Execution port | Prepare every command-tool and stdio MCP process |

Each extension point has a documented contract and a conformance suite.
Implementations compose through chains, pipelines and registries. Keep durable
per-channel state in the store, with the actor holding its working state; adapters
must not own hidden channel state. Expected failures are typed values, converted
into tool results or turn outcomes.

## Context and identity

Requests use provider-neutral data; provider rendering and parsing stay at the
model-client edge. Preserve opaque reasoning data unchanged for the same provider.
The consumer's system prompt stays verbatim. Sender tags, digests and tool hints
are conversation content.

Append changing content at the end to preserve prefix caching. A channel's context
is an append-only event log; compaction is an event and the current context a
projection. V1 compaction clears old tool results, then summarizes old turns.

The entity has a shared append-only timeline, with provenance and policy scope on
each event. Channels keep positions in it and receive scoped digests of what
happened elsewhere. Shared state is a projection of timeline events. Managed
member channels receive digests through a prepare/delivered receipt handshake.

The permission gate enforces rights on every tool execution, independently of
which definitions the model sees. Scope filtering limits incoming information;
v1 does not guarantee confidentiality of the text the model sends across channels.

## Intended layout

Create folders as their implementation begins. All folders below are siblings;
`kernel/` and the feature modules are not nested inside `contracts/`.

```text
src/native-harness/
  README.md, ARCHITECTURE.md, AGENTS.md
  .res/decisions/         decision records, created when needed
  .res/sandbox/          learning experiments
  index.ts               public session API
  client.ts              HarnessClient, transports, pure describe(config)
  testing.ts             scripted model and conformance helpers
  contracts/             neutral types and documented interfaces
  kernel/                session, channel, turn machine, runner, lifecycle
  context/               pipeline, renderers, compactors, context stores
  model/                 clients, middleware chains, later profiles
  tools/                 registry, middleware chains, providers
  permissions/           permission-gate adapters
  policy/                resolution, permission patterns, presets
  guards/                execution limits
  events/                inbox event sources
  config/                schema, loading, versions
  identity/              timeline, positions, digests, state, members
  delegation/            remote host backend; native subagents later
  history/               own-channel and remote history sources
  usage/                 usage ledger by purpose
  execution/             local and prefix execution adapters
  protocol/              JSON-RPC server/client, stdio and in-process transports
  storage/               SQLite identity core, export/import bundles
  cli/                   main.ts and CLI commands
  testing/               scripted client, golden helpers, conformance suites
  test/                  unit tests, scenarios, golden requests
```

Phase 2 adds memory consolidation and the members' MCP server. Dedicated optional
entry points such as `openai-compatible.ts` and `mcp.ts` keep heavy dependencies
out of the core import path.

## Dependency boundaries

- `contracts/` imports nothing. `kernel/` imports only contracts.
- Feature modules depend on contracts, never another module's internals. Shared
  helpers may live in a small `util/` depending only on contracts. Composition is
  performed at entry points through the contracts.
- Harness code never imports acp-client modules outside this directory. External
  package dependencies belong at the appropriate adapter edge and are listed in
  the README.
- Production acp-client integration belongs in `src/native/` and imports only
  harness entry points. Hosts use `client.ts`, never kernel internals.
- Dependency checks must be automated in CI as implementation begins; no such
  checker has been added yet. Files over about 400 lines or modules over about
  2,000 need a documented reason in review.

## Hosts, storage and verification

The harness owns its model calls, tools, credentials and storage. It runs standalone
or as `harness serve --stdio`, using its own versioned JSON-RPC protocol. Hosts use
the same API through stdio or in-process transports; function implementations,
delegation and history cross the process boundary as host callbacks.

V1 stores the identity core in SQLite through `bun:sqlite`; channel contexts are
in memory with optional JSONL snapshots. Export/import moves the whole entity.
Continuous backup and waking stopped processes for background work are deferred.

Offline scripted scenarios verify turns, steering, interruption, limits and
compaction. Conformance suites check each adapter. Golden files check neutral
requests and provider JSON. Live model evals are separate and opt-in; tests need
no provider credentials. Both transports must pass the same scenarios.

The full foundation builds contracts, conformance skeletons, the kernel and golden
requests before independent feature work. The initial learning slice exercises
the basic loop first; it does not claim these broader milestones are complete.
