# Native harness architecture

The [architecture documentation](.res/architecture/README.md) maps the current
implementation and the proposed persistence increments. This document remains
the target layout and dependency guide; proposals in that documentation are not
implemented guarantees.

Status: target architecture, implemented incrementally. An initial in-memory
agent with channel queues, terminal clients and a tool loop exists; current
behavior is described in [README.md](README.md).
Existing modules follow the grouped layout below; future folders are created
only as their implementation begins.
An experimental protocol subset and typed client now reuse the same
session assembly as development startup. Execution runs on the session storage
contract with memory and SQLite adapters; the README lists supported operations
and differences from the full protocol spec.
Both in-process and newline-delimited stdio transports are implemented. Stdio
adds no listeners or execution features; the host retains process ownership.
The detailed
[project spec](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-project.md)
and [v1 spec](../../.res/somelogs.md/11-11+/harness/11-11-SPEC-harness-v1.md)
define the broader work.

## Entity and execution model

A session is one agent entity: configuration, system prompt, policies, timeline,
shared state and channels. Two sessions are separate entities. One process opens
and locks one session; its channels can run concurrently.

A channel is one conversation with a derived context view and its own inbox. Each channel is a
sequential actor. The inner loop calls the model, executes requested tools and
appends their results until the model answers without tools and no notices remain.
Explicit notices are accepted into a busy turn's inbox or start a new turn when
the channel is idle or has closed admission. The final inbox check and admission
close are synchronous; notices are drained before inference after any tool results.
Ordinary shared events alone do not trigger continuation. The outer loop
starts turns on inbox events, including messages and consumer-supplied events. Steering
items join a running turn at its next context-building boundary.

The turn state machine is pure:
`idle → building → calling → running_tools → building → … → idle`, with an
interrupting path. A separate runner performs I/O through contracts.

## Small kernel, explicit contracts

The kernel coordinates extension points, pairs tool results with calls, saves
progress, emits lifecycle events and honors abort signals. Rendering, provider
formats, retries, permission rules, compaction and specific tools belong outside
it. Judgment goes to inference; policy goes to code.

Completed assistant text is a message event independent of turn completion. A
notice that extends a turn does not suppress an already produced answer. The
current loop emits messages and tool activity through contracts; the scheduler
emits turn lifecycle events. Hosts and protocol adapters subscribe outside the
kernel. `src/index.ts` assembles sessions without starting servers or reading input.

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

The current foundation uses one agent-owned append-only context store. Inputs,
responses and tool results carry channel, turn and sender attribution. Before
every inference a pure builder combines a fresh store snapshot with the system
prompt and current channel. Native tool exchanges stay together within the active
turn; other turns are rendered as attributed data. No channel's last snapshot
overwrites the shared record. Tool definitions remain separate request data.

This initial rendering includes all events and rebuilds the shared-history prefix;
scope filtering, context budgets, compaction and cache-friendly delivery remain
future work. The older spec's per-channel positions and digest delivery below are
a reference design, not implemented behavior or a final rendering decision.

The entity has a shared append-only timeline, with provenance and policy scope on
each event. Channels keep positions in it and receive scoped digests of what
happened elsewhere. Shared state is a projection of timeline events. Managed
member channels receive digests through a prepare/delivered receipt handshake.

The permission gate enforces rights on every tool execution, independently of
which definitions the model sees. Scope filtering limits incoming information;
v1 does not guarantee confidentiality of the text the model sends across channels.

## Intended layout

Create folders as their implementation begins. Related modules are grouped under
`src/`; groups organize files without introducing additional abstraction layers.
The kernel and feature modules remain separate from contracts. Grouping does not
relax the dependency boundaries below.

```text
src/native-harness/
  README.md, ARCHITECTURE.md, AGENTS.md
  package.json, bun.lock, tsconfig.json
  .res/decisions/         decision records, created when needed
  .res/sandbox/          learning experiments
  src/
    index.ts             public session API
    contracts/           neutral types and documented interfaces
    kernel/              session, channel, turn machine, runner, lifecycle
    capabilities/
      model/             clients, middleware chains, later profiles
      tools/             registry, middleware chains, providers
      context/           pipeline, renderers, compactors, context stores
    governance/
      permissions/       permission-gate adapters
      policy/            resolution, permission patterns, presets
      guards/            execution limits
    state/
      identity/          timeline, positions, digests, state, members
      history/           own-channel and remote history sources
      storage/           SQLite identity core, export/import bundles
    runtime/
      config/            schema, loading, versions
      events/            inbox event sources
      execution/         local and prefix execution adapters
      usage/             usage ledger by purpose
    interfaces/
      cli/               main.ts and CLI commands
      protocol/          JSON-RPC server/client and transports
      client.ts          HarnessClient, transports, pure describe(config)
    testing/             scripted client, golden helpers, conformance suites
  test/                  unit tests, scenarios, golden requests
```

Phase 2 adds memory consolidation and the members' MCP server. Dedicated optional
entry points such as `openai-compatible.ts` and `mcp.ts` keep heavy dependencies
out of the core import path.

## Instructions, tools and consumer configuration

Consumers configure the system prompt, tools and policy. Harness-owned
instructions live beside the capability that uses them, such as context
construction under `src/capabilities/context/`; there is no separate root
instructions module. Keep each native tool's definition and implementation
together in its owning capability. The tool registry exposes the selected
definitions and routes execution through contracts.

Entry points assemble configuration and implementations. Model adapters translate
tool definitions into the provider's native tools field; definitions do not need
to be duplicated in the system prompt. The kernel receives prepared inputs and
coordinates execution without owning prompt text or specific tools.

Coding workers and their orchestration belong to the consumer, initially
acp-client. The harness has no built-in delegation subsystem. A consumer can
expose workers through configured tools and describe their use in its system
prompt; the harness handles those through its ordinary tool and event contracts.

## Dependency boundaries

- `src/contracts/` imports nothing. `src/kernel/` imports only contracts.
- Feature modules depend on contracts, never another module's internals. Shared
  helpers may live in a small `util/` depending only on contracts. Composition is
  performed at entry points through the contracts.
- Harness code never imports acp-client modules outside this directory. External
  package dependencies belong at the appropriate adapter edge and are listed in
  the README.
- Production acp-client integration belongs in `src/native/` and imports only
  public harness entry points. Hosts use the client interface, never kernel internals.
- Dependency checks must be automated in CI as implementation begins; no such
  checker has been added yet. Files over about 400 lines or modules over about
  2,000 need a documented reason in review.

## Hosts, storage and verification

The harness owns its model calls, tools, credentials and storage. It runs standalone
or as `harness serve --stdio`, using its own versioned JSON-RPC protocol. Hosts use
the same API through stdio or in-process transports; configured host functions
and history sources can cross the process boundary as host callbacks.

V1 stores the identity core in SQLite through `bun:sqlite`; channel contexts are
in memory with optional JSONL snapshots. Export/import moves the whole entity.
Continuous backup and waking stopped processes for background work are deferred.

Offline scripted scenarios verify turns, steering, interruption, limits and
compaction. Conformance suites check each adapter. Golden files check neutral
requests and provider JSON. Live model evals are separate and opt-in; tests need
no provider credentials. Both transports must pass the same scenarios.

Build working behavior incrementally rather than completing modules one by one.
Each increment introduces only the contracts and implementations it needs, with
appropriate offline checks. Contract decisions precede dependent implementations;
bounded feature work can be delegated once its direction and contracts are clear.
Use the detailed specs later to check gaps and complete the intended system.
