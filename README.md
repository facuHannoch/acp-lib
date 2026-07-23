# @qlairoslabs/acp-client

An embeddable, model-agnostic **Agent Client Protocol (ACP)** client: talk to AI coding
agents (Codex, Claude, Kimi, Gemini, Copilot, OpenCode, …) over JSON-RPC 2.0, with a
**degraded PTY fallback** for agents that don't speak ACP.

```ts
import { AgentController, ADAPTERS } from "@qlairoslabs/acp-client";

const agent = new AgentController({ adapter: ADAPTERS.codex, adapterId: "codex" });
await agent.start();
const { text } = await agent.prompt("Say hello in one sentence.");
console.log(text);
await agent.stop();
```

> **Runtime:** this package currently requires **[Bun](https://bun.sh) ≥ 1.3.5**.
> The transport layer is built on `Bun.spawn`. Node support is planned (see
> [Roadmap](#roadmap)); the spawn layer is already isolated behind a single module to make
> that a drop-in addition.

---

## Why this exists

ACP is a clean, model-agnostic way to drive coding agents, but the existing clients make
assumptions that don't fit when you orchestrate **many** agents across **many**
environments:

- **No forced `cwd` discovery.** Other libraries crawl up to the git root and impose a
  working directory. This one takes `cwd` (and an `execPrefix` like `docker exec -i …`) as
  plain config, so you can talk to agents inside containers or arbitrary runtimes.
- **Introspection over hardcoding.** Models, auth methods, capabilities, and config
  options are all *discovered* from the protocol at runtime, never baked in. The library
  surfaces raw protocol facts and lets you decide what they mean.
- **A fallback for agents that don't fully support ACP.** Some providers lack crucial
  operations (e.g. `login`), and some only expose ACP through an SDK that breaks
  subscription-based auth. For those, a **degraded mode** drives the agent's native
  interactive CLI through a PTY and parses the terminal output. It's expected to work worse
  than real ACP (hence "degraded") but it keeps the same output contract so your
  rendering code doesn't change.

---

## Install

```bash
# as a dependency in a Bun project
bun add @qlairoslabs/acp-client

# or for the CLI, globally
bun add -g @qlairoslabs/acp-client
```

---

## Core concepts

| Abstraction | What it is |
|---|---|
| **`AgentController`** | The control plane for **one** agent process: start/stop, prompt, interrupt, switch sessions, swap mode (normal ⇄ degraded), introspect capabilities & config. |
| **`AgentSession`** | A **durable conversation** with a stable identity that survives reconnects and mode-swaps. Wraps an `AgentController` and (optionally) records itself to a catalog. The front face for consumers that want persistence. |
| **`SessionManager` + `SessionStore`** | The session **catalog**: routing metadata (which adapter/mode/cwd a session belongs to), *not* conversation content. Merges your catalog with the agent's live `session/list`. Ships a `FileSessionStore`; inject your own (e.g. a database) for custom backends. |
| **Adapter** | Just how to *launch* an agent: the spawn command. `ADAPTERS` has presets (`codex`, `claude`, `kimi`, `gemini`, `copilot`, `opencode`); you can also pass a raw `{ command: [...] }`. |
| **Mode** | `"normal"` (real ACP over JSON-RPC) or `"degraded"` (drive the native CLI through a PTY and parse it). Both implement the same `AgentClient` output contract. |

---

## Usage

### One-shot prompt

```ts
import { AgentController, ADAPTERS, createConsoleLogger } from "@qlairoslabs/acp-client";

const agent = new AgentController({
  adapter: ADAPTERS.codex,
  adapterId: "codex",
  cwd: process.cwd(),
  defaultPermission: "cancel",          // "approve" to auto-accept tool permissions
  logger: createConsoleLogger({ minLevel: "info" }),
});

const { sessionId, resumed } = await agent.start();
console.log(resumed ? "resumed" : "new", sessionId);

const result = await agent.prompt("Refactor utils.ts for readability.");
console.log(result.text, result.stopReason, result.usage);

await agent.stop();
```

### Streaming activity (thinking / tool calls)

```ts
await agent.prompt("Find and fix the failing test.", {
  onChunk: (text) => process.stdout.write(text),         // response text as it streams
  onActivity: (event) => console.error("·", event.type), // thinking / tool calls / plan
  onPermissionRequest: (req) => ({ outcome: "selected", optionId: req.options[0].optionId }),
});
```

If you omit `onPermissionRequest`, the client falls back to the controller's
`defaultPermission` (`"approve"` / `"cancel"`).

### Durable sessions with a catalog

`AgentSession` gives a conversation a stable id that persists across reconnects, and
records routing metadata so you can list and resume sessions later.

```ts
import {
  AgentSession,
  ADAPTERS,
  SessionManager,
  FileSessionStore,
} from "@qlairoslabs/acp-client";

const sessions = new SessionManager(new FileSessionStore()); // ~/.acp-lib/sessions

const session = await AgentSession.create({
  adapter: ADAPTERS.codex,
  adapterId: "codex",
  sessions,                 // ← records itself to the catalog on start & each prompt
});

await session.prompt("Start working on the auth module.");

// later. List everything we know about, catalog ∪ the agent's live list
for (const s of await session.listSessions()) {
  console.log(s.source, s.agentSessionId, s.title); // source: "catalog" | "agent" | "both"
}

await session.stop();
```

### Optional chat transcript

Pass `transcriptPath` to `AgentSession` to append a lightweight JSONL chat transcript
that can be read later without starting the agent. The transcript stores user messages
and final assistant replies only; tool calls, thinking, plans, and raw protocol replay
remain in the harness session.

```ts
import { AgentSession, ADAPTERS, readTranscript } from "@qlairoslabs/acp-client";

const session = await AgentSession.create({
  adapter: ADAPTERS.codex,
  adapterId: "codex",
  transcriptPath: "/absolute/path/to/chat.jsonl",
});

await session.prompt("Summarize the repo.");

const messages = await readTranscript("/absolute/path/to/chat.jsonl");
```

### Interactive REPL

The REPL and its slash-commands (`/help`, `/new`, `/sessions`, `/load`, `/config`,
`/degrade`, …) are reusable. Wire them to your own UI, or just run them.

```ts
import { runRepl, createAgentCommands } from "@qlairoslabs/acp-client/repl";
import { AgentController, ADAPTERS } from "@qlairoslabs/acp-client";

const agent = new AgentController({ adapter: ADAPTERS.codex, adapterId: "codex" });
const { sessionId, resumed } = await agent.start();

const commands = createAgentCommands({
  client: agent,
  note: (msg) => process.stderr.write(msg + "\n"),
  color: true,
  // sessionManager + adapterId here to persist /new, /load, /fork to a catalog
});

try {
  await runRepl(agent, {
    intro: `${resumed ? "resumed" : "new"} session ${sessionId}`,
    activity: true,
    spinner: true,
    onSlashCommand: commands.onSlashCommand,
  });
} finally {
  await agent.stop();
}
```

### CLI

A thin wrapper over the library is exposed as `acp-client`:

```bash
acp-client chat                       # new chat with the default adapter
acp-client chat <SESSION_ID>          # resume a session
acp-client chat --adapter codex       # pick an adapter
acp-client chat --exec "docker exec -i my-container"   # talk to an agent in a container
acp-client chat --cwd /workspace --approve             # auto-approve tool permissions
acp-client chat --degraded            # force degraded (PTY) mode
acp-client chat -v | -d               # verbose lifecycle / debug raw protocol
```

Activity markers (thinking/tool) show by default; `--no-activity` disables them.

---

## Package exports

The core barrel never pulls in `node-pty` / parsing deps. Degraded and parser support are
opt-in subpaths.

| Import | Contents |
|---|---|
| `@qlairoslabs/acp-client` | Core: `AgentController`, `AgentSession`, `AcpClient`, `SessionManager`, `FileSessionStore`, `ADAPTERS`, loggers, types. |
| `@qlairoslabs/acp-client/repl` | `runRepl`, `createAgentCommands` (interactive layer). |
| `@qlairoslabs/acp-client/degraded` | The PTY fallback transport (`Bun.spawn({ terminal })` + xterm parsing). |
| `@qlairoslabs/acp-client/parser` | Terminal-output parsers used by degraded mode. |
| `@qlairoslabs/acp-client/cli` | The CLI entry point. |

---

## Roadmap

- **Node runtime support.** The only Bun-coupled code is the transport layer
  (`src/transport/acp-transport.ts` and `src/degraded/pty-transport.ts`). Everything above
  it is runtime-agnostic, so Node support means adding sibling transports
  (`child_process.spawn` / `node-pty`) selected at runtime (no changes to the client),
  controller, sessions, or REPL.

---

## Development

```bash
bun install
bun run typecheck     # tsc --noEmit
bun test              # unit tests
bun run check         # typecheck + test
```

## License

[MIT](./LICENSE) © Facundo Hannoch
