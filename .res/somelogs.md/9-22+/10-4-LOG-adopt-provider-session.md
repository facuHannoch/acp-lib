# Log: adopting a provider session (and the persistence resolver)

Branch: `session-loading`. Specs and plan: `10-2-SPEC-adopt-provider-session.md`,
`10-2-PLAN-adopt-session-and-persistence-resolver.md`, `9-24-SPEC-conversation-persistence-policy.md`.

One entry per step: what was done, how it was tested, and the gaps in that testing. Anything that regresses
and is not fixed in the same step is logged under **Regressions** with the reason, so it can be found later.

Baseline before this work (steering already in the tree, uncommitted): `bun test` 897 pass / 0 fail,
`tsc --noEmit` clean.

---

## Pre-work: the two spikes

**Done.**
- Replay spike: `smoke-tests/session-replay-probe/` loads existing sessions with `session/load` and prints what is
  replayed. Result written into the adoption spec ("Replay: what arrives"). Replays carry user and assistant
  messages with `messageId`, tool calls (announce plus updates, folded by `toolCallId`, with input, output and
  final status) and, on OpenCode, thoughts. No timestamps, no usage. Today the replay is dropped on the connect
  path (no `onUpdate` is passed to `loadSessionInternal`).
- Migrations spike (read only, no code): schema is `SQLITE_AGENT_SCHEMA_VERSION = 12` in
  `src/persistence/sqlite-schema.ts`; migrations are guarded `ALTER TABLE` steps inside one `BEGIN IMMEDIATE`
  transaction, versions 8 to 12 accepted. Adoption needs a version 13 (see the plan, Phase 2).

**Tested.** The probe ran against real Codex (`codex-acp` 2.1.1) and OpenCode (1.18.32) on six sessions left by the
steering smoke tests (plain turns, tool use, a steer, a cancelled turn). Loading a session does not call the model,
so it spent no tokens.

**Gaps.**
- Only Codex and OpenCode were probed. Claude Code, Pi and Kimi may replay differently (message boundaries, tool
  calls, thoughts); the probe takes any adapter and session id.
- Sessions were short (up to 3 turns). Long sessions, compacted sessions and very large tool outputs were not tried.
- A first reading of the probe was wrong (tool calls looked `pending` because only the announce status was printed);
  it was corrected after the user's objection and the probe now folds by `toolCallId`. The folded result was
  checked by reading the raw JSON, not by a unit test.

**Regressions.** None (no library code changed).

---

## Phase 0, step 1: move the config types out of `agent.ts`

**Done.** The public configuration and interface types moved out of `src/agent.ts` into the new
`src/agent/config.ts` (126 lines): `AgentPersistenceConfig`, `AgentConversationRuntimeDefaults`, `AgentConfig`,
`CreateAgentConversationConfig`, `OpenAgentConversationConfig`, `OpenOwnedAgentConversationResult` and
`AgentConversationManager`. `src/agent.ts` imports them and re-exports them as types, so every existing import path
(`./agent.ts`, `src/index.ts`) still resolves. Unused imports left behind in `agent.ts` were removed.
`agent.ts`: 1637 to 1549 lines. No behaviour change.

**Tested.**
- `bunx tsc --noEmit` and `bunx tsc --noEmit --noUnusedLocals` (no errors for `src/agent.ts` or `src/agent/`).
- Full suite: `bun test` 897 pass / 0 fail (same as the baseline).

**Gaps.**
- A type-only move: the suite cannot fail on it at runtime, so the typecheck is the real test. The public export list
  was not compared before and after by a script; it relies on the type re-exports compiling and `src/index.ts`
  still building.
- Declaration output (`.d.ts`) for consumers was not generated and compared.

**Regressions.** None.

---

## Phase 0, step 2: move the free helpers and `ManagerSettings` out of `agent.ts`

