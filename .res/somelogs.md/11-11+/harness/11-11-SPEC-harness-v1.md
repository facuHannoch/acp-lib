# Native harness v1

Status: agreed, not started. Written 2026-11-11. What the first version builds (H1–H10 in `../11-11-NOTE-overview.md`).
The why is `11-11-SPEC-harness-design.md`; folders, rules and build order are `11-11-SPEC-harness-project.md`.

## Scope

In: the kernel and turn state machine; the contracts; JSON configuration and policies; configured tools and the MCP
client; the delegation and messaging tools; an OpenAI-compatible model client; the context pipeline with tool
placement and basic compaction; the timeline v1 (positions, digests from host summaries, shared state as a projection,
structural and agent-noticed watches); storage; the public API; the `harness` CLI.

Out (phase 2): long-term memory and consolidation; digests at several granularities; the MCP server and member
sessions; the background watch evaluator; reminders; skills; deferred tool loading; file and shell capabilities;
model profiles.

## The kernel

The kernel owns sessions and the turn loop. A session is one conversation's context plus its turn state; the harness
instance holds the shared parts and serves many sessions at once.

- **One actor per session:** a mailbox (the inbox) processed one item at a time; sessions run in parallel. A
  sequential queue per session, no framework.
- **An explicit turn state machine:** `idle → building → calling → running_tools → building → … → idle`, plus
  `interrupting`. A pure function `(state, event) → (state, actions)`; a separate runner executes the actions through
  the extension points.
- **Steering** is an item arriving while the session isn't idle: it waits in the mailbox and is drained at the next
  `building`. It waits only for what is in flight: a streaming model call or a running tool (the item goes in right
  after its result).

```ts
async function runTurn(session, trigger) {
  emit("turn.start", { session, trigger });
  while (true) {
    if (session.aborted) return end("interrupted");
    session.append(await sources.drain(session));             // inbox items: steering, wakes
    const request = await pipeline.build(session);            // context pipeline, incl. compaction
    if (!guards.allowCall(session)) return end("limit");
    const answer = await modelChain.call(request, session.signal);
    session.append(answer);
    if (answer.toolCalls.length === 0) return end(answer.stopReason);
    for (const call of answer.toolCalls) session.append(await toolChain.run(call, session));
    await store.save(session);
  }
}
```

**The kernel does:** start and end turns; call each extension point in order; enforce that tool results pair with
their calls; save after each step; emit lifecycle events; honour abort signals; report outcomes (finished,
interrupted, limit, error). **It never contains:** prompt text or rendering, provider formats, compaction logic, any
specific tool, permission rules, retry logic, knowledge of policies, workers or the orchestrator.

## Public API

| Call | Meaning |
| --- | --- |
| `createHarness({ root, config })` | Open an instance over a root directory and a config (path or object) |
| `harness.createSession(options)` / `loadSession(id)` | Open a session with its id and session-level settings (default policy) |
| `session.push(item)` | Add an inbox item: starts a turn if idle, injected at the next call if busy |
| `session.interrupt()` / `session.close()` | Abort the running turn / close |
| `session.events` | Lifecycle and streaming events: text deltas, tool calls, usage, model-call log, turn end |
| `harness.prompt({ conversation, from, policy?, content })` | Host shorthand: resolve the session, push a user message with sender and policy |
| `harness.report({ conversation, from, policy, kind, ... })` | Host reports a conversation it runs elsewhere: `message` or `summary` |
| `harness.registerFunction(name, fn)` | Implement a config tool with `run.type: "function"` |
| `harness.setDelegationBackend(backend)` / `addHistorySource(source)` | Host-provided contracts |
| `harness.config.get()` / `update(patch)` | Read and change the JSON config (versioned) |

`export()` / `importSession(bundle)` (portable sessions) are in the contract and can be stubbed in v1.

## Core data model

