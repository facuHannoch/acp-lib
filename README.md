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
  onActivity: (event) => render(event),                  // thinking / tool calls / plan / …
  onUpdate: (raw) => log(raw),                           // every raw session/update, unmapped
  onPermissionRequest: (req) => ({ outcome: "selected", optionId: req.options[0].optionId }),
});
```

If you omit `onPermissionRequest`, the client falls back to the controller's
`defaultPermission` (`"approve"` / `"cancel"`).

Every session update except the response text reaches `onActivity`, discriminated by
`kind`: `thinking`, `user_message`, `tool`, `tool_update`, `plan`, `plan_update`,
`plan_removed`, `commands`, `mode`, `usage`, `session_info`, `config`, and `unknown` for
anything the protocol adds later (the raw payload rides along on `raw`).

**Tool calls arrive incrementally.** Agents announce a call before they know much about it
and fill it in afterwards, so the command, the diff and the output usually land on a later
`tool_update` — not on the initial `tool`. `event.content` is where the output lives —
`{type:"content"}` (with `text` pre-extracted for text blocks), `{type:"diff"}`,
`{type:"terminal"}`, or `{type:"other"}` with the raw payload for shapes we don't model.

You don't have to merge that yourself. `onRecord` hands you **full state** on every event:

```ts
await session.prompt("Find and fix the failing test.", {
  onRecord: ({ current, emitted }) => {
    if (current) render(current.recordId, current.event);  // always complete, never a delta
    // `emitted` is the subset worth keeping: announced → input → settled
  },
});
```

`onRecord` is `AgentSession`-only, because the session runs exactly **one** aggregator for
its lifetime and that is what makes `recordId`s stable. Holding a raw `AcpClient`? Build one
aggregator per stream and feed it from `onActivity`:

```ts
import { ActivityAggregator } from "@qlairoslabs/acp-client/activity";

const agg = new ActivityAggregator();
onActivity: (event) => render(agg.apply(event));
```

If you do merge deltas by hand, two rules matter: absent fields mean *unchanged* (so
spreading is right), and `content`/`locations` **replace** the previous collection wholesale
— the schema says "replace the content collection", and agents that stream a growing tool
input resend the whole value each time.

### Sending activity over a wire

For a hub forwarding activity to a browser, send `wireFrames(result)` and fold with
`foldFrame`. Thinking crosses as a full record on the chunk that OPENS a block and as an
incremental `delta` for every chunk after it (re-sending the accumulated block per chunk is
quadratic — ~4 KB of text becomes ~800 KB over 400 chunks); everything else crosses as a
full record.

```ts
// hub
import { wireFrames } from "@qlairoslabs/acp-client/activity";
onRecord: (result) => {
  for (const frame of wireFrames(result)) socket.send(JSON.stringify(frame));
}

// browser
import { foldFrame, type AggregatedRecord } from "@qlairoslabs/acp-client/activity";
let records = new Map<string, AggregatedRecord>();
socket.onmessage = (e) => { records = foldFrame(records, JSON.parse(e.data)); };
```

Send `wireFrames(result)`, not `delta ?? current`, and don't reach past it into `result`:

- When a thinking block ends because a tool call started, that close rides in `emitted`
  while `current` is the tool — a client sending only the latter never learns the block
  finished and renders a bubble that never stops.
- `foldFrame` drops a delta whose base it has never seen (guessing at one is how you get
  text stitched onto the wrong block). `wireFrames` sends the base first, so that never
  happens on a subscriber who has been listening from the start.
- It never sends a record and a delta for the same `recordId` in one call. `foldFrame` has
  no seq guard, so a consumer would append the same text twice.

The `/activity` subpath has **no runtime imports**, so it is safe to pull into a browser
bundle. Type-only imports work anywhere today; importing the *functions* needs a bundler
that accepts `.ts` sources (Vite does; Next needs `transpilePackages`) since this package
ships source rather than a build.

A client that connects **mid-turn** needs the turn so far, or a thinking delta arrives with
nothing to append to. Subscribe first, then replay, then filter by `seq`:

```ts
const snap = session.activitySnapshot();     // { active, seq, records }
records = foldRecords(snap.records);
// then drop any streamed frame with frame.seq <= snap.seq — already reflected above
```

`seq` never restarts, so that threshold stays valid across turns. Before the first turn and
between turns `activitySnapshot()` reports `active: false` with no records: a settled turn
belongs to the transcript, not to a replay. `active` only knows what the aggregator has
been told — a hub that separately tracks which sessions are busy should trust itself.

### Debugging: the raw protocol

When an agent does something inexplicable, `wire` gives you every line in both directions,
verbatim — including the `session/update` notifications the transport takes off the wire
before the SDK sees them, which no other hook can observe.

```ts
import { createWireLog } from "@qlairoslabs/acp-client";

