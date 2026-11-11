# Native harness in acp-client

Status: agreed, not started. Written 2026-11-11, grounded in code and updated with process isolation the same day.
Lines of work L4–L8 in `../11-11-NOTE-overview.md`. The harness seen from the library: what acp-client needs from it
and what changes in acp-client. How the harness works inside is `../harness/11-11-SPEC-harness-design.md` and
`../harness/11-11-SPEC-harness-v1.md`.

## Why the library needs a harness of its own

The 10-17 note (`../../9-22+/10-17-NOTE-model-call-controller.md`) proposed a controller that calls a model API with
no harness. It grew into a harness of our own, for reasons that show from acp-client's side:

- **Resources.** Every conversation owns a harness process (hundreds of MB). Many conversations, few processes is the
  pool (`11-11-SPEC-orchestrator.md`); the many conversations need a backend that isn't a process each.
- **One agent across conversations.** The checkpoint-backed identity (`src/identity/checkpoint-backed.ts`) copied raw
  messages from other conversations into a preamble (`maxContextChars` 32,000, `maxSourceChars` 8,000) and proved
  unreliable.
- **Control.** Through ACP the system prompt goes in as a first prompt, some models refuse it, and the harness's own
  prompt can override ours; context, compaction and tool descriptions aren't ours. With our own loop they are; the
  tuning harness prompts gave for free is ours to write.
- **Talking to work needs tools,** and a model calling tools in a loop is a harness. Building inside an existing
  harness is impossible (no API inside their loop).

Rejected: a plain HTTP controller with the model client as a library layer; the harness in acp-client's process (it
breaks isolation, below); speaking ACP (it has no agent-started turns, no injection into a running turn, no policy per
prompt, no non-prompt items, no member identity calls; the core of the design would live in extensions); one harness
per conversation.

## Isolation: the harness runs as its own process

Today an ACP conversation's whole harness runs as its own process started through the launcher (`src/launcher.ts`,
`AcpLauncher.prepare` → command, cwd, complete env): its loop, credentials, session files and every operation it
performs live in the agent's environment (a container, say), while acp-client may run elsewhere. The native harness
gives the same guarantee, from v1:

- **One harness process per `Agent`,** not per conversation: all the entity's native conversations are multiplexed
  over one connection.
- **Started through the launcher,** generalized from `AcpLauncher` to a `ProcessLauncher` (same `prepare` shape; the
  `kind` gains `"native-harness"`), so `docker exec`, cwd and env work unchanged; the default is the one conversations
  already use (`conversationDefaults.launcher`, `src/agent.ts:229`). `AcpLauncher` stays as an alias.
- **`harness serve --stdio`:** the harness's server mode. Its protocol is the harness's public API made
  serializable: JSON-RPC over stdio, defined and versioned by the harness, with the client exported by the harness
  package (`./client`). acp-client doesn't write protocol code; it launches the process and uses the client.
- **Everything the agent does runs there:** model calls (API keys in that environment), `http` and `command` tools,
  MCP servers, storage (the harness root, a volume in container setups).
- **Callbacks from the harness to the host,** like ACP's fs and terminal requests to the client: function tools, the
  delegation backend (the orchestrator stays in acp-client), history sources, and identity delivery for members.
- **In-process transport** exists too (same client interface), for tests and the standalone CLI; with acp-client the
  process is the default.
- **One process for many conversations** means a crash affects all of them: the controller restarts the process
  (bounded retries), each native conversation's running turn ends with an error, and the orchestrator's restart rules
  apply to workers it was running.

## What acp-client sees

```
AgentConversation ── AgentSession ── NativeController ── HarnessClient ══ stdio ══ harness serve
                                          │ translation only                   (agent's environment)
                                          └─ one NativeHarnessHost per Agent: launches, holds the client,
                                             serves callbacks (functions, delegation, history)
```

### Adapters

`Adapter` stays what it is: the `HarnessController`'s adapter, an external harness command
(`{ command, ptyCommand?, cancelGraceMs?, displayName? }`, `src/adapters.ts`; validated in
`src/agent-adapter-registry.ts`; exported and used by agents-core). The native adapter is a separate type:

