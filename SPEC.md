# ACP Client Library — Specification

A standalone Agent Client Protocol (ACP) client library for orchestrating AI coding
agents (Kimi, Claude, Codex, etc.) over JSON-RPC 2.0. Built because existing libraries
(e.g. acpx) make assumptions that don't fit — notably crawling to the git dir.

This document records the design decisions taken during research and the resulting API
surface.

---

## Core principles

1. **Introspection over hardcoding.** Almost nothing is known ahead of time. Models,
   auth methods, capabilities, config options — all of it is *discovered* from the
   protocol at runtime, never baked into the library. The library reflects what the
   agent reports; it does not assume.

2. **Surface, don't interpret.** The library exposes raw protocol facts and lets the
   caller decide what they mean. It does not guess at auth state, does not silently
   recover, does not hide provider quirks.

3. **One connection = one process = one session.** There is no separate "agent"
   abstraction. The binary *is* the connection. Everything lives on a single
   `AcpClient` handle.

4. **The adapter only knows how to launch.** Everything else (capabilities, auth
   methods, supported features) is learned from `initialize`. The adapter is just a
   launch config.

---

## Architecture

```
AcpClient                       ← the single handle
  config (constructor)          ← how to spawn & configure the process
    adapter                     ← launch command (preset or inline)
    execPrefix                  ← e.g. ["docker","exec","-i","<container>"]
    env                         ← spawn-time env vars
    cwd                         ← agent workspace
    sessionsDir                 ← where session files are persisted
    sessionId?                  ← optional, to resume a specific session
    defaultPermission           ← "approve" | "cancel" fallback

  .connect({ mcpServers? })     ← spawn + initialize + session/new|load
  .capabilities                 ← discovered from initialize
  .configOptions                ← discovered from session (Map)
  .prompt(text, handlers?)      ← main entry point
  .interrupt({ clearQueue? })   ← cancel in-flight prompt
  .authenticate(opts)           ← caller-driven auth
  .setConfig(configId, value)
  .reconnect()                  ← respawn + initialize + session/load
  .stop()                       ← kill the process
```

`AcpClient` constructor holds everything about *how to spawn and configure the
process*. `connect()` holds everything about *this particular session*.

---

## Lifecycle

### Construction (sync)
`new AcpClient(config)` stores config only. **No process is spawned.**

