The full spine works end-to-end against the real Kimi agent. The response text `hello from acp-lib` came back clean on stdout, with thinking chunks streaming via `onActivity` along the way.

## What's built and validated

The complete happy path from `SPEC.md`, exercised against Kimi-in-Docker:

```
new AcpClient(config)
  → connect()            spawn (docker exec) → initialize → session/new
       ✓ capabilities parsed   (loadSession=true, image=true)
       ✓ configOptions map     (kimi returned none this session — discovered, not assumed)
  → prompt()             streaming chunks + activity, returns PromptResult
       ✓ onActivity fired thinking chunks live
       ✓ response text accumulated → "hello from acp-lib"
       ✓ status=completed
  → stop()
```

Typecheck is clean (`tsc --noEmit` passes under strict).

## Structure as scaffolded

```
src/
  index.ts             ← public barrel (core only — never references degraded/parser)
  agent-client.ts      ← AgentClient interface (shared output contract)
  client.ts            ← AcpClient (core, implemented)
  types.ts adapters.ts capabilities.ts config-options.ts updates.ts sessions.ts errors.ts
  transport/
    acp-transport.ts   ← the ONLY SDK-touching, process-spawning module (implemented)
  degraded/            ← subpath acp-lib/degraded (skeleton, throws "deferred")
    index.ts pty-client.ts
  parser/              ← subpath acp-lib/parser (skeleton)
    index.ts types.ts ollama.ts
  cli/
    index.ts           ← thin consumer, imports the public barrel
```

The three doors are wired in `package.json` exports (`.`, `./degraded`, `./parser`), `node-pty` is an optional dependency, and the core barrel doesn't reference the heavy subpaths — so `import { AcpClient } from "acp-lib"` stays clean and embeddable.

## What's deliberately not done yet (deferred per spec)

- **Auth** (`authenticate()` / terminal-command + PTY flows) — `auth.ts` not created yet; transport has the `authenticate` pass-through ready
- **Session persistence wiring** — `sessions.ts` standalone fns exist, but `connect()` doesn't yet read/write `sessionsDir` (resume currently works only via explicit `config.sessionId`)
- **`reconnect()`** after crash
- **Degraded mode + SML** — skeletons only
- **Tests** — validated by hand via CLI; no `test/` suite yet

Natural next slice would be auth (the `api_key` path is trivial via the transport; terminal-command reuses the PTY primitive) or wiring `sessionsDir` persistence into `connect()`. Which way do you want to go?







----





Self-reference resolves correctly: `import { runRepl } from "acp-lib/repl"` and `import { AcpClient } from "acp-lib"` both work. That's exactly how the orchestration lib will consume them once `acp-lib` is a dependency.

## Where this leaves you

You can drop the orchestration lib's REPL entirely. Its terminal "direct" path becomes:

```ts
import { AcpClient } from "acp-lib";
import { runRepl } from "acp-lib/repl";

const client = new AcpClient({ adapter, execPrefix, cwd, logger });
await client.connect();
try {
  await runRepl(client, {
    verbose,
    intro,
    onSlashCommand: (cmd, args) => {
      // orchestration-specific: /new, /switch, /model ...
      // return true if handled, false to send as a normal prompt
    },
  });
} finally {
  await client.stop();
}
```

The two things that made this consumable:

1. **`acp-lib/repl` is now a real importable subpath** — separate from the `./cli` executable. The orchestration lib imports `runRepl` directly; you maintain it here, improve it once, both consumers benefit.

2. **`onSlashCommand` extension seam** — the orchestration lib adds its own commands (`/new`, `/switch`, `/model`) without forking the loop. Unknown commands fall through to a normal prompt. The CLI here dogfoods it with `/help`, `/caps`, `/session`.

And because `runRepl` targets the `AgentClient` interface, the same loop will drive `PtyClient` (your "attach" mode) when that's built — still one REPL.

The hub (web/telegram) stays as-is structurally but swaps its ACP plumbing for `AcpClient`, driving `prompt()`/`onChunk` into its own I/O — it does *not* go through `runRepl`, since its loop is event-driven, not line-based.

Want me to wire `sessionsDir` persistence next (so `/new` and resume-by-id have something to work with), or sketch the hub-side `AcpClient` usage so you can diff it against your current plumbing?