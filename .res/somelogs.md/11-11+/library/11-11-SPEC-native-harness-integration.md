# Native harness in acp-client

Status: agreed, not started. Written 2026-11-11. Lines of work L4–L8 in `../11-11-NOTE-overview.md`. This spec is the
harness seen from the library: what acp-client needs from it and what it changes in acp-client. How the harness
works inside is `../harness/11-11-SPEC-harness-design.md` and `../harness/11-11-SPEC-harness-v1.md`.

## Why the library needs a harness of its own

The 10-17 note (`../../9-22+/10-17-NOTE-model-call-controller.md`) proposed a third controller that calls a model API
with no harness. The idea grew into a harness of our own, for reasons that only show from acp-client's side:

- **Resources.** Every conversation owns a harness process (hundreds of MB). A conversation that only needs to talk
  should cost a request. Many conversations, few processes, is the pool (`11-11-SPEC-orchestrator.md`); the many
  conversations need a backend that isn't a process.
- **One agent across conversations.** Each conversation in its own harness can't be one entity. The checkpoint-backed
  identity (`src/identity/checkpoint-backed.ts`) copied raw messages from other conversations into a preamble
  (`maxContextChars` 32,000, `maxSourceChars` 8,000) and proved unreliable.
- **Control.** Through ACP the system prompt goes in as a first prompt, some models refuse it, and the harness's own
  prompt can override ours (OpenCode tells the model it is OpenCode). We don't control context, compaction or tool
  descriptions. With our own loop all of that is ours; the cost is that the tuning harness prompts gave for free is
  ours to write.
- **Talking to work needs tools.** To start, check or stop work the talking side must call tools in a loop, and a
  model calling tools in a loop is a harness. Building on top of an existing harness is not possible (no API inside
  the loop); wrapping our own model call is.

Rejected along the way: a plain HTTP controller with the model client as a library layer (provider calls belong
inside the harness; the controller drives a harness, as the ACP controller does); the harness as an in-process ACP
agent (it would reuse every feature, but bind the harness to ACP's shape); one harness per conversation (shared state
is per agent anyway).

## What acp-client sees

```
AgentConversation ── AgentSession ── NativeController ── NativeHarness (public API)
                                          │                  createSession / loadSession
                                          │                  session.push(item) · interrupt() · events
                                          └─ translation only, no ACP-client equivalent
```

- **The `native` adapter kind.** Adapters gain a discriminant: `{ kind: "acp", preset | command, ... }` for the
  current presets and `{ kind: "native", harness: { root, config } }`. The adapter registry validates it and picks
  the controller. Existing presets keep working; a missing `kind` means `acp`.
- **One harness instance per `Agent`,** serving all its native conversations: the model client, rate limits, tools,
  pool and identity are per agent. Per conversation: a harness session (context, turn state, cancel). One
  conversation's loop never blocks another's.
- **The `NativeController`** implements the controller interface (`11-11-SPEC-controller-interface.md`) over the
  harness's public API and contains translation only:

| Controller member | Native |
| --- | --- |
| `start` / `startFresh` | `loadSession` / `createSession`; nothing to launch |
| `prompt` | `session.push` an inbox item with sender and the policy; resolves on turn end |
| `cancel` / `forceStop` | `session.interrupt()`; abort the in-flight HTTP call |
| `subscribeOutput` | harness events → the update model the `agc` consumes (messages, tool calls, usage, permissions) |
| `configOptions` / `setConfig` | model, reasoning, temperature in the `ConfigOption` shape; written as a config overlay |
| `subscribeUsageUpdate` | usage events, exact per call |
| `capabilities` | `nativeSteering: true`, media from the model, no load/fork/modes/degraded |

- **The internal event model stays.** The `agc` already consumes messages, tool calls, usage and permissions; that
  covers the native side. The record kind is `protocol`, generic enough for model-call details; renaming waits.
- **Stale supervision fits unchanged:** it needs output events, cancel and force stop.
- **Detached conversations** (`AgentSession` without an `Agent`) are not supported for native: native conversations
  are `Agent`-only.

## Two logs of one native conversation