const session = await AgentSession.create({
  adapter: ADAPTERS.kimi,
  adapterId: "kimi",
  wire: createWireLog({ path: "/tmp/acp-wire.jsonl" }),   // or { console: "stderr" }
});
```

The file is ndjson, one `WireEntry` per line, truncated per run so a log is one run's:

```bash
# The conversation as a call sequence — the view that usually finds the problem
jq -r 'select(.dir!="err") | (.line|fromjson) as $m
       | [.dir, ($m.method // (if $m.error then "error" else "result" end)),
          ($m.params.update.sessionUpdate // "")] | @tsv' /tmp/acp-wire.jsonl | uniq -c
```

```
1 out  initialize
1 in   result
1 out  session/prompt
1 in   session/update            tool_call
161 in session/update            tool_call_update     ← one call, 161 resends
1 in   session/request_permission
1 out  result
1 in   fs/write_text_file
```

That `161` is real, from a Kimi run: agents resend the whole growing tool input on every
update, which is exactly what the activity fold exists to absorb.

`dir` is `out` (to the agent's stdin), `in` (from its stdout) or `err` (its stderr). `line`
is never reserialized, so what you read is exactly what crossed the pipe. Or from the CLI:

```bash
acp-client chat --wire                  # raw lines to stderr
acp-client chat --wire=/tmp/wire.jsonl  # ndjson to a file (usable during a real conversation)
```

Off unless you set it, and the library never enables it on its own: a wire log contains
everything the agent said, file contents and command output included.

### Terminals and filesystem access

The client advertises the `terminal` and `fs` client capabilities and implements them:
agents route their shell commands through `terminal/create` and read/write files through
`fs/read_text_file` and `fs/write_text_file` on us. Terminal tool calls carry only a
`terminalId` over the wire; the client resolves the live output before handing you the
event, so `content` entries of type `terminal` come with `output`, `truncated` and
`exitStatus` filled in.

Commands run as child processes of your app, with your environment. To opt out — letting
the agent fall back to its own implementation — turn the capability off, which also stops
us advertising it:

```ts
new AcpClient({
  adapter: ADAPTERS.codex,
  clientCapabilities: { terminal: false, fs: { writeTextFile: false } },
});
```

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

Pass `transcriptPath` or `transcriptDir` to `AgentSession` to append a lightweight JSONL
chat transcript that can be read later without starting the agent. `transcriptPath` is an
exact file path chosen by the caller; `transcriptDir` lets the library write
`<agentSessionId>.jsonl` inside that directory. Supplying both is a config error.

The transcript stores user messages and final assistant replies. Set
`transcriptActivity: true` to also record tool calls, thinking and plans as `t:"activity"`
lines — `readTranscript()` still returns messages only, so read those back with
`readTranscriptLines()`.

Activity lines are **settled records, not raw deltas**: the session folds the stream and
writes checkpoints, so one shell command costs ~3 lines instead of ~15. Each line is
self-contained, and `reason` (`announced` / `input` / `settled` / `flushed` / `snapshot`)
says where in its lifecycle it was. Read them back folded — the same `recordId` last-wins
rule the live stream uses, so a reload shows what was watched:

```ts
import { readActivityRecords, readTranscriptLines, toActivityRecord } from "@qlairoslabs/acp-client";

// just the activity state
const records = await readActivityRecords(path, { limit: 200 });  // newest 200, read backwards
for (const { recordId, reason, event } of records.values()) render(recordId, event);

// or interleave activity with messages on one timeline
for (const line of await readTranscriptLines(path, { limit: 200 })) {
  if (line.t === "msg") renderMessage(line);
  else if (line.t === "activity") renderActivity(toActivityRecord(line));
}
```

With a `limit`, the file is read **backwards from the end in chunks**, so the cost is
proportional to the page you asked for rather than to the transcript's size. Page back by
passing the oldest returned `ts` as the next `before`.

`limit` counts what you actually asked for, not raw lines — `readTranscript(path, {limit: 20})`
is twenty **messages**, however many activity lines sit between them. Narrow it yourself with
`types`, which is what makes the budget meaningful for an interleaved view:

```ts
// twenty things a chat UI would draw, with meta/raw noise excluded from the count
const page = await readTranscriptLines(path, { types: ["msg", "activity"], limit: 20 });
```

The trade-off: on an activity-heavy transcript, twenty messages may span thousands of
activity lines, so the read walks back further to find them — in the worst case to the start
of the file. Cap what gets written with `transcriptActivity: { maxBytes }` if that matters.

`t:"msg"` delimits a turn (`msg(user) → activity… → msg(assistant)`), so a trailing user
message with no reply after it means that turn died in flight — and `reason:"flushed"`
records what it was doing when it did. Pass an object instead of `true` to tune it:

```ts
transcriptActivity: {
  kinds: ["tool", "thinking"],   // default also includes plan, usage, mode, unknown
  checkpointOnInput: true,       // default: an extra line once a call knows its arguments
  rawOutput: false,              // default: it duplicates `content` byte for byte
  maxBytes: 64_000,              // default off: cap each string field, mark the line
}
```

```ts
import { AgentSession, ADAPTERS, readTranscript } from "@qlairoslabs/acp-client";

const session = await AgentSession.create({
  adapter: ADAPTERS.codex,
  adapterId: "codex",
  agentSessionId: "conv-123",
  transcriptDir: "/absolute/path/to/chats",
});

await session.prompt("Summarize the repo.");

const messages = await readTranscript("/absolute/path/to/chats/conv-123.jsonl");
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
acp-client chat -v | -d               # verbose lifecycle / debug payloads
acp-client chat --wire[=FILE]         # dump every raw protocol line (stderr, or ndjson to FILE)
```

Activity markers (thinking/tool) show by default; `--no-activity` disables them.

---

## Package exports

The core barrel never pulls in `node-pty` / parsing deps. Degraded and parser support are
opt-in subpaths.

| Import | Contents |
|---|---|
| `@qlairoslabs/acp-client` | Core: `AgentController`, `AgentSession`, `AcpClient`, `SessionManager`, `FileSessionStore`, `ADAPTERS`, loggers, types. |
| `@qlairoslabs/acp-client/activity` | `ActivityAggregator`, `foldRecords`, `foldFrame`, `wireFrames` — the delta→full-state fold. No runtime imports, so it is safe to compile for a browser. |
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
