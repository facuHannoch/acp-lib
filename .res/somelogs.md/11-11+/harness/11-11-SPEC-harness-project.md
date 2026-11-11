# Native harness: project organization and rules

Status: agreed, not started; the repo layout waits on the owner's decision (overview, open questions). Written
2026-11-11. Seeds the package's `ARCHITECTURE.md` and `AGENTS.md`. What it builds is `11-11-SPEC-harness-v1.md`.

## Why this needs its own rules

The harness is meant to grow deep in several directions at once (context, tools, providers, compaction, memory) and
to be worked on by several agents in parallel. The lesson of `src/agent-session.ts` (5,022 lines) is that a central
object without boundaries absorbs everything. So the project starts with a small kernel and every feature behind a
contract, from the first commit.

## Principles

1. **A small kernel.** It runs the loop and coordinates; no feature logic. Needing to edit the kernel to add a feature
   means an extension point is missing.
2. **Every feature behind an extension point** with a documented contract.
3. **Contracts first.** A contract is an interface, its documentation and a conformance suite every implementation
   must pass. Contracts change only through a decision record.
4. **One direction of dependency.** The library depends on the harness; the harness never imports the library.
5. **Testable without a provider key.** A scripted model client and golden request files make every behaviour
   testable offline.
6. **Neutral data, provider shapes at the edge.** Rendering into a provider's shape happens only inside the client.
7. **No god objects.** Size limits per file and module, enforced in review.
8. **Judgment goes to inference, policy goes to code.**

## The pattern

A **microkernel with ports and adapters**: the kernel coordinates, every feature plugs in through a contract, and
providers, storage and hosts sit behind adapters. Inside it:

- **A session is the entity; one actor per channel:** a mailbox processed one item at a time; channels in parallel.
- **An explicit turn state machine:** a pure transition function and a separate runner.
- **A functional core for the context:** stages, renderers and compactors are pure; only stores, clients, providers
  and the runner do I/O.
- **Middleware chains only for model calls and tool calls;** **registries** for tools, renderers, providers.
- **An event-sourced store:** a channel's context is an append-only log; the context a projection; compaction an event.

## Extension points

| Extension point | Pattern | Contract in one line | v1 implementations |
| --- | --- | --- | --- |
| `ModelClient` | Interface | Neutral request in, neutral events out; abortable | Scripted fake; OpenAI-compatible |
| Model profiles | Data + adapters | Per-family adjustments inside the client | None |
| Context pipeline | Ordered stages | Channel view in, next view out; the last produces the request | Layers, inbox rendering, sender tags, placement, cache order |
| Renderers | Registry by item kind | Inbox item → neutral messages | Tagged blocks |
| Compactors | Strategy | Channel context over budget → smaller context + marker | Clear tool results; summarize turns |
| `ContextStore` | Interface | Load, append, replace after compaction, export, import; versioned | In-memory; JSONL |
| Tool providers | Registry | List definitions under the turn's policy; execute; may change | Configured; MCP; delegation and messaging |
| Tool chain | Middleware | Validation, permission gate, timeout, truncation, usage | All five |
| Model chain | Middleware | Retries, rate limits, logging | Retries; call log |
| Permission gate | Interface | Allow, deny or ask under the policy of the turn's triggering items; timeout | Allow-all; policy engine |
| Event sources | Interface | Feed inbox items into channels | Host pushes |
| Guards | Interface | Veto a call or a turn | Call limit; unattended turns |
| Lifecycle events | Event bus | Before and after turn, call, tool, compaction; deltas | Console; CLI call log |
| Function registry | Registry by name | Implements `run.type: "function"` tools | `registerFunction` |
| Delegation backend | Interface | Open, message, check, stop delegated agents | Native subagents; the library's orchestrator |
| History sources | Registry | Search and read past conversations | Own channels; the library's records |

Rules for every extension point:

- **One folder, one contract file, one conformance suite.** An implementation is accepted when it passes the suite.
- **Composable, not exclusive.** Chains and pipelines take several implementations in order; registries take many.
- **Channel-aware, not channel-owning.** No hidden per-channel state outside the store.
- **Failures are values.** Typed errors the kernel turns into tool results or outcomes; exceptions are bugs.

## Layout

One workspace package organized by module, with subpath exports for optional heavy parts. A module becomes its own
package only when it needs its own release cycle or dependencies. The fallback, if the repo stays one package, is
`src/native-harness/` with the same layout and the same enforced rules.

```
packages/native-harness/
  package.json              exports: ".", "./client", "./openai-compatible", "./mcp", "./mcp-server", "./testing"
  AGENTS.md                 contribution rules (below)
  ARCHITECTURE.md           the pattern and the rules, next to the code
  decisions/                0001-contracts.md, ...
  src/
    contracts/              imports nothing: entries, inbox, model, context, tools, permissions, guards,
                            events, config, policy, timeline, delegation, history, errors
    kernel/                 session.ts (entity, lock), channel.ts (actor), turn-machine.ts (pure), turn-runner.ts, lifecycle.ts
    context/                pipeline/, renderers/, compactors/, store/          (pure, except store/)
    model/                  chain/, profiles/, clients/openai-compatible/ (render.ts, parse.ts, client.ts)
    tools/                  registry.ts, chain/, providers/configured/, providers/mcp/, providers/own/
    permissions/            allow-all.ts
    policy/                 the policy engine
    guards/                 call-limit.ts, unattended-turns.ts
    events/                 event sources (reminders later)
    config/                 schema, loading, versions
    identity/               timeline, positions, digests, shared-state projection
    delegation/             remote (forwards to host callbacks); native subagents later
    history/                own-channels source; remote (host callbacks)
    usage/                  usage ledger by purpose
    execution/              the execution port: local spawn, prefix
    protocol/               JSON-RPC messages, server (`harness serve`), client, stdio and in-process transports
    storage/                SQLite for the identity core, JSONL snapshots
    memory/                 phase 2
    mcp-server/             phase 2
    cli/                    the `harness` binary
    testing/                scripted-client.ts, golden.ts, conformance/
    index.ts                public API only
  test/
    scenarios/              whole turns with the scripted client
    golden/                 expected requests
```