### connect() (async, explicit)
Chosen over lazy/auto-connect and over async-in-constructor (factory pattern).
Rationale: the caller wants to inspect `capabilities` *before* prompting (e.g. "does
this agent support fs?", "what auth methods exist?"). Lazy init can't offer that
without triggering a prompt.

`connect()` performs, in order:
1. spawn the subprocess (`[...execPrefix, ...adapter.command]`)
2. `initialize` → populates `capabilities`
3. `session/new` (or `session/load` if `sessionId` given) → populates `configOptions`

By the time `connect()` returns, the client is fully ready: capabilities known,
session active, config options known. `session/new` lives in `connect()` (not in
`prompt()`) so there's no awkward half-ready state where capabilities exist but config
options don't.

```ts
const client = new AcpClient({ adapter: ADAPTERS.kimi })
const { resumed, sessionId } = await client.connect()
client.capabilities          // available now
client.configOptions         // available now
```

---

## Adapters

The adapter carries **only what's needed to start** the connection — the command.
Auth methods, capabilities, and features are NOT on the adapter; they come from
`initialize`.

```ts
const ADAPTERS = {
  kimi:   { command: ["kimi", "acp"] },
  claude: { command: ["claude-agent-acp"] },
  codex:  { command: ["codex-acp"] },
}
```

`ADAPTERS.*` are convenient presets. The caller can also pass a raw adapter inline:

```ts
new AcpClient({ adapter: { command: ["my-custom-acp"] } })
```

### Exec prefix (Docker etc.)
The adapter owns its command; the *client* owns the prefix. Merged at spawn time as
`[...execPrefix, ...adapter.command]`. The adapter doesn't know or care how it's
executed.

```ts
new AcpClient({
  adapter: ADAPTERS.kimi,                                  // ["kimi","acp"]
  execPrefix: ["docker", "exec", "-i", "container-name"],  // → docker exec -i container-name kimi acp
})
```

---

## Capabilities

Reflect the protocol's nested structure directly. Do not flatten — the nesting maps
cleanly to what UIs need to check.

```ts
client.capabilities.agent.loadSession
client.capabilities.agent.promptCapabilities.image
client.capabilities.agent.promptCapabilities.audio
client.capabilities.agent.promptCapabilities.embeddedContext
client.capabilities.agent.mcpCapabilities.http
client.capabilities.agent.mcpCapabilities.sse
client.capabilities.agent.auth.logout                     // null → hide logout button
client.capabilities.agent.sessionCapabilities.delete
client.capabilities.agent.sessionCapabilities.additionalDirectories
client.capabilities.agent.authMethods                     // from initialize response

client.capabilities.client.fs.readTextFile
client.capabilities.client.fs.writeTextFile
client.capabilities.client.terminal
```

A `null`/omitted capability means **unsupported** (per spec: omitted == unsupported).
This is what lets the caller gate UI/behavior in advance instead of failing at call
time — the central value proposition of the introspection-first design.

---

## Prompting

`prompt()` is the main entry point. It returns a single `PromptResult` when the agent
finishes, but exposes real-time streams via handler callbacks.

```ts
const result = await client.prompt("hello", {
  onChunk: (text) => process.stdout.write(text),   // agent_message_chunk (response text)
  onActivity: (event) => { ... },                  // thought chunks, tool calls, plan, etc.
  onPermissionRequest: (request) => {              // session/request_permission (blocking)
    return { outcome: "selected", optionId: "approve" }
  },
})
```

- **`onChunk`** — partial response text (`agent_message_chunk`) as it streams.
- **`onActivity`** — observation-only events: `agent_thought_chunk`, `tool_call`,
  `tool_call_update`, `plan`. Fire-and-forget; the caller renders them if it wants.
- **`onPermissionRequest`** — a *request*, not an observation. The agent **blocks**
  until the client responds. Must return an outcome. If not provided, the library
  falls back to `defaultPermission` ("approve" or "cancel").

### PromptResult

```ts
interface PromptResult {
  text: string         // accumulated response (partial if cancelled)
  stopReason: string   // "end_turn" | "cancelled" | "max_tokens" | ...
  status: "completed" | "cancelled" | "error"
  usage: Usage | null
}

interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  thoughtTokens?: number   // only providers that do extended thinking
}
```

`usage` is nullable — not all providers send it. `status` carries cancel/error state so
the caller can react (mark as not-delivered, errored, etc.) — but interpreting it is the
caller's concern.

---

## Cancellation & queuing

- Concurrent `prompt()` calls **queue** and run in order.
- `client.interrupt()` cancels the **current** in-flight prompt. `prompt()` then
  **resolves** (not rejects) with `status: "cancelled"` and whatever partial text
  arrived before the interrupt.
- `client.interrupt({ clearQueue: true })` also drops queued prompts.

How the interrupt reaches the agent is provider-specific. The library tries, in order:
1. ACP `session/cancel` (baseline — all agents MUST support it)
2. A slash command like `/stop`
3. Kill + restart the process (last resort)

The caller defines the user-facing trigger (ESC key, `/stop`, button) — the library
just exposes `interrupt()`.

---

## Authentication

ACP gives **no way to check auth state**. There is no `whoami`. State is fully opaque
until something breaks:
- **Kimi**: silent failure — `stopReason: "end_turn"` with empty content, no error.
- **Others**: typically a `-32000` error on prompt/initialize.

So the library never auto-authenticates. It surfaces the result and the caller decides:

```ts
const result = await client.prompt("hello")
if (result.text === "" && result.stopReason === "end_turn") {
  // probably not authenticated — caller handles it
}
```

### Auth methods (from `initialize`)

```ts
client.capabilities.agent.authMethods
// [
//   { id: "api_key",     kind: "api_key",          label, envVar },
//   { id: "device_code", kind: "terminal_command", label, command: [...] },
//   { id: "tty",         kind: "tty",              label },
// ]
```

By `kind`:
- **`api_key`** — library calls `authenticate` with the key directly.
- **`terminal_command`** — library spawns the command, streams output via `onOutput`,
  waits for exit. Covers OAuth/device-code flows (e.g. ChatGPT/Codex account login):
  the command prints a URL + code, polls in the background, saves credentials on
  approval. No browser automation — the library just runs the process and relays output.
- **`tty`** — the ONLY kind the library genuinely cannot handle (needs stdin attached to
  a real terminal). Surfaced so the caller can instruct the user.

```ts
await client.authenticate({ methodId: "api_key", value: "sk-..." })

await client.authenticate({
  methodId: "device_code",
  onOutput: (line) => console.log(line),   // "Visit https://... enter code ABC-123"
})
```

> Note: some implementations accept `authenticate` over ACP but do nothing (Kimi returns
> `{}` without authenticating). Storing credentials and the try-and-see flow is the
> safest workaround while the ecosystem matures.

### Logout
Exposed only if `capabilities.agent.auth.logout` is non-null.

---

## Sessions

### Persistence
Session files live in `sessionsDir`, named by `sessionId`:

```
sessions/
  94b5204d-7dd9-4df2-977e-cbccc99c8218.json
  a1b2c3d4-....json
```

Each file holds enough to identify and sort it:
```ts
{ sessionId, adapter: "kimi", createdAt, lastUsedAt }
```

The library is NOT the source of truth for sessions — the ACP implementation (and its
own files) are. Agents can update them at any time. The library just reads/writes these
small metadata files and updates them on `connect()`.

### Load vs new
`connect({ sessionId })` tries `session/load`. On failure, falls back to `session/new`.
The result reports which happened:

```ts
const { resumed, sessionId } = await client.connect({ sessionId: "94b5204d..." })
// resumed: true  → resumed successfully
// resumed: false → load failed, fresh session started
```

Omitting `sessionId` → always a fresh session. Specifying it is explicit and valuable;
the library does not scan/guess by default. (A `resumeLatest` option to load the most
recently-modified file is deferred — silently loading a random session is surprising.)

### Standalone session ops
`session/list` and `session/delete` need no live connection — they're filesystem ops:

```ts
listSessions(sessionsDir)                 // → metadata[]
deleteSession(sessionsDir, sessionId)
```

(`session/delete` over the protocol is gated by
`capabilities.agent.sessionCapabilities.delete`.)

---

## Config options (models, reasoning effort, etc.)

Never hardcode model names or option values. Store the raw config options from the
session as a map keyed by `configId`:

```ts
interface ConfigOption {
  configId: string
  label?: string
  description?: string
  currentValue: unknown
  allowedValues?: Array<{ value: unknown; label?: string; description?: string }>
}

client.configOptions   // Map<string, ConfigOption>
```

```ts
client.configOptions.get("reasoning_effort")
// { currentValue: "medium", allowedValues: ["low","medium","high","xhigh"], ... }

for (const opt of client.configOptions.values()) { /* build a settings UI */ }

await client.setConfig("reasoning_effort", "high")
```

> Protocol note: the set call uses `configId` (not `id`). The SDK method is
> `setSessionConfigOption`.

---

## MCP servers
Passed to `connect()`, since that's where `session/new` happens (MCP servers are bound
at session creation):

