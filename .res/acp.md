


Here's a structured digest of all 18 pages:

---

## ACP Protocol v1 — Full Overview

### Transport & Wire Format
- **stdio** is the recommended transport: agent runs as a subprocess, communicates via stdin/stdout, newline-delimited JSON-RPC 2.0 messages.
- **Streamable HTTP** is a draft/WIP.
- Custom transports are allowed but must stay JSON-RPC compliant.
- stderr is for logging only.

---

### Lifecycle (3 phases)

**1. Initialization** (`initialize`)
- Client sends: protocol version (int), capabilities, name/version.
- Agent responds: chosen protocol version, capabilities, name/version.
- Version negotiation: agent picks; client disconnects if incompatible.
- Capabilities are optional — omitted = unsupported. Adding capabilities is non-breaking.

**2. Authentication** (`authenticate` / `logout`)
- Agent advertises `authMethods` in init response.
- Client calls `authenticate` with a chosen `methodId`.
- Logout is optional; advertised via `agentCapabilities.auth.logout`. Post-logout session behavior is implementation-defined.

**3. Session lifecycle**
- `session/new` — create with `cwd` + MCP server list → returns `sessionId`.
- `session/load` — replay full history via `session/update` notifications (requires `loadSession` capability).
- `session/resume` — reconnect without replay (requires `sessionCapabilities.resume`).
- `session/close` — cancel ongoing work, free resources.
- `session/list` — paginated (cursor-based), filterable by `cwd`. Push updates via `session_info_update`.
- `session/delete` — remove from history; idempotent (deleting nonexistent = success).

---

### Prompt Turn (`session/prompt`)
A turn = user message → LLM → tool calls (loop) → stop reason.

**Stop reasons:** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.

**Cancellation:** client sends `session/cancel` → agent aborts LLM + tools → responds with `cancelled`.

**Agent streams progress via `session/update` notifications:**
- Plans (step list, each with priority + status)
- Message chunks (text streamed)
- Tool calls
- Usage/cost updates

---

### Content Blocks
Used in prompts, LLM output, and tool results. Same structure as MCP `ContentBlock`.
- `text` — always required
- `image` — base64, requires `image` capability
- `audio` — base64, requires `audio` capability
- `embeddedResource` — full file content inlined
- `resourceLink` — reference only (MIME, size, description)

---

### Tool Calls
Reported via `session/update`. Fields: `toolCallId`, `title`, `kind`, `status`, `content`, `locations`, `rawInput/rawOutput`.

**Kinds:** `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`.

**Status lifecycle:** `pending` → `in_progress` → `completed` / `failed`.

**Permission requests:** agent calls `session/request_permission` → client shows user options (`allow_once`, `reject_once`, etc.) → client responds with choice.

---

### File System (client-side methods)
Agent calls these on the client:
- `fs/read_text_file` — absolute path, optional line/limit (1-based). Returns unsaved editor buffer too.
- `fs/write_text_file` — creates file if missing.
Both require `clientCapabilities.fs` to be declared.

---

### Terminals (client-side methods)
- `terminal/create` — starts command, returns `terminalId`, non-blocking.
- `terminal/output` — poll output.
- `terminal/wait_for_exit` — block until done.
- `terminal/kill` — terminate process (terminal stays usable).
- `terminal/release` — **must be called** when done; frees resources.
Requires `clientCapabilities.terminal`.

---

### Agent Plan
Sent via `session/update`. Each update = **full replacement** of the plan (not a diff).
- Entries: `content` (human-readable), `priority` (high/medium/low), `status` (pending/in_progress/completed).
- Plans can evolve mid-execution (add/remove/modify steps).

---

### Session Modes & Config Options
- **Modes** (legacy): agent returns available modes + current mode in session setup. Client switches via `session/set_mode`; agent can push `current_mode_update`.
- **Config Options** (new, replaces modes): more flexible — `select` type with id/name/category/currentValue/options. Categories: `mode`, `model`, `thought_level`, custom (`_`-prefixed). Client sets via `session/set_config_option`; agent pushes `config_option_update`.

---

### Slash Commands
Agent sends `available_commands_update` after session creation. Commands have `name`, `description`, optional `input.hint`. Dynamic — list can change anytime. Invoked as text in regular prompts (e.g. `/web search term`).

---

### Extensibility
- `_meta` field on any object for custom data (W3C trace context keys reserved at root).
- Custom methods prefixed with `_` (requests need `id`, notifications don't).
- Custom capabilities advertised via `_meta` in capability objects during init.
- Unknown notifications must be silently ignored; unknown methods return `-32601`.

---

### Schema
Full JSON schema downloadable from GitHub releases. Core agent methods: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel`. Core client methods: `fs/read_text_file`, `fs/write_text_file`, `session/request_permission`, `session/update`, terminal methods.

---

That's the full protocol. Ready whenever you want to start designing the library.