- Subpath exports keep heavy dependencies optional (the MCP SDK loads only for consumers who use it).
- `./client` is what hosts import: the `HarnessClient` with process and in-process transports. A host never imports
  `kernel/` or any module internals, so running the harness in process or in another environment is a transport
  choice.
- Conformance suites are exported through `./testing`, so the library's implementations (its history source,
  delegation backend) run the same suites.

## Dependency rules

Enforced by tooling (dependency-cruiser or eslint-plugin-boundaries):

1. `contracts` imports nothing.
2. `kernel` imports only `contracts`.
3. Every other folder imports `contracts`, never another folder's internals; shared helpers go to a small `util` that
   imports only `contracts`.
4. Nothing in the package imports from the library; the library imports only public entry points.
5. Size limits: a file over about 400 lines or a module over about 2,000 needs a reason in review.

## Testing

| Layer | What it checks | How |
| --- | --- | --- |
| Unit | One stage, renderer, compactor, middleware, provider | Plain tests on the contract types |
| Conformance | Every implementation behaves as its contract says | One shared suite per extension point |
| Kernel scenarios | Whole turns: tool loops, steering, interruption, compaction, limits, errors | The scripted client returns predefined answers and records each request |
| Golden requests | The exact neutral request (and per client, provider JSON) for a scenario | Stored files compared on each run; a context change is a reviewable diff |
| Live evals | Behaviour with real models | The eval suites (harness design spec), on demand with a key |

- Every change to the pipeline, a renderer or a compactor updates golden files in the same change.
- Every bug found in a live run gets a scripted scenario that reproduces it before the fix.
- Tests never call a real provider; live evals are a separate command.
- Changing a conformance suite is a contract change.

## Contribution rules (`AGENTS.md`)

**Scope of a change**

- A change touches one extension point, or the kernel, never both. A feature that needs both is split: the contract
  change with its decision record first, then the implementation.
- No feature logic in the kernel; no imports across modules except through `contracts`; nothing from the library.

**Adding something**

- A new provider, compactor, renderer, stage, middleware, guard or client: in its module's folder, registered,
  passing that extension point's conformance suite.
- A new inbox item kind: its renderer and a golden scenario in the same change.
- A new model client: the `ModelClient` suite plus golden provider JSON.

**Contracts and decisions**

- Changing `contracts/` or a conformance suite needs a decision record in `decisions/`: the problem, the options, the
  choice, what breaks; under a page.
- Contract changes land alone, before the work that uses them.

**Quality bar**

- Tests as above; size limits; typed errors; every public type and extension point has a doc comment saying what it
  guarantees, not how.

**Working in parallel**

- Each workstream owns its folders; two workstreams never edit the same module at once.
- A pending contract change blocks work that depends on it.
- Hand-offs state the extension point, the contract version and the conformance status.

## Build order

**Sequential foundation**

1. `contracts/`: every type and interface with doc comments, reviewed as a whole.
2. Conformance suite skeletons.
3. `kernel/` with the scripted client, an in-memory store, an empty pipeline and registry: whole turns offline.
4. The golden-request harness.

**Parallel workstreams**

| Workstream | Owns | First milestone |
| --- | --- | --- |
| Provider | `model/` | `ModelClient` conformance; usage events; retries; call log |
| Context | `context/pipeline`, `context/renderers` | Layers, tagged inbox rendering, sender tags, placement, cache order |
| Compaction | `context/compactors` | Clear tool results; summarize with a marker |
| Store | `context/store` | JSONL snapshots; export and import |
| Tools | `tools/` | Configured tools; validation errors fed back; truncation |
| MCP | `tools/providers/mcp` | stdio and HTTP through the official SDK |
| Safety | `permissions/`, `guards/` | Gate with ask and timeout; call limit; unattended turns |
| Config and CLI | `config/`, `cli/` | Schema, versions, `harness chat` |
| Policy | `policy/` | Capabilities, tool patterns, presets, most-restrictive resolution |
| Identity | `identity/`, `storage/` | Timeline, positions, stitched digests, shared state, SQLite |
| Delegation | `delegation/` | Backend contract; remote backend over callbacks |
| Protocol | `protocol/`, `execution/` | Server and client over stdio and in process; the execution port |
| Member channels (phase 2) | `mcp-server/` | Scoped endpoints, delivery handshake |

**Integration** happens in the library (`../library/11-11-SPEC-native-harness-integration.md`) after the provider,
context and tools workstreams.

## Open

- [ ] Workspace package or a folder with a lint-enforced boundary (overview).
- [ ] Package name; published from the start or private until stable.
- [ ] Exact size limits and which tool enforces the dependency rules.
- [ ] Decision record format and numbering.
