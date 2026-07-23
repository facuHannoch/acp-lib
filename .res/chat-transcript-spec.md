# Chat transcript — spec

Status: design, not yet implemented. Spans the **acp-lib** (writes/reads the
transcript) and **agents-core** (supplies the path, exposes a read route, loads
on mount). Written so the lib side can be built standalone.

---

## 1. What this is (and is not)

A **lightweight, persisted, message-level record** of a chat, owned and written
by the acp-lib. Its single job: let a client **repaint prior messages on reload**
without the agent being live.

It is deliberately **messages-only**:

- **Stores:** user messages and the agent's final reply text, plus light
  metadata (timestamps, token usage). That's it.
- **Does NOT store:** tool inputs/outputs, thinking traces, per-chunk streaming,
  plans. Those are large and the **harness already persists them** in its own
  session (what `--resume` reads).

This keeps size trivial (see §7) and avoids duplicating the harness's data.

### Not to be confused with two adjacent things

| Thing | Layer | Content | When available | Use |
|---|---|---|---|---|
| **This transcript** | acp-lib (persisted file) | messages only | always (even agent stopped) | reload-history |
| **`loadSession` replay** | acp-lib (live stream) | full: tools, thinking, plans | live agent only, on demand | "load session" / rich view |
| **Harness session** | harness (its own store) | full, native format | via harness | powers `--resume` / `loadSession` |

The transcript is the cheap always-on record; `loadSession` replay is the rich
on-demand one. Both are **lib-driven** — the hub never reaches around the lib to
read harness data directly.

---

## 2. Path contract (the key design choice)

**The caller supplies the transcript path.** The lib does not choose the key.

```
AgentSessionConfig {
  …
  transcriptPath?: string;   // absolute path to the .jsonl file to append to.
                             // Omitted → no transcript written ("no-transcript mode").
}
```

- **Omitted ⇒ off.** No path, no file — this is the default and the current
  behavior, so nothing changes for callers that don't opt in.
- The **hub passes `…/.artifacts/agents/<agent-id>/chats/<convId>.jsonl`.**
  Keying by the hub's durable `convId` means:
  - one file per conversation, stable across `internalSessionId` churn
    (mode-swap, resume) — the file does not move when the harness session id
    changes;
  - the hub needs **no session catalog** to find it later — it already knows the
    `convId`, so the read route just reads `<convId>.jsonl`. (Sidesteps the
    deferred catalog work entirely.)
- The REPL/CLI can pass its own path; the lib imposes no naming.

Rationale: the lib owning the *format* but the caller owning the *key* is the
clean split. It matches the existing "consumer supplies storage" pattern
(`SessionStore`, `Logger`).

---

## 3. Line format (NDJSON)

One JSON object per line, append-only. Minimal, versioned by a `v` field so the
shape can evolve without breaking readers.

```jsonc
// session opened (optional, once per file segment)
{ "v": 1, "t": "meta", "event": "open", "ts": 1730000000000,
  "internalSessionId": "sess_abc", "adapter": "claude" }

// a user message
{ "v": 1, "t": "msg", "role": "user", "text": "hello", "ts": 1730000000100 }

// the agent's final reply
{ "v": 1, "t": "msg", "role": "assistant", "text": "hi there",
  "ts": 1730000001600, "usage": { "inputTokens": 12, "outputTokens": 30 },
  "stopReason": "end_turn" }
```

Rules:

- `role` ∈ `user | assistant`. (System/hub notices are not persisted here — they
  are transient UI, not conversation content.)
- `text` for `assistant` is the **final settled reply**, not the streamed chunks.
- `usage` / `stopReason` optional, best-effort (they're already on `PromptResult`).
- `meta` lines are optional and skippable by readers that only want messages.
- **No tool/thinking/plan lines.** If tool *markers* are ever wanted in the UI,
  add a `t:"tool_ref"` line (id + title only, no payload) — but not in v1.

---

## 4. Write semantics

Written at the lib's prompt choke point (`AgentSession.prompt` /
`ChatSession.prompt`), mirroring v0's `ChatSession`:

1. On prompt **start**: append the `user` line immediately (so an interrupted or
   errored turn still records what was asked).
2. On prompt **completion**: append the `assistant` line with the final text +
   usage + stopReason.
3. On **cancel/error**: append the `assistant` line with whatever partial text
   arrived and the real `stopReason`/status (`PromptResult` resolves, not
   rejects, on cancel — the partial text is available). Never drop the turn
   silently.