```ts
await client.connect({ mcpServers: [...] })
```

Transport support is discoverable: `capabilities.agent.mcpCapabilities.http` / `.sse`.

---

## Process crashes

If the process dies mid-prompt, `prompt()` **rejects** with `ProcessCrashError`. The
library does NOT auto-restart — a crash may be a real symptom (bad auth, OOM,
misconfiguration) that silent restarts would hide. Recovery is made easy but kept
caller-driven:

```ts
try {
  await client.prompt("hello")
} catch (err) {
  if (err instanceof ProcessCrashError) {
    await client.reconnect()        // respawn + initialize + session/load
    await client.prompt("hello")    // caller retries
  }
}
```

---

## Protocol facts worth remembering

- **All agent→client events are `session/update` notifications**, discriminated by the
  `sessionUpdate` field (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
  `tool_call_update`, `plan`, `usage_update`, etc.).
- **`session/request_permission` is a REQUEST (has an `id`)** — the agent blocks until
  the client responds with the same `id`. Notifications have no `id` (fire-and-forget).
  The `id` value is arbitrary but the response MUST echo it; the SDK handles this.
- **`tool_call_update` streams the CUMULATIVE tool input** (the whole JSON so far on
  every tick), not deltas — O(n²) bytes for large inputs. Only the final update
  (`status: "completed"`) is the stable, useful one; intermediate ones are live preview.
- **`plan` (sessionUpdate) is SHOULD, not MUST.** Providers may ignore it entirely
  (Kimi just wrote a `PLAN.md` file via a normal tool call instead of emitting the
  structured `plan` notification). The library handles `plan` if it arrives but must not
  depend on it; planning is more reliably driven via prompts.
- **Thought streaming varies by provider.** Kimi streams `agent_thought_chunk`;
  GPT/Codex models only report `thoughtTokens` in final usage.
- **No guaranteed error signal.** Absence of error does not mean success (see auth).