**Done.** Two blocks moved out of `src/agent.ts`, with no code changes inside them other than `export`:
- the nine free helper functions at the bottom (`updateConversationIdentity`, `persistConversationObservations`,
  `persistObservationsInTransaction`, `normalizeParticipants`, `internalInferenceMeteringKind`,
  `captureRuntimeRecord`, `enqueueAuditObservation`, `providerSessionErrorDetails`, `operationIdFromMetadata`) into
  `src/agent/record-capture.ts` (228 lines);
- the internal `ManagerSettings` interface into `src/agent/manager-settings.ts` (36 lines), imported as a type by
  `agent.ts` and by `record-capture.ts`.
`agent.ts`: 1549 to 1342 lines. Unused imports were pruned in all three files. No behaviour change.

**Tested.**
- `bunx tsc --noEmit` and `bunx tsc --noEmit --noUnusedLocals` (no errors for `src/agent.ts` or `src/agent/`).
- Full suite: `bun test` 897 pass / 0 fail (the baseline).

**Gaps.**
- Mechanical move, so the typecheck is the main test. `record-capture.ts` imports the `Agent` class type from
  `../agent.ts` while `agent.ts` imports functions from `record-capture.ts`; the cycle is type-only on one side, which
  compiles and runs, but it is a coupling to watch (it goes away if the helpers stop taking an `Agent`).
- Nothing exercises the helpers on a path that the existing tests do not already cover (audit enqueue failures,
  `persistObservationsInTransaction` with the event bus, `captureRuntimeRecord` at every level).

**Regressions.** None.

**Process note.** The steering feature was committed by the user as `9dd5005` between steps, so these steps start from
a tree where `HEAD` already contains steering. The user's own TODO files moved to `.res/somelogs.md/9-22+/todos/`;
the specs still name the old paths (`10-2-TODO-*.md`), to be updated when the specs are next edited.

---

## Phase 0, step 3: move `PersistedConversationLifecycle` out of `agent.ts`

**Done.** The `PersistedConversationLifecycle` class (the write path for every conversation record, about 255 lines)
moved to `src/agent/persisted-lifecycle.ts` (305 lines with imports), unchanged apart from `export`. `agent.ts` imports
it for the manager. `agent.ts`: 1342 to 1065 lines. Unused imports pruned. No behaviour change.

**Tested.** `tsc --noEmit` and `--noUnusedLocals` clean for `src/agent.ts` and `src/agent/`; `bun test` 897 pass / 0 fail.

**Gaps.** Same as step 2: a mechanical move covered by the typecheck and the existing suite. The lifecycle imports the
`Agent` class as a type (it reads `agent.persistence`, `agent.identity`, ...), a coupling that the later steps (policy
carried per conversation) will narrow.

**Regressions.** None.

---

## Phase 0, step 4: move `DefaultAgentConversationManager` out of `agent.ts`

**Done.** The conversation manager class (create, open, start, recovery, error recording, metering locks, about 590
lines) moved unchanged to `src/agent/conversation-manager.ts` (658 lines with imports). Two dynamic type imports inside
it (`import("./internal-inference/...")`) had their paths fixed. `src/agent.ts` is now the `Agent` class and its
re-exports only: 1637 lines at the start of Phase 0, 427 now. No behaviour change.

**Tested.** `tsc --noEmit` and `--noUnusedLocals` clean; `bun test` 897 pass / 0 fail.

**Gaps and deviations.**
- `conversation-manager.ts` is 658 lines, above the 400-line budget in the plan, and it still holds create/open/start,
  error recording, provider-session persistence and the internal-inference metering locks together. The plan's finer
  split (orchestration / start / errors) was not done: the class shares private state (`live`, `openings`, the metering
  locks) and splitting it would mean passing explicit collaborators, which is a design change and not a move.
  Decision: split only the parts the adoption work touches (create/start get thin hooks; adoption logic lives in
  `src/agent/adoption/`), and leave the rest. Revisit if the file keeps growing.
