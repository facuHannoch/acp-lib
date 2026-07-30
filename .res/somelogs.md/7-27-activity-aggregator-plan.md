# Activity aggregation & settled transcripts — implementation plan

**Date:** 2026-07-27
**Repo:** `@qlairoslabs/acp-client` (acp-lib)
**Status:** step 1 implemented — **rev 6**
**Requested by:** agents-core, via `.res/somelogs.md/7-27.md` (transcript activity format spec)

---

## 0. TL;DR

Add one pure module, `src/activity.ts`, that folds the ACP delta stream into
**full-state records**. Run **exactly one instance**, inside `AgentSession`, and expose its
output through a new `onRecord` prompt handler. The transcript writes the checkpoint
subset; agents-core forwards the live subset to its socket. Net: one new file, three
modified, ~500 lines with tests, no new dependencies, no build step, no change to the
protocol layer or the existing live streaming contract.

### 0.1 What changed in rev 2

Rev 1 proposed two aggregator instances (one in the lib for the transcript, one in the hub
for the socket). Review found three problems that all trace to that decision, plus two
factual errors. Corrections:

| # | Issue | Resolution |
|---|---|---|
| 1 | `current` on every event is **O(n²) bytes** for thinking — 4 KB of chunks becomes ~800 KB on the wire | `ApplyResult` carries an explicit `delta` for accumulating kinds (§3.1). Thinking streams incrementally, matching `onChunk`. |
| 2 | The round-trip test fed persisted **records** into `apply()`, which takes **events** — two thinking blocks would merge into one | Split the two folds explicitly: `apply(event)` (live) vs `foldRecords(records)` (persisted, trivially last-wins). Both shipped, both tested (§3.3, §6). |
| 3 | `recordId` `think-<n>` is instance-local; a hub instance created **mid-turn** starts at `n=0` while the lib is at `n=2`, so one block gets two ids and renders twice after reload | **One instance only** (§3.5). The lib is the sole source of `recordId`s. `messageId` used when the agent provides it (§3.2). |
| 4 | §4.1 claimed "agents-core already runs the aggregator" — it doesn't; `AgentSession` does | Argument replaced entirely: there is one instance, in the lib, exposed to the hub. No double-fold (§4.1). |
| 5 | "0.2.0 is unpublished, so breaking it costs nothing" — **it is published**, and so is `transcriptActivity` | Corrected rationale and version plan (§8.1). Working tree moved 0.2.0 → **0.3.0**. |
| minor | Turn-end flush must precede the assistant `msg` on the **error** path too | Explicit in the §3.5 snippet. |

Two facts established while checking:

- **`ContentChunk.messageId` exists in ACP** — *"All chunks belonging to the same message
  share the same `messageId`. A change in `messageId` indicates a new message has
  started."* That would make thinking-block boundaries and ids protocol-derived rather
  than invented. **But it is optional, and Kimi sends none** (verified live: absent on
  every `agent_thought_chunk` and `agent_message_chunk`). So it is an opportunistic
  refinement; the heuristic remains the common path.
- **The commit labelled "Bump version to 0.1.5" actually set 0.2.0**, and
  `transcriptActivity` is in `HEAD`. The flag is published, not unreleased.

### 0.2 What changed in rev 3

Review found that the `delta` optimization, the mid-turn join and the "one `map.set`"
claim were **the same seam**: the live wire has two shapes and no story for a subscriber
arriving mid-block.

| # | Issue | Resolution |
|---|---|---|
| 1 | A subscriber joining mid-thinking-block gets an `append` for a `recordId` it has no base for — drop it and lose the block, or guess | `ActivityAggregator.snapshot()` (§3.1) + a per-turn **`seq`** on every frame. Subscribe → snapshot → discard frames with `seq <= snapshot.seq`. |
| 2 | §3.5 asserted a hub-side record cache that does not exist in agents-core | Removed. The library holds the state, so `AgentSession.activitySnapshot()` replaces the cache entirely (§3.5, §5.1). |
| 3 | "one `map.set`" is false once deltas exist — the consumer must choose between set and append | True, so the library ships both folds: `foldRecords` (persisted, genuinely one operation) and `foldFrame` (live, handles either shape). Two shapes, zero consumer lines (§3.3). |
| minor | `ApplyResult.current` undefined for coalesced kinds | `current` is the full record for **every** kind, including `usage` — a live context meter works even though nothing persists until flush. |
| minor | What crosses the wire was unspecified | `wireFrames(result)` shipped. `delta ?? current` alone loses a thinking close (it lands in `emitted` while `current` is the tool that ended it). |
| §8.1 | Version argument rested on an assumption about the wild | Replaced with the consumer's stronger structural argument (§8.1). |