4. Appends are best-effort: a failed write must **not** break the prompt. Log and
   continue.

Concurrency: appends are serialized per file (one writer per `AgentSession`;
distinct conversations write distinct files, so no cross-file contention).

---

## 5. Read API

The lib owns the format, so **the lib exposes the reader** — agents-core must not
parse a format it doesn't control.

```
// On AgentSession, or a free function given a path:
readTranscript(path: string, opts?: { limit?: number; before?: number })
  : Promise<TranscriptEntry[]>
```

- Returns parsed message entries (skipping `meta`), oldest-first.
- `limit` / `before` (cursor by `ts`) for paging long histories — optional in v1
  (can return all), but the signature should allow it so the UI can lazy-load
  older messages later.
- Malformed lines are skipped, not fatal.

agents-core calls this from its read route; it never opens the `.jsonl` itself.

---

## 6. agents-core integration (after the lib side lands)

1. **Supply the path.** In `agent/chat/session.ts` `createAgentSession`, set
   `transcriptPath` on the `AgentSessionConfig` to
   `agentPaths(agent, repoRoot).transcriptDir + "/" + convId + ".jsonl"`.
   - `transcriptDir` (= `.artifacts/agents/<id>/chats`) is **already computed**
     in `agent/helpers/paths.ts` and currently unused — this finally wires it.
   - `createAgentSession` needs the `convId` passed in (it currently takes
     `internalSessionId` only). Thread `convId` from `hub.getOrLoadSession`
     (which has it).
2. **Read route.** `GET /api/agents/:id/chat-history` (reads tier):
   resolve the agent's solo conversation (`db.findLatestConversation([agentId])`),
   derive its transcript path from `convId`, call the lib reader, return
   `{ messages: TranscriptEntry[] }`. 404 if no conversation yet (empty history).
3. **Webapp load-on-mount.** `chatStore.ensureChat`:
   - open the WS (as today),
   - fetch `/api/agents/:id/chat-history` and seed `chats[agentId].lines` with
     the returned messages (mapped to `ChatLine`, `streaming: false`),
   - live WS events append on top.
   - Ordering: to avoid a gap, open the WS first, then load history, then let
     live events append. A message arriving during the fetch is a negligible
     edge for the alpha; if it matters later, buffer WS events until history is
     seeded, then flush.

---

## 7. Size

Messages-only ⇒ trivial. A settled turn is ~1–2KB text; a heavy day ~200 turns ⇒
<1MB/day; a year of heavy use ⇒ ~150MB per agent. Files or SQLite both handle
that without thought. The only size bomb is tool I/O — explicitly excluded here
because the harness already persists it (§1).

---

## 8. Open decisions

- **Read location for `meta`/paging** — v1 can return all messages; add
  `limit`/`before` when histories get long enough to matter.
- **Multi-session per conversation** — today a conversation stores one
  `internalSessionId`, so one transcript file. If a conversation ever spans
  several sessions (mode-swap kept in-conversation), decide: one file per
  `convId` regardless (append across sessions — simplest, recommended), or one
  per session and concatenate on read. Recommend **per `convId`** so the file
  matches the human-visible thread.
- **Tool markers** — deferred. If the UI later wants "● Read file.ts" chips in
  history without full output, add `t:"tool_ref"` lines (id/title only).
- **Which prompt origins to record** — human chat clearly yes. Agent-to-agent and
  task-dispatch prompts also flow through the same `prompt()`; recording them
  gives those conversations history too, but decide whether that's wanted or
  should be filtered by origin.
```




# Proposed plan

Plan to implement transcripts in `acp-lib`, scoped to the spec:

**1. Add Transcript Types**
Add to `src/types.ts` or a new `src/transcript.ts`:

```ts
export interface TranscriptMessage {
  v: 1;
  t: "msg";
  role: "user" | "assistant";
  text: string;
  ts: number;
  usage?: Usage | null;
  stopReason?: string;
  status?: "completed" | "cancelled" | "error";
}

export interface TranscriptMeta {
  v: 1;
  t: "meta";
  event: "open";
  ts: number;
  internalSessionId?: string | null;
  adapter?: string;
}

