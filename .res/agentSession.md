Good moment to reopen it — before there are consumers to break, and now that we have real usage data instead of speculation. Let me reason it from scratch.

## Is there a case now? Yes — and it's different from when we deferred it

When we parked `AgentSession`, the only justification was multi-LLM, and I argued the controller sufficed for one agent. But the last few sessions surfaced **three concrete, single-agent drivers** that the controller is structurally wrong for:

1. **Cross-adapter session catalog.** A `sessionId` is meaningless without knowing *which adapter* it belongs to. `loadSession` must be called on the *right* agent. The agent's own `session/list` only knows its own sessions (and kimi's is broken). Nothing in the current design records "session X is a kimi session in cwd Y." The hub will have 50 sessions across kimi/codex/claude and no way to route them.

2. **Persistence resilience.** kimi just proved an agent's `list` can't be trusted. You're already reduced to remembering ids from `/new`. We need *our own* catalog.

3. **Front face.** You're right that `AgentController` is the wrong face. It's **connection-centric** — "I hold one live leaf and swap it." The hub doesn't think in connections; it thinks in *conversations*: create one, prompt it, list them, resume one. That's a different noun.

Plus your timing argument is correct: get the front face right *now*, pre-adoption.

## The clean split (non-hollow)

The test for "is this a real layer or just passthrough" is whether each owns things the other shouldn't. It does — because there are genuinely two concepts:

**`AgentController` = live control plane (ephemeral).** One live connection. Stays oblivious to persistence and to "what sessions exist."
- `prompt`/`interrupt`/`stop`, mode degrade↔upgrade, `bridge`, `login`/`authenticate`
- live `capabilities`/`configOptions`/`agentCommands` of the *current* connection
- the protocol session ops on the live connection (`new`/`load`/`resume`/`fork`)

**`AgentSession` = durable conversation + front face.** What the hub holds.
- identity: `sessionId`, `adapter`, `mode`, `cwd`, `title`, metadata
- delegates prompt/stream to its controller; can (re)build the controller and load into the *right* adapter
- records itself; "resume conversation X" = look up its adapter → spin a controller → load

**`SessionManager` = the catalog/store.** Disk records `{id, adapter, mode, cwd, title, time}`. `list` merges *our* catalog with the agent's live list, so a broken/empty agent `list` no longer blinds you.

So your instinct is right: **`AgentSession` owns sessions; `AgentController` becomes an internal detail oblivious to all of it.** It's not hollow — `AgentSession` owns identity, catalog, and cross-adapter restore, none of which belong in a connection driver.

One simplification this unlocks: **adapter-switching should move OFF the controller.** Switching kimi→codex can't continue a conversation anyway (different process/session), so it's really "open a different `AgentSession`." That makes `AgentController` tie to *one* adapter (just mode-swap within it) — noticeably simpler.

## The one real scope fork

How ambitious is `AgentSession`'s identity?

- **(a) Bound to one underlying agent session** — one adapter/mode. Switching either starts a new `AgentSession`. Solves drivers 1–3 cleanly. Achievable now.
- **(b) Portable conversation** — `AgentSession` holds the *canonical* history and can re-materialize it on any adapter/mode (loadSession when same agent; replay-as-context when crossing agents). This is the "export context to a new session" vision — genuinely powerful for the hub (swap model mid-conversation, keep context), but cross-agent transfer is lossy and a real project.

My recommendation: **build (a) now, architect so (b) slots in later.** Make `AgentSession` the durable front face with a `SessionManager` catalog, keep the canonical-history hooks in mind, but don't commit to cross-agent context transfer yet. That fixes the front face and the kimi/catalog problems immediately without a research project.

Two decisions I need from you before sketching it concretely:
1. **Scope**: minimal (a) now, or are you set on building toward (b) from the start?
2. **Adapter-switching**: agree it moves up (switch = open a different session, controller becomes single-adapter), or do you want the controller to keep multi-adapter switching?