### 0.3 What changed in rev 4

The consumer diffed the shipped fold against their live reducer case by case. The rules
matched; one **contract** bug surfaced.

**`recordId` was turn-scoped while the transcript is conversation-scoped.** A fresh
aggregator per turn restarts `counters`, and several ids are constants — so every turn
mints `think-1`, `plan`, `usage`. `foldRecords()` over a five-turn file returned ONE
thinking record and ONE plan (the last turn's); turns 1–4 came back stripped of their
reasoning and plans. Tool calls disguised it, because `toolCallId` is harness-generated.

Fixed with a caller-supplied `idPrefix`, scoped by what the protocol actually guarantees:

| Id | Source | Prefixed? |
|---|---|---|
| `toolCallId` | ACP: *"unique … within a session"* | no |
| `planId` (`plan-p1`) | ACP: *"unique … within a session"* | no |
| `messageId` (`think-m1`, `msg-m2`) | ACP: *"unique … within a session"* | no |
| `think-1`, `plan`, `usage`, `mode`, `commands`, `config`, `session_info`, `<kind>-<n>` | minted here, turn-unique only | **yes** |

So the prefix marks exactly the ids we invented. One caveat the fix adds, recorded in the
option's doc comment: **the prefix must be stable across process restarts.** An in-memory
turn counter restarts at 0 when a session is resumed and would collide with ids already on
disk — `AgentSession` will use a timestamp or random id, not a counter.

Three consumer-side migrations were recorded as matching-or-adopted, no library change:
orphan `tool_update` synthesis (they adopt ours), render-union clamping moving to
`ToolChip` (ours keeps raw strings, since `updates.ts` already applies protocol defaults),
and `reason === "announced"` replacing their `streaming` flag.

### 0.4 What changed in rev 5

**A discard threshold outlived the turn whose `seq` it belonged to.** `seq` was per-turn
and §3.5 built a fresh aggregator per turn, but the snapshot contract is stated
unconditionally — so the natural consumer implementation (store `snapshotSeq`, filter
`frame.seq <= snapshotSeq` in the socket handler) has nothing telling it to stop. Connect
mid-turn-5 with `seq: 12`, and turn 6 starts at `seq: 1`: its first twelve frames vanish,
possibly an entire tool call, with no error. Subscribing *between* turns is safe
(threshold 0), which is exactly what would let it pass casual testing and appear later on
a reconnect.

Fixed by making `seq` monotonic for the life of the aggregator:

```ts
/** Begin a turn: clear per-turn state, set the minted-id prefix, keep the clock. */
startTurn(idPrefix?: string): AggregatedRecord[];
```

**One aggregator per stream now, not per turn** — `startTurn()` between turns. That also
strengthens the one-instance invariant rather than relying on callers to reconstruct
correctly, and it gives `idPrefix` (§0.3) a natural home. `reset()` remains a full reset
including the clock, documented as *not* the between-turns call. `startTurn()` returns
anything the caller forgot to `flush()` rather than dropping it, though relying on that
would persist those records after the assistant message and break `msg`-delimits-turn
ordering.

The consumer needs no turn-boundary rule: a stored threshold is valid forever.

### 0.5 What changed in rev 6

Two leftovers from the rev-5 edit, both in §3.5.

**`activitySnapshot()` said "empty when idle" but the code returned the previous turn's
records** — `flush()` settles records without clearing them; only `startTurn()` clears.
Settled behaviour as documented, for the consumer's reason: a client connecting between
turns would otherwise place the last turn's activity in its log before chat-history had
loaded the messages around it — activity with no turn around it. The transcript already
owns everything settled, so there is nothing to gain.

`ActivitySnapshot` gains `active: boolean`, because empty records are now ambiguous
between "no turn running" and "a turn that has produced nothing yet" — only the second
means frames are coming. `flush()` ends the turn, `startTurn()`/`reset()` begin one, and
`tool()`/`tools()` still expose a finished turn's folded state as inspection accessors
distinct from the replay contract.

**Doc drift:** "one `ActivityAggregator` per turn per stream" corrected to **per stream**,
and the "keeps a reference to the current turn's aggregator and clears it after flush"
prose — rev 2–4's per-turn construction — removed.

---

## 1. Context

### 1.1 What prompted this

The library was fixed earlier today so `tool_call_update` carries
`content`/`rawInput`/`rawOutput`/`title`/`locations` instead of just `status`. That
restored streaming, but made a latent problem visible: `transcriptActivity: true` writes
**one line per observed event** — ~15 lines for a single shell command, most of them
cumulative resends of the same growing string.

agents-core (a resident hub serving a mobile chat webapp) needs the transcript to survive
a page reload or a network switch. Today a reload loses the entire record of what the
agent *did*; only the final assistant text survives.

### 1.2 Requirements from the consumer

- **R1** Settled records, not deltas.
- **R2** Self-contained lines — a line renders without replaying anything before it.
- **R3** Interleaves with `t:"msg"` on one `ts` ordering.
- **R4** A crash mid-tool leaves a trace of attempted work.
- **R5** No new merge logic in readers — same fold as live events.
- **R6** Bounded reads.

### 1.3 The real risk to avoid

Not volume — **divergent folds**. agents-core folds live events for its webapp. If the
library folds independently for the transcript, two implementations of the same semantics
must agree forever. They will diverge, and the symptom is "reloading shows something
subtly different from what I just watched."

Rev 1 mitigated this by sharing a class. **Rev 2 eliminates it**: there is one instance,
so there is nothing to diverge.

### 1.4 Why this is in charter

The fold is *protocol-derived*, not app-derived. ACP defines the deltas, defines
`completed`/`failed` as terminal, and states `content` **replaces** the collection. Today
the README asks every consumer to hand-roll that merge from a snippet — which is how
subtly wrong copies get into the wild. Publishing it is the same move as
`toActivityEvent`: **the library owns what the protocol means, callers own what to draw.**

Exactly one rule is invented rather than derived: the thinking-block boundary, when the
agent omits `messageId`. It is isolated in one named method.

---

## 2. Layering

Not `SessionManager` — its own header states it "stores routing metadata only — never
conversation content". Nothing here touches it.

```
AcpClient          protocol: wire → ActivityEvent           unchanged
  ↑
AgentController    live connection control plane            unchanged
  ↑
AgentSession       durable conversation + transcript        ← owns THE aggregator
                   (optionally records into SessionManager, still metadata-only)

ActivityAggregator pure fold, no I/O                        ← new, free-standing module
```

The aggregator is free-standing so a consumer holding a raw `AcpClient` can run one
themselves — but when using `AgentSession`, **the session owns it and the consumer must
not create a second** (§3.5).

---

## 3. Design

### 3.1 `src/activity.ts` — the fold

Zero runtime dependencies. Type-only imports from `types.ts` (which imports nothing).
**Erasable-syntax-only** — no parameter properties, no enums, no namespaces — so a future
build step is a packaging change, not a rewrite.

```ts
export type EmitReason =
  | "announced"   // tool call first seen
  | "input"       // tool call first learned its rawInput
  | "settled"     // terminal status reached, or a thinking block ended
  | "flushed"     // turn ended with the record still open
  | "snapshot";   // inherently complete on arrival (plan, usage, mode, unknown)

export interface AggregatedRecord {
  /** Stable identity for last-wins folding, live and persisted. */
  recordId: string;
  reason: EmitReason;
  /** Always FULL state, never a delta. */
  event: ActivityEvent;
}

/**
 * The incremental piece for kinds the aggregator ACCUMULATES. Present means the
 * transport may send this instead of `current` — appending it to the record already
 * held yields the same state, at O(n) total bytes instead of O(n²).
 */
export type ActivityDelta =
  | { recordId: string; kind: "thinking"; append: string };

export interface ApplyResult {
  /** Full current state of whatever this event touched. */
  current: AggregatedRecord | null;
  /** Set only for accumulating kinds. When present, prefer it over `current`. */
  delta: ActivityDelta | null;
  /** Checkpoints worth persisting. Usually empty. */
  emitted: AggregatedRecord[];
}

/** What a live transport carries. Records are self-contained; deltas need a base. */
export type ActivityFrame = AggregatedRecord | ActivityDelta;

/** Everything known about the current turn — for replaying to a late subscriber. */
export interface ActivitySnapshot {
  /** Frames with `seq <= this` are already reflected here and must be discarded. */
  seq: number;
  records: AggregatedRecord[];
}

export class ActivityAggregator {
  constructor(options?: ActivityAggregatorOptions);   // { checkpointOnInput?, idPrefix? }
  apply(event: ActivityEvent): ApplyResult;
  flush(): AggregatedRecord[];
  /** Between turns. Keeps `seq`, clears turn state, sets the minted-id prefix. */
  startTurn(idPrefix?: string): AggregatedRecord[];
  snapshot(): ActivitySnapshot;
  tool(toolCallId: string): ToolActivity | undefined;
  tools(): ToolActivity[];
  reset(): void;
}

/** The PERSISTED fold — what a reader does. Trivially last-wins; not `apply`. */
export function foldRecords(
  records: Iterable<AggregatedRecord>,
  into?: Map<string, AggregatedRecord>,
): Map<string, AggregatedRecord>;

/** The LIVE fold — handles both wire shapes, so a consumer writes neither. */
export function foldFrame(
  map: Map<string, AggregatedRecord>,
  frame: ActivityFrame,
): Map<string, AggregatedRecord>;

/** What a live transport should send for one apply(), in order. */
export function wireFrames(result: ApplyResult): ActivityFrame[];
```

**`seq`** is a per-turn logical clock, incremented once per `apply()`; every frame from
one call shares it. It exists for the mid-turn join: without it, a subscriber that takes a
snapshot and then applies frames already folded into that snapshot double-appends the
thinking text. All three of `AggregatedRecord`, `ActivityDelta` and `ActivitySnapshot`
carry it.

**`wireFrames`** exists because `delta ?? current` is not sufficient. When a thinking block
closes because a tool call arrived, the close is in `emitted` while `current` is the tool —
a subscriber sending only `delta ?? current` never learns the block ended, and renders a
thinking bubble that never stops. The rule is `[...emitted, delta ?? current]` deduped by
`recordId`; for tool settles the two coincide and dedup collapses them.

**Why `delta` exists.** Tool calls are free to send as full state — the agent already
resends `content` cumulatively, so `current` is no larger than the raw event. Thinking is
not: it arrives as many small chunks, and re-sending the accumulated block each time is
quadratic. A 4,000-character block in ~400 chunks costs ~4 KB incrementally and ~800 KB as
full state — two orders of magnitude, on the mobile connection this feature exists to
survive. It would also be internally inconsistent, since `onChunk` (assistant text) stays
incremental.

Appending a string to a known `recordId` is **not** the invented rule — the boundary
(when a block starts and ends) stays server-side in the aggregator, which is the part that
must not be duplicated. The consumer only concatenates.

*Known characteristic, not addressed:* terminal `content` also grows, and each
tool update carries the whole enriched buffer. That is agent-driven resend behaviour
inherent to ACP's "content replaces" model, identical in cost to what reaches the library.
If it ever matters, a prefix-diff delta for terminal output is a later, separable change.

### 3.2 `recordId`

| Kind | `recordId` |
|---|---|
| `tool`, `tool_update` | the `toolCallId` (stream-derived) |
| `thinking` | `think-<messageId>` when the agent sends one, else `think-<n>` per turn |
| `plan` | `plan` |
| `usage` | `usage` |
| `mode` | `mode` |
| everything else | `<kind>-<n>` |

File contract, uniform across kinds:

> **Persisted:** fold last-wins on `recordId` — `foldRecords()`, genuinely one operation,
> because transcript lines are always full records. Valid across turns **only** when the
> aggregator was given an `idPrefix` (§0.3); without one, minted ids repeat every turn.
>
> **Live:** frames are `AggregatedRecord | ActivityDelta`; a record replaces, a delta
> appends. Use `foldFrame()`. Implementing `map.set` alone silently drops thinking.

`messageId` is used when present because it makes both the id **and** the block boundary
protocol-derived. It is optional in ACP and absent from Kimi, so the counter and the
non-thinking-event boundary remain the common path. **The counter is instance-local**,
which is safe only because there is exactly one instance — see §3.5.

### 3.3 Two folds, deliberately distinct

| | Input | Operation | Used by |
|---|---|---|---|
| `apply(event)` | `ActivityEvent` (deltas) | merge, accumulate, decide boundaries | the **live** path — one instance, in the lib |
| `foldRecords(records)` | `AggregatedRecord` (full state) | `map.set(recordId, rec)` | **readers** — transcript load, reconnect catch-up, the webapp |

They are not interchangeable. Feeding persisted records into `apply()` would, for
instance, merge two separately-settled thinking blocks back into one. Rev 1's round-trip
test made exactly this mistake.

The anti-drift property is therefore: **one implementation of the live fold, one instance
of it, and a persisted fold so trivial it cannot drift.**

### 3.4 Fold rules

| Input | Effect | Emits |
|---|---|---|
| `tool` | create/replace entry | `announced` |
| `tool_update`, no entry yet | create from update; default `status:"in_progress"`, `toolKind:"other"` | `announced` |
| `tool_update` | merge: spread; `content`/`locations` **replace** wholesale | — |
| …first `rawInput` | | `input` (if `checkpointOnInput`) |
| …status `completed` \| `failed` | | `settled`, once per id |
| `thinking` | append to open block; return `delta` | — |
| `messageId` changes, or any non-thinking event | close open block | `settled` **before** the triggering event's records |
| `plan`, `mode`, `unknown`, `plan_update`, `plan_removed`, `user_message`, `commands`, `config`, `session_info` | pass through | `snapshot` |
| `usage` | keep latest | — (coalesced to flush) |
| `flush()` | close block; emit unsettled calls **at their real status**; emit last usage | `settled` / `flushed` / `snapshot` |

1. **The aggregator emits every kind.** It owns semantics, not policy; persistence
   filtering is the writer's job — one decision, one place.
2. **Ordering is guaranteed by `apply()` returning arrays** — a pending thinking block
   closes *before* the record that ended it, so `ts` order matches causal order.
3. **`flushed` ≠ `settled`.** A cancelled or crashed turn writes the call at its true
   status. That is R4, told honestly.

### 3.5 One instance, exposed — `AgentSession`

`PromptHandlers` gains one handler:

```ts
/** Aggregated, full-state activity. The library folds once; this is that fold's output. */
onRecord?: (result: ApplyResult) => void;
```

`onActivity` is unchanged and still delivers **raw deltas** — nothing existing breaks.

```ts
// ONE per session, built when the session is created — not per turn.
this.aggregator = new ActivityAggregator({ checkpointOnInput });

// at the top of runPrompt, before the user msg append:
this.aggregator.startTurn(turnId);   // turnId must survive a process restart

onActivity: (event) => {
  const result = agg.apply(event);
  if (this.transcriptActivity) {
    for (const rec of result.emitted) this.writeActivity(rec);
  }
  item.handlers?.onRecord?.(result);     // hub → socket
  item.handlers?.onActivity?.(event);    // unchanged: raw deltas
}

// BOTH exit paths, before the assistant msg append:
try {
  const res = await this.controller.prompt(...);
  for (const rec of agg.flush()) this.writeActivity(rec);
  await this.appendTranscript(assistantMsg);
  return res;
} catch (err) {
  for (const rec of agg.flush()) this.writeActivity(rec);   // ← easy to miss
  await this.appendTranscript(errorMsg);
  throw err;
}
```

**This is the structural fix for the id-collision problem.** The hub does not construct an
aggregator; it subscribes. There is one counter and one set of `recordId`s.

For the mid-turn join, `AgentSession` also exposes the live aggregator's state:

```ts
/**
 * Full state of the turn in flight. `active: false` with no records between turns —
 * settled turns belong to the transcript, not to a replay.
 */
activitySnapshot(): ActivitySnapshot;
```

The session holds ONE aggregator for its lifetime and calls `startTurn(turnId)` per turn;
`flush()` closes the turn, after which the snapshot reports `active: false`.
**agents-core does not need a record cache** — rev 2 asserted one existed, which was wrong;
this removes the need for it rather than requiring it to be built. The remaining consumer
work is ordering, listed in §5.1.

**Invariant to document:** one `ActivityAggregator` **per stream**, for the life of that
stream, with `startTurn()` between turns — constructing one per turn restarts `seq` and
breaks a subscriber's discard threshold (§0.4). A consumer using `AgentSession` must use
`onRecord`, not build their own. A consumer holding a raw `AcpClient` builds exactly one.

Append ordering is already safe — writes serialize through one promise chain in call
order, so `msg(user) → activity… → msg(assistant)` holds. Pin it with a test; agents-core
groups turns by it.

### 3.6 Config — one axis

```ts
transcriptActivity?: boolean | {
  kinds?: Array<ActivityEvent["kind"]>;  // default: tool, thinking, plan, usage, mode, unknown
  checkpointOnInput?: boolean;           // default true
  rawOutput?: boolean;                   // default false
  maxBytes?: number;                     // per string field; default off
};
```

`true` = defaults, and `true` remains valid, so the published boolean form still type-checks.

Defaults: `mode` **in** (rare; explains otherwise-inexplicable behaviour changes);
`commands`/`config`/`session_info`/`user_message` **out** (client state, or duplicates
`t:"msg"`); `unknown` **in** (rare by construction; matches "nothing is dropped").

**`rawOutput` off** because it is usually a byte-identical duplicate of `content`.
Measured on live Kimi: one event carried `rawOutput: "LICENSE\nREADME.md\n…"` *and*
`content[0].text` with the same string.

**`maxBytes`** caps individual string fields (`content[].text`, `content[].output`,
stringified `rawInput`), appends `… [truncated N bytes]`, sets `truncated: true` on the
line. Per-field, so truncation cannot mangle JSON structure.

### 3.7 File format

Envelope unchanged; `readTranscriptLines` parses it today. Additive fields only.

```jsonc
{"v":1,"t":"activity","ts":1785…,"recordId":"t1","reason":"announced",
 "kind":"tool","toolCallId":"t1","toolKind":"execute","status":"pending","title":"Bash"}

{"v":1,"t":"activity","ts":1785…,"recordId":"t1","reason":"settled",
 "kind":"tool","toolCallId":"t1","toolKind":"execute","status":"completed",
 "title":"Shell: ls -la","rawInput":{"command":"ls -la"},
 "content":[{"type":"terminal","terminalId":"term-1","output":"total 32\n…",
             "truncated":false,"exitStatus":{"exitCode":0,"signal":null}}]}
```

`reason` lets a compact view request only `settled`/`flushed` without folding.

**Versioning.** `v` stays `1`: the envelope is unchanged and the new fields are additive.
The *meaning* of activity lines does change (raw → settled), but see §8.1 for why that is
acceptable here. **Going forward, any change to fold semantics or line meaning bumps `v`.**

### 3.8 Bounded reads (R6)

`readTranscriptLines(path, {before, limit})` keeps its signature. With `limit`, read
backwards from EOF in 64 KB chunks, accumulating **raw bytes** and decoding only the
assembled tail (so multi-byte characters cannot split at a chunk boundary); parse
newest-first, apply `before`, stop at `limit`, reverse. Without `limit`, the current full
read.

`before` + `limit` remain the pagination contract; `limit` remains newest-end. Folding is
the primary win (~15 lines per tool call → 2–3); the tail read closes the question rather
than deferring it.

---

## 4. Packaging

The package ships **TypeScript source**: `files: ["src"]`, exports mapping to `./src/*.ts`,
`.ts` internal specifiers, `engines.bun`. Bun-native. Outside Bun: Node cannot import
`.ts` except via type-stripping (which needs erasable-syntax-only code — the existing
codebase's parameter properties break it); Vite usually works once `optimizeDeps` picks it
up; Next needs `transpilePackages`; `tsc` that emits needs `allowImportingTsExtensions`,
which is `noEmit`-only.

**Key distinction:** `import type` is erased at compile time and works today in any bundler
with `moduleResolution: "bundler"`. Only *value* imports need a consumable build.

### 4.1 Where the fold runs

**One instance, in the library, inside `AgentSession`.** The hub subscribes via `onRecord`
and forwards; it folds nothing. The webapp receives `AggregatedRecord`s (or an
`ActivityDelta` for thinking) and folds them with `foldFrame` — a record replaces, a
delta appends — so it imports **types only**, which is free today with no build step.
(Rev 2 said "one `map.set`"; that is true of the persisted path only. The live path has
two shapes, which is why `foldFrame` ships.)

This is not "reuse the instance agents-core already has": agents-core has none. It is
"the library folds once and hands you the result", which is also what removes the
`recordId` divergence of rev 1.

### 4.2 Keeping the future open

`src/activity.ts` is written build-ready and gets its own subpath export:

```jsonc
"./activity": "./src/activity.ts"
```

If a browser ever needs the *code* (e.g. a consumer that folds locally), the change is
packaging-only: a `build` script (`tsc` → `dist/`), `dist` in `files`, exports conditions
gaining `types`/`import` beside the source path. Nothing in `src/` moves. A test asserts
`activity.ts` imports nothing but types, so that stays true.

---

## 5. Change list

| File | Status | Approx. |
|---|---|---|
| `src/activity.ts` | **new** — aggregator + `foldRecords`, zero runtime deps | ~230 |
| `src/types.ts` | changed — `onRecord` on `PromptHandlers`; `messageId?` on thinking/user_message | ~15 |
| `src/updates.ts` | changed — carry `messageId` through from `ContentChunk` | ~5 |
| `src/agent-session.ts` | changed — one aggregator per turn, config object, flush on both exits | ~35 |
| `src/transcript.ts` | changed — `recordId`/`reason`, backwards tail read | ~80 |
| `src/client.ts` | changed — pass `onRecord` through (no fold; `AgentSession` owns it) | ~5 |
| `src/index.ts`, `package.json` | changed — exports + `./activity` subpath | ~12 |
| `test/activity.test.ts` | **new** | ~200 |
| `test/transcript.test.ts` | changed — tail read, pagination | ~70 |

**Untouched:** `AcpClient`'s protocol path, `AgentController`, `transport/acp-transport.ts`,
`SessionManager`, `terminals.ts`, `fs-access.ts`, the `onActivity` raw-delta contract, and
`readTranscript`'s message projection.

**Status:** `src/activity.ts`, the `messageId` passthrough, `test/activity.test.ts` (24
tests) and the `./activity` subpath are **done** — step 1 complete, 103 tests green,
typecheck clean. Nothing else in the table is started.

Step 2 must pass a per-turn `idPrefix` when constructing the aggregator (§0.3), stable
across process restarts.

### 5.1 agents-core deliverables

Not library work, listed so the seam is owned end to end:

1. **Subscribe → snapshot → discard by `seq`.** On connect: register the subscriber
   first, call `session.activitySnapshot()`, send its records, then stream frames,
   dropping any with `seq <= snapshot.seq`. No record cache is needed — rev 2 wrongly
   said one already existed; §3.5 removes the need for it.
2. **Send `wireFrames(result)`**, not `delta ?? current` (§3.1 explains what the latter
   loses).
3. **Fold with `foldFrame`** live and `foldRecords` on load — the webapp imports both as
   types-only plus the two functions if it folds client-side, or receives already-folded
   records if the hub folds.
4. **Config passthrough** — `transcript_activity` in `agents.yaml` → `AgentSessionConfig`.
5. **Read route** — `GET /api/agents/:id/chat-history` moves from `readTranscript` to
   `readTranscriptLines`, interleaving `msg` + `activity` by `ts`, passing `before`/`limit`
   through.

---

## 6. Tests

**Fold rules** — announce → updates → settle; `tool_update` before any `tool`;
`content`/`locations` replace, never concatenate; terminal statuses settle once; thinking
accumulates and closes on the first non-thinking event **and** on a `messageId` change;
`flush()` closes an open block, emits unsettled calls at their real status, emits last
usage; `usage` coalesces to one per turn.

**Delta correctness (the O(n²) fix)** — for a 400-chunk thinking block, every `apply()`
returns a `delta`; concatenating all deltas equals the settled block's text; total delta
bytes are O(text length), asserted against a bound.

**Realism** — the captured live Kimi delta sequence folds to the correct final state; the
terminal fixture end to end.

**Volume bound** — one shell command ⇒ **≤3** `kind:"tool"` lines (was ~15).

**Ordering** — `msg(user) → activity… → msg(assistant)` on both the success **and error**
paths.

**Bounded reads** — tail read equals full read for random `limit`s; `before`+`limit`
pagination; a multi-byte character spanning a chunk boundary survives.

**Mid-turn join** — a subscriber takes a snapshot mid-thinking-block, replays frames from
both sides of it, and ends with byte-identical state to the live subscriber (no
double-append); a delta with no base is dropped rather than guessed at; every frame from
one `apply()` shares a `seq`.

**`wireFrames`** — carries a thinking close that `delta ?? current` would hide; never
duplicates a record.

**Packaging** — `activity.ts` has no runtime imports (asserted by reading the source and
requiring every `import` line to start with `import type`).

**The round-trip — corrected**

> Fold a live event stream with `apply()`; collect `emitted`; persist; read back; fold the
> persisted records with **`foldRecords()`**; assert the resulting map equals the map built
> from the live path's own records.

Rev 1 fed persisted records back into `apply()`, which is a different operation and would
have merged separately-settled thinking blocks. The corrected test exercises exactly what
a reader does, and is the executable form of the file contract.

---

## 7. Sequencing

1. ~~**`src/activity.ts` + folds + tests + subpath export.**~~ **DONE.** No behaviour
   change yet — `transcriptActivity` still writes raw lines. Awaiting the consumer's
   case-by-case diff against `chatStore.reduce` before step 2.
2. **`onRecord` handler + writer rewire + config object.** Unblocks agents-core.
3. **Bounded tail read.**
4. **Document the file contract** in `transcript.ts`: fold last-wins on `recordId`; `msg`
   delimits turns; a missing trailing assistant `msg` means the turn died in flight.

---

## 8. Decisions taken

| Decision | Call | Why |
|---|---|---|
| Who owns the fold | The library, one instance, exposed | Protocol-derived; one instance cannot diverge from itself |
| Where it runs for the socket | In the lib; the hub subscribes | Removes double-fold and `recordId` divergence |
| Thinking on the wire | Incremental `delta` | Full state per chunk is O(n²); ~4 KB → ~800 KB |
| Persisted fold | Separate `foldRecords`, last-wins | Not the same operation as `apply()` |
| Thinking id | `messageId` when sent, counter otherwise | Protocol-derived when possible; Kimi sends none |
| `checkpointOnInput` | Default **on** | Announced line usually lacks the command (Kimi: update 13 of 14) |
| `rawOutput` | Default **off** | Byte-identical duplicate of `content` in practice |
| `mode` persisted | **Yes** | Rare; explains behaviour changes |
| `unknown` persisted | **Yes** | Rare by construction; matches "nothing is dropped" |
| Size cap | Optional, default off | A terminal call can carry megabytes |
| Bounded reads | **Build it** | Prefer a guarantee to a stated non-guarantee |
| Format version | Stays `v:1` | See §8.1 |

### 8.1 Version plan — corrected

Rev 1 asserted "0.2.0 is unpublished, so it costs nothing." **That was wrong.** The
registry lists `0.1.0, 0.1.1, 0.1.2, 0.1.5, 0.2.0` with `latest: 0.2.0`; the commit
labelled *"Bump version to 0.1.5"* in fact set `0.2.0`, and `transcriptActivity` is in
`HEAD`. **The flag is published.**

Consequences:

- The working tree's `package.json` said `0.2.0`, a version already on the registry.
  **Corrected to `0.3.0`** (done).
- `0.3.0` carries today's breaking `ActivityEvent` changes (`tool_update.status` optional,
  deltas instead of defaults). The aggregator work lands in `0.3.0` or `0.4.0` depending
  on sequencing.
- Changing what `transcriptActivity` writes **is** a breaking change to a published
  feature. It is acceptable because the flag defaults **off**, and the only known consumer
  confirms it was never enabled — *not* because it was unreleased. Anyone reasoning from
  this document should use that rationale.
- `v:1` in the file format stands on a **structural** argument, not an assumption about
  the wild: `recordId` and `reason` are themselves the discriminator. A 0.2.0 raw activity
  line has neither field; a settled line has both. So a reader can tell the two apart
  without a version bump even if such a file exists. Any *future* change to fold semantics
  still bumps `v`, since that would not be self-discriminating.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A consumer builds a second aggregator anyway | Documented invariant; `onRecord` makes it unnecessary; `recordId` divergence is the symptom to watch |
| Aggregator state leaks across turns | One instance per turn; `reset()`; flush on success **and** error paths |
| Thinking boundary heuristic wrong for some agent | Isolated, named; `messageId` preferred when available; changing it bumps `v` |
| A reader concatenates `content` instead of replacing | Schema says "Replace the content collection"; pinned by an existing test; stated in the contract |
| Runtime import sneaks into `activity.ts` | Import test |
| Turn-end flush lands after the assistant `msg` | Explicit on both exit paths; pinned by a test |
| Transcript grows unbounded | `maxBytes`, `rawOutput` off, kind filter, tail read |
| Terminal content resends grow quadratically | Known, inherent to ACP; prefix-diff delta is a separable later change |

---

## 10. Not in scope

- Duplicating the harness's own full-fidelity session record. This stays the lightweight,
  always-available, harness-agnostic view.
- Changing the `onActivity` raw-delta contract.
- Any change to the protocol layer, capabilities, terminals, or `SessionManager`.
- A build step for the package (deferred; kept cheap by writing `activity.ts` build-ready).