```ts
type Entry =
  | { kind: "message"; role: "user" | "assistant"; parts: Part[]; sender?: SenderRef; policy?: string; at: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; callId: string; content: Part[]; isError?: boolean }
  | { kind: "reasoning"; provider: string; opaque: unknown }       // sent back unchanged, same provider only
  | { kind: "compaction"; summary: Part[]; replaces: [from: string, to: string] };

type Part = { type: "text"; text: string } | { type: "media"; ref: string; mime: string };
type SenderRef = { id: string; label?: string; note?: string; kind?: "person" | "agent" | "worker" | "harness" | "host" };

interface InboxItem {
  kind: "user_message" | "worker_reply" | "permission_request" | "watch_match" | "timeline_digest" | string;
  sender: SenderRef;
  content: Part[];
  policy?: string;              // asserted by the host; a turn takes the most restrictive
  delivery: "wake" | "quiet";
  data?: unknown;               // kind-specific facts for renderers
}

interface ModelRequest { system?: string; tools: ToolDefinition[]; entries: Entry[]; options: ModelOptions;
                         allowedTools?: string[] }
type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "reasoning"; opaque: unknown }
  | { type: "usage"; input: number; output: number; cachedInput?: number; cost?: number }
  | { type: "stop"; reason: "end" | "tool_calls" | "max_tokens" | "refusal" | "error" };
```

- Inbox item kinds are open; each needs a renderer, checked at registration.
- Senders are references; renderers resolve them, so names match what the host described.
- Compaction is an entry: the store keeps what was replaced.

## Configuration

One JSON document, `config.json` in the root, changed through the API or the CLI; each prompt reads the current
version (cached by version). Code adds only what JSON can't hold: function handlers and backends.

```json
{
  "version": 1,
  "model": { "protocol": "openai-compatible", "baseUrl": "https://openrouter.ai/api/v1",
             "apiKeyEnv": "OPENROUTER_API_KEY", "model": "...", "reasoning": "low" },
  "system": "You are ...",
  "storage": { "root": "~/.native-harness" },
  "tools": [
    { "name": "lookup_order", "description": "...", "input": { "type": "object" },
      "run": { "type": "http", "url": "https://api.example.com/orders", "method": "POST" } },
    { "name": "deploy", "description": "...", "run": { "type": "command", "argv": ["./deploy.sh"] } },
    { "name": "crm_search", "description": "...", "input": { "type": "object" }, "run": { "type": "function" } }
  ],
  "mcpServers": [ { "id": "gmail", "url": "...", "headers": {} } ],
  "policies": {
    "owner": {
      "memory":     { "read": "all", "write": true },
      "messaging":  { "send": ["*"], "trigger": ["*"] },
      "delegation": { "use": true, "scope": "all", "max": 2 },
      "tools":      { "send_email": "ask", "mcp:gmail/*": "allow", "*": "allow" }
    },
    "guest": {
      "memory":     { "read": "none", "write": false },
      "messaging":  { "send": ["policy:owner"], "trigger": [] },
      "delegation": { "use": true, "scope": "none", "max": 1 },
      "tools":      { "*": "deny" }
    }
  },
  "defaultPolicy": "guest",
  "toolPlacement": "superset-hint",
  "limits": { "callsPerTurn": 50, "unattendedTurns": 5 },
  "compaction": { "at": 0.8 }
}
```

- **The system prompt is the consumer's, verbatim.** The harness adds no layer to it; what it renders (sender tags,
  digests, the per-turn tool hint) goes into the conversation, not the system prompt.
- **Tools say how they run.** `http` and `command` work from the CLI with no code (`command` takes an argv, never a
  shell string). `function` tools need `registerFunction`; one declared but not registered is listed as unavailable,
  not a crash.
- **MCP servers** (stdio and HTTP, through the official SDK) are listed at startup; their tools are namespaced
  `mcp:<server>/<tool>` and may change at runtime (the provider emits a change event).
- **Validation:** unknown keys and unknown policy names are errors with a path; a config that fails validation is
  not applied.

## Policies