```ts
interface NativeAdapter {
  kind: "native";
  harness: {
    root: string;                         // inside the agent's environment
    config: string | NativeHarnessConfig; // path or the JSON object
    command?: string[];                   // how to start `harness serve --stdio`; defaults to the package bin
  };
  launcher?: ProcessLauncher;             // else conversationDefaults.launcher
  displayName?: string;
}
type AgentAdapter = Adapter | NativeAdapter;   // what Agent configs take
```

`AgentConfig.adapters` takes `AgentAdapter`; the registry stores either and validates each with its own rules. A
conversation's controller is chosen by the adapter's type. Existing code passing `Adapter` keeps working unchanged.

### The `NativeController`

Implements the `ConversationController` interface (`11-11-SPEC-controller-interface.md`) over the harness client:

| Controller member | Native |
| --- | --- |
| `start` / `startFresh` | `loadSession` / `createSession` on the shared host; nothing to launch per conversation |
| `prompt` | push a user-message item with sender and policy; resolves on turn end |
| `cancel` / `forceStop` | `session.interrupt()`; force stop abandons the turn if the process doesn't answer |
| `subscribeOutput` | harness events translated into the update model the `agc` consumes |
| `configOptions` / `setConfig` | model, reasoning, temperature as `ConfigOption`s; written as a config overlay |
| `subscribeUsageUpdate` | usage events, one per model call |
| `capabilities` | `nativeSteering: true`; media from the model; no load, fork, modes or degraded mode |

- **The internal event model stays.** Messages, tool calls, usage and permissions cover the native side; the record
  kind `protocol` is generic enough for model-call details.
- **Stale supervision fits unchanged:** output events, cancel, force stop (`supervisedPrompt`,
  `src/agent-session.ts:4037`).
- **Native conversations are `Agent`-only** (no detached `AgentSession`, no `SessionManager`).

### agents-core

agents-core runs on `SessionManager` and `AgentSession` (the managed path), not `Agent`. Native conversations and the
orchestrator are `Agent`-only by design, so agents-core gets them only after it moves to `Agent`. Its pinned 0.10.2
is unaffected.

## Two logs of one native conversation

The harness keeps the context the model sees, in its store and format. The library keeps its records as an
observation and audit log, as for ACP. The library never rebuilds a native context from its records (continuation,
recovery and adoption are gated off by capability).

## Usage

Exact: each model call reports input, output and cached tokens (cost where the provider reports it), normalized by the
harness's model client. The `NativeController` writes them to the existing metering ledger.

## The inbox

A conversation's **inbox** is what waits to reach the agent in that conversation, other than the host's own prompt
calls: worker replies, failures, redirects, permission requests, items the consumer pushes. Today's code has two
mechanisms, and the inbox is both, not a new store:

| Part | Existing mechanism | For |
| --- | --- | --- |
| Persisted items | out-of-band messages: records with `origin: out_of_band` plus `out_of_band_delivery` (`src/out-of-band-messages.ts`) | items that must survive a restart: worker replies, failures, redirects, interrupted |
| Live items | the conversation's in-memory queue (`AgentConversationQueue`) and the steering controller (`src/steering/controller.ts`) | prompts and steering while the process runs |

- **Native delivery:** an item is persisted first, then pushed into the harness session: it starts a turn if the
  session is idle, or goes into the context at the next model call. Consumption marks it delivered (the existing
  `out_of_band_delivery` cursor), so a restart re-pushes only what wasn't consumed.
- **ACP delivery:** an out-of-band message, delivered into the next prompt, as today. ACP harnesses can't be woken by
  an item; a wake needs a prompt the consumer allows (later).
- **Item shape:** out-of-band records gain a kind and a sender in their metadata (`worker_reply`, `worker_failed`,
  `worker_redirected`, `permission_request`, `worker_interrupted`, consumer kinds). The harness renders each kind.
- **Native steering:** the steering controller cancels a running turn through `SteeringHost.cancelProviderTurn`. With
  `nativeSteering`, the native host pushes the steer item into the session instead; nothing is cancelled and
  `endedBy: "steer"` doesn't occur for native turns. Interrupt stays a separate action.