All three are right, and "portability is just more sophisticated logic, never breaking" is exactly the freedom we want — it lets us build the simple version now without painting ourselves in. Quick yeses, then the things that *will* bite if we don't decide them up front.

**Your three, confirmed:**
- **`AgentSession implements AgentClient`** — yes, definitely. Then the REPL (and the hub) target `AgentClient` and `AgentSession` just *is* one; it delegates `prompt`/`interrupt`/`stop` down to its controller. Every layer implementing the same promptable seam is a feature, not a smell.
- **Adapter moves to the session level** — yes. `AgentController` becomes single-adapter (keeps mode-swap, loses `switchAdapter`). Switching adapter = open a different `AgentSession`. Simpler controller, correct semantics ("the agent dies on switch").
- **`SessionManager` + configurable `sessionsDir`** — yes, and it's the right size: a catalog, not a database.

## Three refinements that keep (b) non-breaking and handle reality

**1. Decouple *our* id from the *agent's* `sessionId`.** This is the one that, if skipped, makes portability a breaking change later. The agent's `sessionId` is unstable as a catalog key: it's **null in degraded mode**, and it **changes on every mode-swap** (the pty session ≠ the ACP session). So `AgentSession` mints **its own stable id** (a uuid) as the catalog key, and tracks `agentSessionId` as a mutable *field* alongside `adapter`/`mode`. Today one `AgentSession` ↔ one `agentSessionId`; tomorrow (b) one `AgentSession` ↔ many agent sessions across adapters — and the catalog schema doesn't change. Small cost now, no migration later.