- As with the previous moves, only the typecheck and the existing suite cover it.

**Regressions.** None.

---

## Phase 0, step 5 and Phase 1: per-conversation settings and the capture-only resolver

The plan's "carry a resolved persistence policy per conversation" (9-24 step 1) and the minimal resolver (Phase 1) were
done together, because the first has no other purpose than the second.

**Done.**
- New module `src/agent/persistence-policy/`: `types.ts` (`AgentConversationPersistenceOverride`,
  `ConversationPersistenceContext` with `adopted`, `ConversationPersistenceResolver`), `resolver.ts`
  (`ConversationSettingsResolver`), `index.ts`. Types are exported from `src/agent.ts` and `src/index.ts`.
- `AgentConfig.conversationPersistence` (synchronous resolver); `ManagerSettings` gained `captureConfig` (the Agent's
  capture as configured, for layering) and `conversationPersistence`.
- The manager resolves a conversation's settings once, before any durable write: in `create()` (context from the create
  input) and in `openOnce()` (context from the stored summary). The result is passed to `start()` (the
  `PersistedConversationLifecycle` is built with it and it is remembered for the life of the live conversation), to
  `recordConversationError` / `throwCreateFailure` (so create, load and recovery error records follow it) and reused for
  recovery without calling the resolver again. `appendAssistantMessage` uses the live conversation's settings, or asks
  the resolver for one that is not live.
- Rules implemented: the override replaces the Agent's value per key and `protocol` counts as one key;
  `undefined`, `{}` and `{ capture: {} }` mean the Agent's settings; identical overrides are validated and resolved once
  (cache by canonical JSON); a resolver that throws, returns a non-object, an unknown key, an unknown record kind or an
  invalid level rejects the start with that error, before any row, error record or provider session; `metadata`
  message capture is rejected while checkpointing is enabled; a non-function resolver is refused at `Agent.open`.
- `auditLog` and `meteringRecords` are part of the override type but rejected at run time with
  `... is not supported yet`, so nothing silently does nothing until Phase 7.