- **What comes out of a wake:** a turn the agent takes on its own produces events and records like any turn; it
  reaches a user only if the host delivers it.
- **The orchestrator's delivery port** is implemented on this.

## Identity becomes injection

The harness owns the entity (the timeline; harness design spec). How it keeps it doesn't matter to the library;
identity reaches ACP conversations by injection.

**The existing interface already fits.** `AgentIdentityRuntime` (`src/identity.ts`):

| Method | Called | For the harness adapter |
| --- | --- | --- |
| `load(input)` | before every prompt, with participant and target provider context (`src/agent/persisted-lifecycle.ts:96`) | prepare: the digest since the member's position, as `promptPreamble`, plus a receipt |
| `update(input)` | after every committed batch of records (`src/agent/record-capture.ts:44`) | report: append the conversation's messages to the timeline |
| `delivered(receipt)` | once the provider has the prompt | advance the member's position |
| `synchronize` | optional | not needed |

So no new interface: `harnessIdentityRuntime(host)` implements `AgentIdentityRuntime`. Changes:

- **Native conversations are skipped** in `load` and `update` (the harness has them already).
- **MCP servers for members** are attached at session creation, not per prompt: a new optional
  `mcpServers(conversation)` on the runtime, read where `CreateAgentConversationConfig.mcpServers` is applied. Phase 2,
  with the harness's MCP server.
- **Summaries:** when the checkpoint coordinator (`src/checkpointing/coordinator.ts`) completes a checkpoint, the
  runtime reports it (`report(kind: "summary")`). A new optional `checkpointed(input)` hook on the runtime.
- **Receipts** change shape: `IdentityDeliveryReceipt` names source conversations and sequences; the harness's receipt
  is `{ member, context, through }`. Make the receipt opaque to the library (`unknown` carried back), which also
  retires `identity_delivery_cursors` for harness-backed identity.
- **Delivery is at least once:** a failed prompt is delivered again; a crash after the provider got it repeats a
  slice, harmlessly. acp-client stores nothing identity-related for harness-backed identity.
- **Deprecation.** With no harness, ACP conversations get no cross-conversation identity unless the consumer keeps
  `CheckpointBackedIdentityRuntime`, deprecated and removed in a breaking release.

## MCP for ACP conversations (phase 2)

The harness's MCP server (`./mcp-server`) gives ACP conversations identity tools as members, and later delegation
tools. One endpoint per member, scoped by a token. ACP requires stdio MCP; HTTP and SSE only where advertised (send
`mcpServers` only to agents that advertise them, as `68d7af0` did for `additionalDirectories`). With the harness in its
own process, a stdio bridge stub connects to it. Workers never get delegation tools by default. Approve the server's
tools by exact server and tool name.

## Configuration

```ts
new Agent({
  adapters: {
    main:   { kind: "native", harness: { root: "/data/harness", config: "./harness.json" } },
    codex:  { command: ["codex-acp"] },                 // an Adapter, as today (or ADAPTERS.codex)
    claude: ADAPTERS.claude,
  },
  defaultAdapterId: "main",
  conversationDefaults: { launcher, cwd },             // as today; also starts the native harness
  persistence: { ... },
  functions: { crm_search: async (input) => { ... } }, // served to the harness for run.type "function" tools
  orchestrator: { workers: { adapterId: "codex", cwd: "/work", limit: 2 } },
  internalInference: { runtime: "http" },              // "http" when a key is configured, else "harness"
});
```

What the library provides to the harness, all through its protocol:

| The library | Through |
| --- | --- |
| Where the harness writes | `harness.root` |
| The configuration | the path or object from the adapter |
| Function tools | callback `functions/call` for each name in `functions` |
| Workers for delegation | callback `delegation/*`, served by the orchestrator |
| ACP transcripts for history tools | callback `history/*` over its records |
| Sender and policy | on each prompt, chosen by the consumer, never by the end user |

## Internal inference over HTTP