The harness keeps the context the model sees, in its own store and format. The library keeps its records as an
observation and audit log, as it does for ACP. Each can change format without the other. The library never rebuilds
a native context from its records (no continuation, recovery or adoption paths; gated off by capability).

## Usage

Exact for native conversations: every response carries input, output and cached tokens (cost on OpenRouter with
usage accounting). The harness's model client normalizes the fields (`prompt_tokens_details.cached_tokens` in the
OpenAI format; `cache_read_input_tokens` / `cache_creation_input_tokens` on Anthropic); the `NativeController` writes
them to the existing metering ledger, one reading per model call.

## The inbox and native steering

Each conversation has an **inbox**: anything that should reach the agent is an item with a kind (user message, worker
reply, permission request, reminder, watch match, consumer event), a sender, content, a policy and a delivery mode
(wake, or quiet: only on the next turn).

- **It is the `agc`'s existing queue** (the steering controller; pending messages already carry `participantId`,
  `src/steering/contracts.ts`), extended to hold items that aren't prompts. The `agc` owns it, so it is persisted,
  survives restarts and works for ACP conversations too, where an item becomes a queued prompt.
- **An idle agent starts a turn; a busy one gets the item at its next model call.** The agent may take the turn and
  say nothing to the user.
- **Native steering interrupts nothing.** Today an ACP steer cancels the turn at a tool boundary and resends, because
  nothing can be injected into a black box. With `nativeSteering` the `agc` hands steer items to the controller,
  which pushes them; the harness adds them at the next model call. `endedBy: "steer"` doesn't occur for native turns.
  Interrupt stays a separate action that aborts.
- **Rendering is the harness's.** The library decides what reaches a conversation and when (facts); the harness
  decides how it appears in the context.

## Identity becomes injection

The harness owns the entity: who it is, who it knows, what is happening now, what it knows long term (the timeline,
`../harness/11-11-SPEC-harness-design.md`). acp-client stops managing identity content. How the harness keeps it does
not matter to the library; what matters is that identity reaches ACP conversations by injection.

- **Native conversations** get identity natively; the injector skips them.
- **ACP conversations become member sessions** when a harness is configured: registered with the harness, given the
  member's MCP endpoint at session creation, and given what the harness says they should know before each prompt.
  Codex or Claude record and share through the harness's MCP tools; acp-client does nothing on the write side.
- **The interface** is a slimmed `AgentIdentityRuntime`:

```ts
interface IdentitySource {
  prepare(conversation: ConversationRef): Promise<{
    preamble?: string; mcpServers?: McpServer[]; receipt?: DeliveryReceipt;
  }>;
  delivered(receipt: DeliveryReceipt): Promise<void>;
}
```

- **Delivery is a handshake:** `prepare` before the prompt, `delivered` once the provider has it. The harness keeps
  each member's position on its timeline; acp-client stores nothing identity-related (no delivery cursors). At least
  once: a failed prompt is delivered again; a crash after the provider got it repeats a slice, harmlessly.
- **The adapter `harnessIdentitySource(harness)`** lives in the library's harness-integration module next to the
  `NativeController`, the one place that knows both sides. Neither the acp-client core nor the harness imports the
  other.
- **Reporting into the timeline.** The timeline is only as complete as what reaches it. acp-client appends ACP
  conversations' messages as records commit, and a conversation summary whenever it checkpoints
  (`harness.report({ conversation, from, policy, kind: "message" | "summary", ... })`). Conversation summaries stay
  acp-client's (they describe a conversation); the harness's digests describe the entity.
- **Deprecation.** With no harness configured, ACP conversations get no cross-conversation identity. The
  checkpoint-backed runtime stays as a deprecated `IdentitySource` until a breaking release removes it; its plumbing
  (the `load` / `delivered` interface, receipts) is what this reuses.

Sequence: native identity first (phase 1 memory in the harness); member sessions with the harness's MCP server
(phase 2); then removal of the checkpoint-backed runtime.

## MCP for ACP conversations