- **Capabilities** have fixed names: `memory` (`read`: none, own, all; `write`), `messaging` (`send`, `trigger`:
  target patterns), `delegation` (`use`, `scope`: none, own, all; `max`), later `files`, `shell`. **Tools** are matched
  by name or pattern with `*` as fallback; levels deny, ask, allow.
- **Messaging targets:** `*`, a conversation id, or `policy:<name>` for conversations whose current sender holds that
  policy.
- **Presets** ship as named examples: `readOnly`, `guest`, `trusted`, `owner`. With no policies configured a
  permissive single-user default applies; once policies exist, `defaultPolicy` is required.
- **Resolution per turn:** the policy of each triggering item (item → session default → `defaultPolicy`); several
  items → the most restrictive, capability by capability.
- **Read-only** writes no memory and gets no tool that carries content into other conversations, or a guest's words
  reach the agent through the back door.
- **The policy engine is the permission gate.** It decides allow, deny or ask for every call under the turn's
  policy; ask waits for an answer with a timeout (the host answers through an inbox item). Worker permission requests
  forwarded by the delegation backend are rendered as inbox items; the agent answers with a tool when the level is
  ask the agent.

## Tools

- **Registry and providers.** Providers list definitions for a session under the turn's policy and execute calls:
  `configured/` (http, command, function), `mcp/`, and the harness's own (`delegate`, `check`, `stop`,
  `message_participant`, `trigger_response`, `state_read`, `state_write`, `timeline_since`, `timeline_search`).
- **The tool chain** wraps every execution: schema validation (errors go back as tool results so the model fixes the
  call), the permission gate, timeout, result truncation, usage.