Checkpoints, summaries and recovery seeds are one prompt and one answer, today run in a disposable ACP session
(`src/internal-inference/runtime/harness-runtime.ts`, `disposable-session-env.ts`).

- **A new `http` runtime** implementing `InternalInferenceRuntime.run(request, signal, lifecycle)`: one model call,
  no process, structured output.
- **It imports the harness's model client** (`./openai-compatible`) instead of duplicating one. It runs in
  acp-client's process: internal inference is the library's own work, not the agent's.
- **The lifecycle is ACP-shaped** (`stageChanged("creating_session" | "prompting")`, `sessionStarted({
  internalSessionId })`): the runtime reports `prompting` only and no session; records that expect an
  `internalSessionId` must accept none.
- Used when a valid key is configured; the disposable session stays as the fallback.

## Code plan

```
src/native/
  adapter.ts             NativeAdapter, validation, AgentAdapter union helpers
  host.ts                NativeHarnessHost: one per Agent; launches `harness serve`, holds the client,
                         restarts on crash, serves callbacks
  callbacks.ts           functions, delegation (→ orchestrator), history (→ records)
  native-controller.ts   ConversationController over the client
  translate-events.ts    harness events → the agc update model
  steering-host.ts       native steering: push instead of cancel
  inbox-delivery.ts      the orchestrator's DeliveryPort: persist as out-of-band item, push or defer
  identity-runtime.ts    harnessIdentityRuntime (AgentIdentityRuntime)
  index.ts
src/internal-inference/runtime/http-runtime.ts
src/launcher.ts          AcpLauncher → ProcessLauncher (alias kept), kind "native-harness"
```

- **`src/native/` is the only place that imports the harness package.** The acp-client core depends on contracts
  (`ConversationController`, `AgentIdentityRuntime`, `DeliveryPort`).
- **Touches existing code:** `src/agent.ts` and `src/agent/config.ts` (the `AgentAdapter` union, constructing the host,
  `functions`); `src/agent-adapter-registry.ts` (store either adapter type); the controller factory
  (`createController`, `src/agent-session.ts:733`, via the controller-interface work) chooses `NativeController` for a
  `NativeAdapter`; `src/out-of-band-messages.ts` (kind and sender in metadata); `src/identity.ts` (optional
  `mcpServers`, `checkpointed`; opaque receipt); the checkpoint coordinator (call `checkpointed`).
- **`agent-session.ts` does not grow.** Steering already goes through `SteeringHost`; the controller choice is the
  factory; anything else needed there is extracted first.

## Steps

1. Out-of-band items with kind and sender; the delivery port over them, tested with ACP conversations (next-prompt
   delivery).
2. `NativeAdapter` and the registry change; the `NativeHarnessHost` with the in-process transport; the
   `NativeController` passes the controller conformance suite on the harness's scripted client.
3. The process transport: launch through the launcher, crash and restart, a test with a real `harness serve` process.
4. Native steering behind `nativeSteering`.
5. Callbacks: functions, delegation backend over the orchestrator, history over records.
6. The `http` internal-inference runtime.
7. `harnessIdentityRuntime`: `load`, `update`, `delivered`; the `checkpointed` hook; opaque receipts.

## Acceptance

- A native conversation runs end to end against `harness serve` started through a launcher (locally, and in one
  container test): prompt, tool loop, steer injected without cancel, interrupt, usage in metering, records written.
- Killing the harness process ends running turns with an error and the next prompt works after the restart.
- A native conversation delegates to a fake worker and wakes on its reply, also after an acp-client restart.
- An ACP conversation with a harness configured receives a preamble from `load`, and its position advances only after
  `delivered`.
- Internal inference runs over `http` with a key, and over the disposable session without one.
- With no native adapter configured, behaviour is unchanged and the existing suite passes.

## Open

- [ ] Whether acp-client hard-depends on the harness package or takes it as an optional peer (overview).
- [ ] Do Codex and Claude support HTTP MCP servers over ACP, or is the stdio bridge needed (phase 2)?
- [ ] Whether the consumer may wake an ACP conversation with an item (a prompt it allows), or ACP only gets next-prompt
      delivery.