**Tested.** `test/agent-conversation-persistence.test.ts`, 19 tests:
- two conversations in one Agent with different capture (no stored messages for one; the event bus published only the
  other's);
- the context holds the create input, and after a restart `open()` passes the stored summary, with the policy applied;
- the resolver is called once for a live conversation (per-record writes never call it);
- a live conversation keeps its start-time policy after the resolver's answer changes, and the next `open()` uses the
  new answer;
- an Agent without a resolver is unchanged;
- `appendAssistantMessage` follows the conversation's capture;
- eight invalid answers (throws, non-object, unknown key, unknown kind, invalid level, audit key, metering key,
  `metadata` with checkpointing) each reject the start and leave no conversation row; a non-function resolver is
  refused at `Agent.open`;
- a load failure writes an error record under the Agent's policy (control) and none under `capture.error: "none"`,
  while still throwing `ProviderSessionError`;
- unit tests of `ConversationSettingsResolver` (per-key replacement, `protocol` replaced whole, no-op answers, caching).
Whole suite: `bun test` 916 pass / 0 fail (897 before); `tsc --noEmit` clean.

**Gaps.**
- Not covered by a test: the recovery path (a `recovery_failed` record and the recovered thread following the
  conversation's policy and not calling the resolver a second time); handoff, switch and reset keeping the policy (true
  by construction, since the same lifecycle object is kept, but not asserted); a resolver that throws when `open()` is
  called on a conversation that already exists (the code path is the same as `create()`).
- Scope of "applies to every write" is smaller than 9-24 promises, on purpose (Phase 7): checkpoint `native_action`
  records, detailed metering retention, audit capture and audit exclusion still follow the Agent's settings.
- The Agent-level guard `conversation checkpointing requires message capture at content or raw level` is unchanged, so
  the pattern "Agent default `none`, selected conversations `content`" is not possible yet (Phase 7 relaxes it).
- `adopted` is always `false` until Phase 2 stores it on the row.
- The cache is per resolver instance and unbounded; a consumer that returns many distinct overrides grows it.

**Regressions.** None in the suite. One deliberate change of error precedence: `appendAssistantMessage` now reads the
conversation before checking the capture level (it needs the conversation's own settings), so for a conversation that
does not exist the error is `unknown active conversation` even when the Agent's capture would also have rejected the
append. No test relied on the old order.

---

## Phase 2: adoption storage (schema version 13, the `adopted` flag, lookup by provider session)

**Done.**
- Schema version 13 (`src/persistence/sqlite-schema.ts`): `conversations.adopted INTEGER NOT NULL DEFAULT 0` and
  `conversations.adopt_provider_session_id TEXT` (in the base schema for new databases, and as guarded `ALTER TABLE`s for
  versions 8 to 12); `provider_sessions_internal_idx` on `provider_sessions(internal_session_id)` (not unique: two
  conversations may already share a session in existing data). Version 12 is now in the accepted list.
- Types (`src/persistence/backend.ts`): `AgentConversationSummary.adopted?` and `.adoptProviderSessionId?` (present only
  when true, so existing summaries are unchanged), `CreateAgentConversationInput.adoptProviderSessionId?`, and an
  optional `ProviderSessionPersistence.conversationsUsing?(internalSessionId)` so custom backends are not forced to
  implement it.
- `src/persistence/sqlite-provider-sessions.ts` (new): `conversationsUsingProviderSession`: conversations whose active
  provider session is that id, plus conversations that asked to adopt it and have not attached a session yet (a failed
  adoption keeps its claim); deleted conversations hold nothing. `sqlite-backend.ts` only gained the INSERT columns,
  the summary mapping and a three-line method that calls it.
- The manager's `ConversationPersistenceContext.adopted` now comes from the stored flag.

**Tested.**
- `test/persistence-adoption-storage.test.ts`, 8 tests: the flag and the requested session id round-trip through
  create/get/list; an ordinary conversation carries no adoption fields; a claim without a session holds; the active
  session is owned; a replaced claim and a deactivated session are free; deleted conversations own nothing; owners come
  back oldest first; a simulated version 12 database (columns and index dropped, version row reset) migrates to 13, keeps
  its conversation, and gains the columns, the index and the version row.
- Full suite: `bun test` 924 pass / 0 fail (919 before this phase's tests were added to the earlier 916); `tsc` clean.

**Gaps.**
- The version 12 database is simulated from a fresh one (drop the new columns, reset the version), not a database
  written by the previous release. Real databases written by an old build were not available to test against.
- `conversationsUsing` is a read; the check "refuse a second adoption" is Phase 3. Nothing prevents two concurrent
  adoptions of the same session between the check and the insert (no unique constraint on purpose; see above); that
  race is for Phase 3 to close, probably by doing check and insert in one transaction.
- Custom backends without `conversationsUsing` will not be able to refuse a second adoption; Phase 3 must decide
  whether `adopt` then fails or proceeds without the check (leaning: fail, with a clear message).

**Regressions (all fixed, in test code).**
- Five tests in `test/persistence-sqlite-backend.test.ts` failed after the schema bump: four old-version migration tests
  simulate an old database by dropping columns from a fresh one and did not know the two new columns
  (`duplicate column name: adopted`), and the pre-release-schema test hard-codes the current version (12 to 13). The
  four downgrade scripts now also drop the new index and columns, and the version assertions are 13. The migration code
  is unchanged; real old databases do not have the new columns.
- One failure in `test/session-manager-restoration.test.ts` ("reactivates a tombstone with its retained transcript")
  appeared once in a full run and did not reproduce: four isolated runs and the next full run all passed. It is in the
  legacy session-manager layer and nothing in this phase touches it; treated as an intermittent test under load, not
  investigated further. Noted here in case it shows up again.