export type TranscriptLine = TranscriptMessage | TranscriptMeta;
export type TranscriptEntry = TranscriptMessage;
```

I’d include `status` even though the examples don’t show it, because the write semantics explicitly mention cancel/error and `PromptResult` already has it.

**2. Implement Transcript File Helpers**
Create `src/transcript.ts`:

- `appendTranscriptLine(path, line)`
- `readTranscript(path, opts?: { limit?: number; before?: number })`
- `createTranscriptWriter(path, metadata?)` or a small class if serialization is cleaner.

Rules:
- NDJSON append-only.
- `mkdir(dirname(path), { recursive: true })`.
- Malformed read lines skipped.
- Return only `t: "msg"` entries.
- Best-effort write helper catches/logs at caller boundary.

**3. Add `transcriptPath` to `AgentSessionConfig`**
In [src/agent-session.ts](/Users/qlairos/qlairoslabs/libs/acp-lib/src/agent-session.ts:29):

```ts
transcriptPath?: string;
```

Omitted means off.

Store it on `AgentSession`; no changes to `AgentController` / `AcpClient`.

**4. Write Transcript at `AgentSession.prompt`**
In `AgentSession.prompt`:

1. Before calling `controller.prompt`, append user message immediately.
2. Await prompt result.
3. Append assistant message with:
   - final `res.text`
   - `res.usage`
   - `res.stopReason`
   - `res.status`
4. If `controller.prompt` rejects, append an assistant error line best-effort, then rethrow.

Important: writes must not break prompt execution. Use logger if available; otherwise silently ignore.

**5. Serialize Writes Per Session**
Add an internal write queue on `AgentSession` or transcript writer:

```ts
private transcriptWrite = Promise.resolve();
```

Each append chains onto it. This satisfies “serialized per file.”

**6. Meta Open Line**
On `AgentSession.start()` after controller start resolves and `internalSessionId` is known, append:

```json
{ "v": 1, "t": "meta", "event": "open", "ts": ..., "internalSessionId": ..., "adapter": ... }
```

Best-effort. Optional, but useful and cheap.

**7. Export Reader**
From `src/index.ts` export:

```ts
readTranscript
```

and transcript types. This is what `agents-core` will call; it should not parse the file itself.

**8. Tests**
Add `test/transcript.test.ts`:

- append/read round trip
- reader skips malformed lines
- reader skips meta lines
- `limit` works if implemented now
- `before` works if implemented now
- missing file returns `[]`

Add/extend `AgentSession` tests only if easy with a fake controller; otherwise keep first pass focused on pure transcript helpers and do a small integration-style test around a mockable writer if needed.

**9. Docs**
Update README with the opt-in config:

```ts
await AgentSession.create({
  adapter,
  adapterId,
  transcriptPath: "/abs/path/chat.jsonl",
});
```

and mention that transcripts are messages-only.

I’d implement this first without touching replay, tool/thinking parsing, or REPL behavior. The spec explicitly makes transcript independent from `loadSession` replay, so v1 can be small and reliable.



I would **not** store the same raw protocol stream as the transcript.

The examples show why: the ACP stream is not a chat transcript. It is an event log. It includes:

- token/chunk-level assistant text
- thinking chunks
- cumulative tool-call input updates
- raw tool outputs
- permission requests
- provider-specific `_meta`
- repeated/in-progress updates
- huge write payloads, like the `WriteFile: PLAN.md` example

That is useful for rich replay, debugging, or a harness event archive, but it conflicts with the transcript spec’s goal: “repaint prior messages on reload without the agent being live.”

So I’d keep two concepts:

```ts
Transcript = compact chat messages
Protocol replay = raw/rich ACP events
```

But we do **not** need an overdesigned custom model. The transcript type can be minimal and close to the UI requirement:

```ts
type TranscriptEntry =
  | {
      v: 1;
      t: "msg";
      role: "user" | "assistant";
      text: string;
      ts: number;
      usage?: Usage | null;
      stopReason?: string;
      status?: "completed" | "cancelled" | "error";
    }
  | {
      v: 1;
      t: "meta";
      event: "open";
      ts: number;
      internalSessionId?: string | null;
      adapter?: string;
    };