- **Descriptions are the main lever on behaviour.** Boundaries as capability ("you can't read files yourself; a
  delegated agent can"); errors that say how to fix the call ("`to` must be an id returned by `delegate`; open ones:
  w1, w2").
- **Delegation tools** call the delegation backend; with none registered they are absent. The built-in backend runs
  native subagents (another session of the same harness, with a worker policy).
- **Messaging tools:** `message_participant(to[], text)` appends a message to each target conversation with no model
  call; `trigger_response(to[], text)` pushes a wake item into each. Targets are checked against `messaging`; content
  is checked against the target's visibility.

### Tool placement

Tool definitions sit at the start of the request, so changing them breaks the cache. A placement stage decides:

| Strategy | How | Cache |
| --- | --- | --- |
| `superset-hint` (default) | The union of the session's tools; a per-turn note of what this sender may use, appended | Kept |
| `provider-subset` | Full list plus a per-call restriction where the client advertises it (OpenAI's allowed-tools option, to verify) | Kept |
| `deferred` | Names or a search tool; full definitions fetched on demand (phase 2) | Kept |
| `rebuild` | Exactly this turn's tools; for single-policy sessions | Breaks on change |

The gate enforces the turn's policy at call time in every strategy: placement guides the model and keeps costs down;
the gate guarantees.

## Model client

- **`ModelClient`:** neutral request in, stream of neutral events out, abortable. Provider translation is two pure
  functions (render, parse), golden-testable without a network.
- **v1: OpenAI-compatible** with a configurable base URL: OpenRouter from day one, plus direct compatible endpoints
  (OpenCode Zen and Go, DeepSeek, xAI, Gemini's compatibility endpoint, Ollama, vLLM). A native Anthropic client only
  if explicit cache marks or thinking blocks require it. A provider library (the Vercel AI SDK) may implement the
  contract if it keeps the features we need; confirm caching, reasoning passback and usage fields first.
- **The model chain:** retries with backoff on rate limits and outages, a call log event per call (model, request id,
  usage, cached tokens, latency, stop reason).
- **Reasoning** is kept opaque and sent back unchanged only to the same provider.
- **Usage** normalized: `prompt_tokens_details.cached_tokens` (OpenAI format), `cache_read_input_tokens` /
  `cache_creation_input_tokens` (Anthropic); cost where the provider reports it.
- **Exported** as `./openai-compatible` so the library's `http` internal-inference runtime can import it.

## Context pipeline

Ordered pure stages from the session view to the neutral request:

1. **Layers:** the system prompt verbatim; tool definitions by the placement strategy.
2. **History:** entries since the last compaction marker.
3. **Inbox rendering:** each drained item through its renderer as tagged blocks
   (`<message from="Bob" policy="trusted">…</message>`, `<worker_reply from="w1">…</worker_reply>`,
   `<since_last_turn>` digests, watch matches as standing requests).
4. **Sender tags** on user messages; the per-turn tool hint last.
5. **Cache order:** nothing before the end changes between calls; deltas are appended once and become prefix.

**Compaction** at `compaction.at` of the window: first clear old tool results, then summarize old turns into a
`compaction` entry; the session's timeline position is rebased (current state plus a digest). Rare and good: it loses
detail and breaks the cache.

## Timeline v1

```
timeline      append-only events: { seq, at, kind, conversation, from, policy, scope, content }
positions     per session and provider context: the seq its context has been brought up to
projections   shared state (facts, commitments) · "told" events · watches
delivery      digest(position..now, the turn's policy) → appended to the session → position advances
```

- **What appends:** native sessions automatically (each user message, assistant answer, delegation fact, messaging
  call); hosts through `report` (messages; summaries when they checkpoint).
- **Scope** on every event, from the policy it was written under; slices are filtered by the receiving turn's policy.
  A guest's words carry guest scope and never become owner facts.
- **Digests in v1** are stitched: host summaries for spans they cover, raw events (truncated) for the rest, newest
  last, under a size budget. Several granularities are phase 2.
- **Delivery to native sessions:** on each turn the pipeline renders the digest of the slice since the session's
  position, filtered by the turn's policy, as a `<since_last_turn>` block; the position advances once the request is
  sent.
- **Shared state** is a projection: `state_write` appends a fact or commitment event with provenance;
  `state_read` returns current facts the policy can see.
- **Watches:** `watch_create(condition, expiry?)` stores one; the structural matcher checks event kinds and tags on
  append; active watches are rendered to the owner's conversation so the agent can act (agent-noticed). A match is a
  `watch_match` inbox item.
- **Member delivery** (`prepare` / `delivered`) is in the contract; its implementation lands with member sessions.

## Storage

| Data | v1 |
| --- | --- |
| Identity core: config, timeline, positions, watches, shared-state projection | Required. SQLite through `bun:sqlite` in `<root>/identity.sqlite` |
| Working contexts | In memory; optional JSONL snapshots (`<root>/sessions/<id>.jsonl`) |
| Transcripts | Not kept; hosts supply them as history sources |

The store is event-sourced: a session is an append-only log, the context a projection, compaction an event.

## Guards

Calls per turn (`limits.callsPerTurn`); the unattended-turn budget (`limits.unattendedTurns`: turns with no human
input, which stops agent–worker and agent–agent ping-pong); a cost budget later.

## CLI

`harness chat [--root DIR] [--config FILE] [--as ID] [--policy NAME]` opens or resumes a session and prints text,
tool calls and wakes; `--log` shows the model-call log. `harness config get|set|validate`. It drives the public API
only.

## Steps

The build order is in the project spec. Acceptance per step is its conformance suite and scenarios; v1 as a whole:

- A whole conversation runs offline on the scripted client with golden requests: tool loop, steering, interrupt,
  compaction, limits.
- Policy tests (no model): the gate refuses by capability and tool pattern; the most restrictive policy wins on
  combined turns; a guest slice never contains owner-scoped events.
- Two sessions of one harness: a fact written in one is delivered to the other; `message_participant` and
  `trigger_response` reach the other session.
- `harness chat` works against a real OpenAI-compatible endpoint (when a key exists).

## Open

- [ ] Does steering abort an in-flight model call and resend, or always wait for it to finish?
- [ ] Digests: granularities, how and when produced (memory findings).
- [ ] Config versioning, validation error shape, and how the library overlays the document.
- [ ] Whether the Vercel AI SDK keeps caching, reasoning passback and usage well enough to implement `ModelClient`.