**2. The catalog stores *routing/metadata*, not conversation content.** The agent already persists the transcript (that's why `loadSession` replays it). So `SessionManager` records `{ourId, adapter, mode, cwd, title, agentSessionId, createdAt, updatedAt}` — the stuff the agent *can't* tell you, especially **which adapter owns a session**. And `list()` **merges** our catalog with the live agent list (when it works), so you see both the sessions we created *and* ones made via the native CLI/bridge — and a broken kimi `list` no longer blinds you. (Storing actual transcripts is a (b) concern — defer.)

**3. Make the store pluggable, not just file-backed.** The hub will almost certainly want DB-backed sessions, not files on disk. So: a small `SessionStore` interface (`save`/`get`/`list`/`delete`), with a default `FileSessionStore({ dir })` — and `sessionsDir` configures *that*. Default something like `~/.acp-lib/sessions` (or honor `XDG_STATE_HOME` if you like), fully overridable. Same injection philosophy as the logger/parser. The hub hands in its own store; the CLI uses the file one.

## One caveat worth naming
The catalog is most meaningful for **ACP** sessions (real `agentSessionId` → `loadSession` resumes them). **Degraded** sessions have no protocol id we hold (kimi shows one in its banner, but we'd have to scrape it), so we can *record* that a degraded session happened but **resume is best-effort** — realistically you re-enter via `/bridge`. Fine for now; just don't promise resumable degraded sessions.

## Build order (incremental, each step compiles)
1. `SessionStore` interface + `FileSessionStore` + `SessionManager` (catalog logic + merge). No wiring yet.
2. `AgentSession` (owns id/adapter/mode/metadata, holds an `AgentController`, implements `AgentClient`, writes to `SessionManager`).
3. Strip `switchAdapter` from `AgentController` → single-adapter.
4. CLI switches to `AgentSession` as the front face; `/sessions` merges catalog + live; `/switch` opens a new session.

That's the whole thing, and none of it forecloses portability. Anything you'd change — naming (`AgentSession` vs `Conversation`?), the default dir, or the store interface shape — or should I start at step 1?








Let me clarify #3, since that's the only fuzzy one — the rest we're aligned on.

## What "pluggable store" means (#3)

Right now the plan is "write a registry file under `sessionsDir`." Pluggable means: instead of `SessionManager` *hardcoding* "read/write JSON on disk," we put a tiny interface between them:

```ts
interface SessionStore {
  save(record): Promise<void>;
  get(id): Promise<SessionRecord | null>;
  list(): Promise<SessionRecord[]>;
  delete(id): Promise<void>;
}
```

The library ships **`FileSessionStore`** (the default — reads/writes a registry file under `sessionsDir`), and `SessionManager` talks only to that interface. That's it. The CLI just uses the file one and you'd never notice the seam.

**Why it matters specifically for the hub:** the orchestration lib already has a database (users, conversations, etc.). It does *not* want acp-lib writing a parallel JSON registry to `~/.acp-lib` that it then has to keep in sync. It wants acp-lib to read/write sessions *through its own storage*. With the interface, the hub passes `new DbSessionStore(...)` and sessions live in its DB — **zero library changes**. Without it, the hub is stuck syncing two sources of truth.

It's the exact same pattern as the injected `Logger`: library defines the interface + a default, the consumer can swap it. And it directly serves your "the location should be modifiable" requirement — `sessionsDir` modifies *where the file store writes*; the interface lets you replace the file store entirely.

My recommendation: **define the interface now** (it's ~4 methods, trivial) and ship `FileSessionStore` as default. Extracting it later is also non-breaking, but since the interface *is* the boundary we're building, doing it now costs nothing and the hub gets the seam for free.

## Confirmations
- **Content storage**: agreed — catalog/registry only for now (`{sessionId, agentSessionId, adapter, mode, cwd, title, timestamps}`), and the record shape leaves an obvious slot to add transcript storage later without breaking. Good call not to depend on a 3rd party for that yet.
- **Degraded resume**: agreed — record that it happened, defer reliable resume (the id-retrieval problem). The SessionManager direction doesn't make it harder, so we lose nothing by deferring.

So the registry default is a single file (e.g. `sessions.json`) holding the records, behind `FileSessionStore`, behind the `SessionStore` interface.

If that lands right, I'll start at **step 1**: `SessionStore` + `FileSessionStore` + `SessionManager` (record shape, CRUD, and the catalog↔live-list merge), no wiring into `AgentSession`/CLI yet — so we can review the storage layer in isolation before building on it. Good to go?






































Step 1 done — the storage layer, in isolation as planned. Here's what's there to review before we build on it:

**`session-store.ts`**
- **`SessionStore`** interface (`save`/`get`/`list`/`delete`) — the pluggable seam, so the hub injects its own DB-backed store.
- **`FileSessionStore`** — the default: one `<id>.json` per record under `sessionsDir` (default `~/.acp-lib/sessions`, overridable). `defaultSessionsDir()` exported.
- **`SessionRecord`** — the key design call made concrete: our stable **`id`** (catalog key) is decoupled from the mutable **`agentSessionId`** (null in degraded, changes on mode-swap). Plus `adapter`/`mode`/`cwd`/`title`/timestamps. **Routing metadata only**, with a commented slot where transcript storage drops in later without a schema break.

**`session-manager.ts`**
- Catalog CRUD with managed timestamps (upsert preserves `createdAt`).
- **`mergeSessions()`** (pure, exported for testing) — unifies our catalog with the agent's live `session/list`, tagging each row `catalog | agent | both`. This is what makes a broken kimi list survivable and surfaces externally-created sessions.

Removed the old `sessions.ts`; barrel re-exports the new surface; typecheck clean; the test above exercises CRUD + all three merge cases.

A couple of small decisions baked in that you might want to weigh in on:
- **Default dir** = `~/.acp-lib/sessions` (simple, conventional). I considered `$XDG_STATE_HOME/acp-lib` — happy to switch if you prefer the XDG convention.
- **File-per-session** rather than one `registry.json` — more robust to concurrent writes and partial updates, at the cost of "it's a directory, not a single file." Matches the old approach. Say the word if you'd rather have a single registry file.

If the storage layer looks right, I'll move to **step 2: `AgentSession`** — owns the id/adapter/mode identity, holds an `AgentController`, implements `AgentClient`, and writes through the `SessionManager`. Want any changes here first, or go?