MCP is not how the parts talk (prompts are). It is how an ACP-backed conversation gets the tools a native one has
natively: identity tools as a member, and later delegation tools for an ACP front. The server is the harness's
(`./mcp-server` export); acp-client attaches it.

- **Which conversation is calling:** one endpoint per member, scoped by a token, so the harness knows the caller and
  its policy.
- **Transport per harness:** ACP requires stdio; HTTP and SSE only where advertised (Grok advertises both; Codex and
  Claude to check). Send `mcpServers` and `additionalDirectories` only to agents that advertise them (as done for
  `additionalDirectories` in `68d7af0`). Stdio needs a small bridge stub that connects back to our process.
- **Tools per role:** a worker never gets delegation tools by default.
- **Permissions:** harnesses ask permission for MCP tools; approve the harness's own server by exact server and tool
  name, never by substring.

## Configuration

The harness is configured by its own JSON (`../harness/11-11-SPEC-harness-v1.md`). The `Agent` configuration only
says how to run it and what the library adds:

```ts
new Agent({
  adapters: {
    main:   { kind: "native", harness: { root: "./data/harness", config: "./harness.json" } },  // or the object
    codex:  { kind: "acp", preset: "codex" },
    claude: { kind: "acp", preset: "claude" },
  },
  defaultAdapterId: "main",
  persistence: { ... },                                  // the library's records, as today
  functions: { crm_search: async (input) => { ... } },  // implements config tools with run.type "function"
  orchestrator: { workers: { adapterId: "codex", cwd: "/work", limit: 2 } },   // the delegation backend
  internalInference: { runtime: "http" },                // "http" when a key is configured, else "harness"
});
```

What the library plugs into the harness, all through the harness's contracts:

| The library | Through |
| --- | --- |
| Where the harness writes | `storage.root` |
| The configuration | the JSON document or path from the adapter |
| Function tools | `registerFunction` for each entry of `functions` |
| Workers for delegation | the orchestrator, registered as the delegation backend |
| ACP transcripts for history tools | a history source over its records |
| The prompt's sender and policy | each `push` / `prompt`, chosen by the consumer, never by the end user |

Policies, tools and MCP servers are not `Agent` options any more. ACP member sessions carry a policy too, which
decides what identity they receive and what they may write.

## Internal inference over HTTP

Checkpoints, summaries and recovery seeds are one prompt and one answer. Today each runs in a disposable ACP session
(`src/internal-inference/runtime/harness-runtime.ts`, `disposable-session-env.ts`): a process per attempt, plus the
harness's own background work (OpenCode's title request).

- **A new `http` runtime** next to `harness`: one model call, no process, structured output.
- **It imports the harness's model client** instead of duplicating one. The duplication of keeping a second client
  was weighed and rejected; the dependency direction (library → harness) already exists.
- **Used when a valid key is configured;** the disposable ACP session stays as the fallback for consumers without a
  key.
- Built alongside the orchestrator and identity work; it is also the cheapest first live use of the model client.

## Steps

1. Inbox: non-prompt items in the `agc` queue, persisted; delivery to ACP conversations as queued prompts.
2. The `native` adapter kind and the `NativeController` over the harness's scripted client; the controller
   conformance suite from the controller-interface spec passes.
3. Native steering behind `nativeSteering`.
4. Functions, the orchestrator as delegation backend, records as history source.
5. The `http` internal-inference runtime.
6. `IdentitySource` and `harnessIdentitySource`; reporting messages and summaries; the checkpoint-backed runtime
   wrapped as a deprecated source.

## Acceptance

- A native conversation runs end to end on the scripted client: prompt, tool loop, steer injected without cancel,
  interrupt, usage in metering, records written.
- A native conversation delegates to a fake worker and wakes on its reply.
- An ACP conversation with a harness configured receives a preamble from `prepare` and its position advances only
  after `delivered`.
- Internal inference runs over `http` with a key, and over the disposable session without one.
- With no native adapter configured, behaviour is unchanged.

## Open

- [ ] Do Codex and Claude support HTTP MCP servers over ACP, or is the stdio bridge needed?
- [ ] Whether acp-client hard-depends on the harness package or takes it as an optional peer (overview).
