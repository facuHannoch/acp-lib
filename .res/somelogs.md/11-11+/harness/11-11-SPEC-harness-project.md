# Native harness: project organization and rules

Status: agreed, not started; repo layout decided 2026-11-12 (below). Written
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
| Permission gate | Interface | Allow, deny or ask under the turn's policy (one permission setting, rules by pattern); timeout | Allow-all; policy engine |
| Event sources | Interface | Feed inbox items into channels | Host pushes |
| Guards | Interface | Veto a call or a turn | Call limit; unattended turns |
| Lifecycle events | Event bus | Before and after turn, call, tool, compaction; deltas | Console; CLI call log |
| Function registry | Registry by name | Implements `run.type: "function"` tools | `registerFunction` |
| Delegation backend | Interface | Open, message, check, stop, list delegated agents | Remote (host callbacks; acp-client serves them with its orchestrator). Native subagents later |
| History sources | Registry | Search and read past conversations | Own channels; remote (host callbacks; acp-client serves its records) |
| Execution port | Interface | Prepare every process the harness starts (`command` tools, stdio MCP servers) | Local spawn; prefix |

Rules for every extension point:

- **One folder, one contract file, one conformance suite.** An implementation is accepted when it passes the suite.
- **Composable, not exclusive.** Chains and pipelines take several implementations in order; registries take many.
- **Channel-aware, not channel-owning.** No hidden per-channel state outside the store.
- **Failures are values.** Typed errors the kernel turns into tool results or outcomes; exceptions are bugs.

## Layout

**Decided (owner, 2026-11-12): `src/native-harness/` inside the acp-client repo, acting as a separate package from
the start.** It will probably be split out later, as its own package that acp-client depends on, or as a binary; the
boundary is kept from the first commit so that split is a move, not an untangling. What "acting as a separate
package" means:

- **Its own entry points** play the role of package exports: `index.ts` (public API), `client.ts` (what hosts
  import: `HarnessClient`, transports, `describe`), `testing.ts` (scripted model, conformance suites); later
  `openai-compatible.ts`, `mcp.ts`, `mcp-server.ts`. Nothing outside `src/native-harness/` imports anything else from
  it.
- **It never imports from outside itself:** no `../` out of `src/native-harness/`, no acp-client modules.
- **Its own dependencies are listed** (in its `README`/`ARCHITECTURE.md` until it has a `package.json`), so the split
  knows what to carry.
- **Its own tests** under `src/native-harness/test/` (or `test/native-harness/`), runnable on their own.
- **The `harness` binary** is a script entry (`src/native-harness/cli/main.ts`), runnable with `bun`.
- **Enforced by tooling,** not by convention (Dependency rules, below).

The protocol between a host and the harness is its own spec: `../11-12-SPEC-harness-protocol.md`.

```
src/native-harness/
  index.ts                  public API only
  client.ts                 for hosts: HarnessClient, stdio and in-process transports, describe()
  testing.ts                scripted model, golden helpers, conformance suites
  AGENTS.md                 contribution rules (below)
  ARCHITECTURE.md           the pattern and the rules, next to the code
  decisions/                0001-contracts.md, ...
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
    cli/                    the `harness` binary (main.ts)
    testing/                scripted-client.ts, golden.ts, conformance/
  test/
    scenarios/              whole turns with the scripted client
    golden/                 expected requests
```

- Separate entry points keep heavy dependencies optional (the MCP SDK loads only for consumers who use it).
- `client.ts` is what hosts import: the `HarnessClient` with process and in-process transports. A host never imports
  `kernel/` or any module internals, so running the harness in process or in another environment is a transport
  choice.
- Conformance suites are exported through `testing.ts`, so the library's implementations (its history source,
  delegation backend) run the same suites.

## Dependency rules

Enforced by tooling (dependency-cruiser or eslint-plugin-boundaries):

1. `contracts` imports nothing.
2. `kernel` imports only `contracts`.
3. Every other folder imports `contracts`, never another folder's internals; shared helpers go to a small `util` that
   imports only `contracts`.
4. Nothing in `src/native-harness/` imports from outside it; the rest of acp-client imports only its entry points
   (`index.ts`, `client.ts`, `testing.ts`), and within acp-client only `src/native/` does.
5. Checked in CI by a small import check (a script over the import graph, or dependency-cruiser), so a violation
   fails the build.
6. Size limits: a file over about 400 lines or a module over about 2,000 needs a reason in review.

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

- [ ] Package name for when it is split out; published or private.
- [ ] Exact size limits and which tool enforces the dependency rules.
- [ ] Decision record format and numbering.