```

The key reason to define our own transcript type is that the source of truth for “what should repaint in chat history” is **not** the ACP protocol. ACP is transport/runtime state. The transcript is a product-level projection: user message + final assistant reply.

The implementation plan should be smaller:

1. Add `transcriptPath?: string` to `AgentSessionConfig`.
2. Add `src/transcript.ts` with:
   - `appendTranscriptEntry(path, entry)`
   - `readTranscript(path, opts?)`
   - small exported `TranscriptEntry` types
3. In `AgentSession.prompt`:
   - append user message before prompt
   - append assistant message after `PromptResult`
   - best-effort writes only
4. Export `readTranscript` and types.
5. Tests for NDJSON read/write and `AgentSession.prompt` transcript behavior.

No parsing of `session/update` is needed for v1 transcript, because `AgentSession.prompt` already has the exact two things we want:
- the user prompt text before sending
- the final assistant `PromptResult.text` after completion

That avoids storing the noisy protocol and avoids reconstructing final messages from chunks.





note that the spec is orientative, we can drift from that, only if it makes sense obviously.  What if I do want to keep a rich information from what was done, the permissions, etc? Does this design can later be expanded for that?


Yes, it can be expanded cleanly if we choose the NDJSON envelope carefully now.

I would still **not** make the chat transcript be raw ACP by default, but I would design it as an append-only event file that starts with messages-only and can later include richer entries.

Something like:

```ts
type TranscriptLine =
  | TranscriptMetaLine
  | TranscriptMessageLine
  | TranscriptActivityLine
  | TranscriptPermissionLine
  | TranscriptRawLine;
```

For v1 we write only:

```ts
{ v: 1, t: "meta", ... }
{ v: 1, t: "msg", role: "user" | "assistant", ... }
```

Later we can add:

```ts
{
  v: 1,
  t: "activity",
  kind: "tool",
  toolCallId: "...",
  title: "Read file",
  toolKind: "read",
  status: "completed",
  ts: 1730000001000
}
```

```ts
{
  v: 1,
  t: "permission",
  toolCallId: "...",
  title: "Shell: rm file",
  options: [...],
  outcome: { outcome: "cancelled" },
  ts: 1730000001200
}
```

```ts
{
  v: 1,
  t: "raw",
  protocol: "acp",
  event: "session/update",
  ts: 1730000001300,
  data: { ... }
}
```

Then the reader can offer projections:

```ts
readTranscript(path)              // message entries only, current UI use case
readTranscriptLines(path)         // all known transcript lines
readTranscriptEvents(path, opts)  // richer timeline later
```

The important part is to distinguish **storage format** from **read projection**.

I’d avoid storing full raw ACP for every update in the same default transcript file because examples like `response6-plan` show it can explode in size from cumulative tool payloads. But we can support it later behind an explicit mode:

```ts
transcriptMode?: "messages" | "timeline" | "raw"
```

or:

```ts
transcript?: {
  path: string;
  include?: {
    messages?: boolean;      // default true
    activity?: boolean;      // tool/thinking/plan markers
    permissions?: boolean;   // permission request + outcome
    raw?: boolean;           // full ACP events, explicit opt-in
  };
}
```

For now, I’d implement the path as:

```ts
transcriptPath?: string
```

but internally keep the line envelope extensible with `t`. That gives us forward compatibility without committing to capturing everything today.


Implemented transcript v1.

What changed:
- Added [src/transcript.ts](/Users/qlairos/qlairoslabs/libs/acp-lib/src/transcript.ts:1) with extensible NDJSON line types, append helper, `readTranscript`, and `readTranscriptLines`.
- Added `transcriptPath?: string` to [src/agent-session.ts](/Users/qlairos/qlairoslabs/libs/acp-lib/src/agent-session.ts:55).
- `AgentSession` now writes:
  - `meta/open` on start
  - user message before each prompt
  - assistant final message after prompt result
  - assistant error line with captured partial chunks if prompt rejects
- Added an `AgentSession`-level prompt queue so transcript turn order stays correct for concurrent `prompt()` calls.
- Exported transcript helpers/types from [src/index.ts](/Users/qlairos/qlairoslabs/libs/acp-lib/src/index.ts:64).
- Documented `transcriptPath` in [README.md](/Users/qlairos/qlairoslabs/libs/acp-lib/README.md:136).
- Added [test/transcript.test.ts](/Users/qlairos/qlairoslabs/libs/acp-lib/test/transcript.test.ts:1).

The format is currently lightweight messages plus meta, but the type envelope already leaves room for future `activity`, `permission`, and `raw` lines without changing the file format.

Verification passed:
- `bun run typecheck`
- `bun test` with 51 passing tests

Worktree note: `.DS_Store` and `.res/chat-transcript-spec.md` are untracked; I left them as-is.