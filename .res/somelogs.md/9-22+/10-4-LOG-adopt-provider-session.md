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
- Full suite: `bun test` 924 pass / 0 fail (916 before, plus the 8 new tests); `tsc` clean.

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

---

## Phase 3: adoption core (`create({ adopt })`, failure and retry, replay import)

**Done.**
- `CreateAgentConversationConfig.adopt: { providerSessionId, importHistory?: boolean | { last: number } }`
  (`src/agent/adoption/config.ts`, validated by `normalizeAdoption`). Default `importHistory` is `false`.
- Replay seam: `StartSessionOptions.onReplayUpdate` (client), `AgentControllerConfig.onSessionReplay`,
  `ProviderSession.load.onReplay` and the constructor of `AgentSession`, so the replay of a `session/load` reaches the
  library instead of being dropped on the connect path.
- Flow (`DefaultAgentConversationManager.createAdopting`): the resolver is asked with `adopted: true`; before any write
  the checks run (blank id, bad tail, the conversation's message capture must be `content` or `raw`, degraded mode is
  refused by the existing `prepareStart`); the ownership check and the row are one transaction (no concurrent double
  adoption); then the provider starts with `session/load`; on success the `provider_sessions` row is written (identity
  delivery cursors reset) and, if asked, the replay is imported.
- Failure follows `create()`: the error is recorded (classified like a load failure, under the conversation's policy), a
  `ProviderSessionError` is thrown and **the row stays**. `open()` of an adopted conversation with no recorded provider
  session retries the load of the session it asked for, records it on success, and never starts a new session.
- New `ProviderSessionInUseError` (`code: "provider_session_in_use"`, `ownedBy`), exported.
- Replay to records (`src/agent/adoption/replay.ts`, `AgentSession.importHistory`): replayed updates become turns (a turn
  starts at each user message; assistant messages are bounded by `messageId`); messages are written as the live path
  writes them (one record per user and assistant message, `imported: true` and `providerMessageId` in the metadata, the
  time of the import), and tool calls and thoughts go through the same activity aggregator and capture levels as a live
  turn. Command lists, mode, config, usage and session-info updates are skipped.

**Tested.**
- `test/agent-adoption.test.ts`, 20 tests, against a new scripted agent `test/fixtures/replay-agent.ts` that replays a
  known history on `session/load`: attach and prompt after adopting; reopen after a restart (loaded, recorded once); the
  resolver sees `adopted: true`; `importHistory: true` stores messages (in order, marked imported), tool calls and no
  thoughts by default; thoughts stored in replay order when captured; `{ last: 1 }`; kinds follow the conversation's
  capture and a resolver can single out adopted ones; validation failures leave no row; degraded mode refused before the
  row; a session already adopted is refused naming its owner and is free again after that conversation is deleted;
  two simultaneous adoptions (one wins); a session the provider does not have (row stays, error recorded, `open()`
  retries and never starts a new session, the claim still holds); retry succeeds once the session exists; an agent without
  `loadSession`; replay-to-turns unit tests (merging chunks, `messageId` boundaries, the Codex tool-call-after-next-user
  quirk, an assistant-first history, `selectTail`, `normalizeAdoption`).
- Whole suite: `bun test` 944 pass / 0 fail (924 before; 20 new); `tsc` clean, also with `--noUnusedLocals`.

**Gaps.**
- Only a scripted agent was used. Adoption against real Codex and OpenCode sessions was not run (the replay probe shows
  what they send; `test/fixtures/replay-agent.ts` copies those shapes). A smoke test against real sessions is planned
  after the listing API (Phase 5).
- A custom backend without `conversationsUsing` is refused with an error, but there is no test for it: the test could not
  reach the instance used inside a transaction without a backend double, which was not written.
- Retrying a failed adoption with `open()` loads and records the session but does not import history: the `importHistory`
  option is not stored with the row.
- If recording the session or importing the history fails after a successful load, the conversation is stopped and the
  error propagates; the row exists, so what remains is a conversation whose `open()` retries the load. A partly imported
  history is not rolled back (records are appended as they go).
- Importing with `importHistory: true` makes every imported message an identity source for the Agent's other
  conversations. A large history therefore floods them. The default is `false`, and Phase 4 (recap with a small tail)
  is the intended way to bring a conversation into memory.
- The first prompt after an adoption runs on a loaded thread whose usage counters did not start at zero; the metering
  engine treats it as needing a baseline. What that does to the first adopted turn's metering was not examined.
- Imported turns have no metering records and no `afterPrompt` commit; `latestSequence` and previews reflect them as
  ordinary records.

**Regressions.** None in the suite.

---

## Phase 4: the recap (the model summarizes its own history)

**Done.**
- `adopt.recap?: boolean`. When on, right after the session is attached and recorded, the library asks the adopted
  session to summarize itself with a **hidden turn** (`AgentConversation.requestRecap`, built on the existing
  `meteredInternalPrompt` that handoff and recovery already use): the exchange is metered (a metering reference record is
  written) and leaves `native_action` records (`adoption_recap` started/completed/failed), but it is not a message of the
  conversation. The answer is stored as an **assistant message** with `origin: "adoption_recap"` in its metadata
  (`AgentConversation.recordRecap`), ahead of the imported tail.
- Defaults: `recap` is `true` when the Agent's identity runtime shares conversations (it is not the no-op one), otherwise
  `false`; `importHistory` defaults to the last two turns (`DEFAULT_RECAP_TAIL_TURNS`) when a recap is made, otherwise
  `false`. Both can be set explicitly.
- `create()` waits for the recap and then returns, so nothing can interleave with it (the conversation is not yet in the
  consumer's hands). This is how the recap avoids needing its own operation kind in the queue for steering.
- A recap that fails does not fail the adoption: an `adoption_recap_failed` error record (retryable) is written, the
  imported tail is still stored, and the conversation works but is not in the Agent's memory.
- The instruction (`RECAP_INSTRUCTION`) asks for a self-contained summary (goals, decisions, state, open tasks, key facts),
  without running tools. The model decides how to compress; the library never summarizes a history.

**Deviation from the spec (to fold back into it).** The spec said the recap is stored "as the first checkpoint record".
A recovery checkpoint needs a row in the internal-inference tables (`generator_internal_inference_id` is a foreign key),
and there is no API to insert a completed inference: the only way in is `enqueue` then `claimNext`, which claims the next
due job of any conversation, not the one just enqueued. Running the recap through the internal-inference manager instead
would make its metering collide with the conversation's own. So the recap is a marked assistant message. Effects, all
tested: identity delivers it to the Agent's other conversations like any stored message; later periodic checkpoints
summarize it with the rest of the records; and unlike a checkpoint it sits in the message stream, so a UI that lists
messages will show it (it can recognize it by the `origin`). A true checkpoint can replace it later.

**Tested.** 6 new tests in `test/agent-adoption.test.ts` (26 in the file), using the replay agent extended to answer the
recap question (and to fail it on demand): the summary is stored first, marked, followed by the imported tail, and the
question itself is not stored as a message; native action and metering records exist; `importHistory: false` stores only
the summary; the defaults follow the Agent's identity; the Agent's other conversations receive the summary through
`identity.load` (checkpoint-backed identity); a failing recap is recorded and the adoption still succeeds and works;
`normalizeAdoption` defaults. Whole suite: `bun test` 950 pass / 0 fail (944 before); `tsc` clean.

**Gaps.**
- Not run against Codex or OpenCode. The model is only *asked* not to use tools: ACP has no way to forbid them for one
  turn. The conversation's default permission is `cancel`, so a tool that needs permission is refused, but a harness that
  auto-approves could run one during the recap.
- The recap is a hidden turn on the adopted session itself, so the provider's own history now contains the question and
  the answer (visible if the session is loaded elsewhere). Using `session/fork` where available was not done.
- No retry for a failed recap beyond the error record; a conversation adopted again through `open()` (a retried adoption)
  does not recap or import history.
- The recap and the imported turns carry an `operationId`, so they count as completed responses for the checkpoint schedule
  and may bring the first periodic checkpoint forward.
- With `recap: true` and `importHistory: true`, the Agent's other conversations receive both the summary and the whole
  history (within identity's character budget).
- The metering of the recap uses the existing operation kind `conversation_checkpoint`; no new kind was added, so it
  cannot be told from a checkpoint's metering by kind alone (the `adoption_recap` native action identifies it).
- `create()` can take as long as the model takes to summarize a long session; there is no timeout of its own.

**Regressions.** None.

---

## Phase 5: listing the provider's sessions, a smoke test on real sessions, and the guide

**Done.**
- `agent.conversations.listProviderSessions({ adapterId?, cwd?, limit? })` (`src/agent/adoption/provider-sessions.ts`):
  starts the harness for the call (an `AcpClient` built from the Agent's adapter and the conversations' launcher / env /
  cwd defaults), follows the provider's pages up to `limit` (default 100), stops the harness, and returns
  `{ providerSessionId, cwd, title?, updatedAt?, adoptedBy? }`. `adoptedBy` comes from `conversationsUsing`, so a session
  with a failed adoption's claim shows as owned. New `ProviderSessionListUnsupportedError` when the agent does not
  advertise `session/list`. Added to the `AgentConversationManager` interface; types and error exported.
- `smoke-tests/test12-adoption/`: lists, adopts, imports, and checks against a real harness (agent.sqlite appears in the
  directory, like `end-to-end`). By default it makes no model call.
- `CONSUMER_GUIDE.md`: a section "Adopt a session the provider already holds".
- `smoke-tests/.gitignore`: fixed a line of mine from an earlier step that had been merged into the previous pattern
  (`**/*.sqlite*test11-steerTurn/results.json`), which stopped `results.json` and `*.sqlite*` from being ignored separately.

**Tested.**
- 5 new tests in `test/agent-adoption.test.ts` (31 in the file), with the replay agent extended with `session/list`
  pagination and an option to not advertise listing: the listing and `adoptedBy` before and after an adoption (and that
  listing creates nothing); a failed adoption's claim keeps the session owned; pagination and `limit` (including a bad
  limit); the structured error for an agent that does not list; an unknown adapter.
- Real harnesses, no model call (`smoke-tests/test12-adoption`):
  - Codex (`codex-acp` 2.1.1): listed 10 sessions, adopted a 3-turn session with `importHistory: all`: 6 messages and 3 tool
    calls stored, marked imported; adopting again refused naming the owner; the listing showed the owner; the conversation
    reopened by loading the same session. All checks passed.
  - OpenCode (1.18.32): the same with `{ last: 2 }`: 4 messages, 1 thought and 4 tool calls stored; all checks passed except
    the listing check, which the script now skips when the adopted session is not among those listed (OpenCode returned only
    20 sessions even for a limit of 500, and the test session was older).
- Whole suite: `bun test` 955 pass / 0 fail (950 before); `tsc` clean.

**Gaps.**
- The recap (`ACP_TEST12_RECAP=1`) was not run against a real harness: it spends tokens and was not authorized. The recap
  and its interaction with real agents' tool use and permission policies are unverified.
- The listing starts a harness process per call; there is no reuse of a connection and no cache. A UI that lists often will
  start and stop the harness each time.
- The provider decides what `session/list` returns: Codex listed sessions of every working directory, including sessions the
  library's own internal inference created (checkpoint summaries); OpenCode returned only 20. `adopt` accepts any id, so a
  session that is not listed can still be adopted if the id is known.
- `cwd` filtering is passed to the provider as is; whether a provider honours it was not checked beyond Codex ignoring it
  in this run (it listed sessions of other directories).
- The guide section is new text with no automated check.

**Regressions.** None.

---

## Phase 6: clearing a transcript and deleting a conversation

**Done.**
- `agent.conversations.clearTranscript(id, { checkpoints? })` -> `{ recordsDeleted, checkpointsDeleted }`: physically
  deletes every record of the conversation (the detail rows and full-text entries cascade), keeps the conversation row,
  participants and provider sessions, and does not reuse sequence numbers. Refuses an unknown or deleted conversation and a
  live conversation that is busy. New optional persistence methods
  `ConversationRecordPersistence.deleteForConversation?` and `ConversationRecoveryCheckpointRepository.deleteForConversation?`
  (implemented for SQLite; counted before deleting, because SQLite's `changes` also counts cascaded rows).
- `agent.conversations.delete(id, options?)` now takes `string | { deletedAt?, providerSession?: "best-effort" | "no",
  checkpoints? }` and returns `{ providerDeleted: true | false | "unsupported", checkpointsDeleted }` (it returned `void`;
  a string second argument still means the deletion time). Provider deletion is `AcpClient.deleteSession`
  (`session/delete`, capability checked; transport method added) run through `deleteProviderSession`
  (`src/agent/adoption/provider-session-delete.ts`): starts the harness, deletes, stops, and reports `true`,
  `"unsupported"` or `false`. The local soft delete happens first; a provider failure never undoes it.
- Types exported (`DeleteConversationOptions`, `DeleteConversationResult`, `ClearTranscriptOptions`,
  `ClearTranscriptResult`); guide section added.

**Resolved from the spec's open questions.** What `clearTranscript` does to derived checkpoints: they are kept unless
`checkpoints: true` (and `delete` has the same option); the guide says what that implies for what other conversations can
still receive.

**Deviation from the spec.** The spec put both methods on the conversation (`conversation.clearTranscript()`,
`conversation.delete()`). They are on `agent.conversations` and take an id, because the conversation may not be live (a
stopped or never-opened conversation has no object) and the existing `delete` already lived there.

**Tested.** `test/agent-conversation-removal.test.ts`, 10 tests (replay agent extended with `session/delete`, an option to
not advertise it and one to make it fail; the steering agent for the busy case): records and detail rows and full-text
entries are gone while the conversation, participants and provider session stay, and a later prompt's sequences continue
past the deleted ones; another conversation is untouched; checkpoints deleted only when asked (a real checkpoint is built
through the internal-inference repository); refusals (unknown, busy, deleted); the legacy string argument; best-effort
deletion removes the session at the provider (checked in the provider's own list); `"unsupported"` and failure results leave
the session in place; `"no"` and the default leave it and the session can be adopted again; a conversation with no recorded
provider session; checkpoints deleted with the conversation. Whole suite: `bun test` 965 pass / 0 fail (955 before);
`tsc` clean. No-token check of real capabilities: Codex advertises `session/delete`, OpenCode does not.

**Gaps.**
- `session/delete` was not run against a real harness (destructive); only the fixture exercises it. Codex advertises it.
- Everything about "forgetting" is documented, not solved: audit entries, identity state derived from records
  (`identity_memories`, snapshots), other conversations' provider sessions that already received the content, and the
  provider's own history stay.
- No event is published for a deletion, so the committed-record bus and any subscriber's view go stale.
- A live, idle conversation keeps its in-memory activity state after `clearTranscript`; only stored records go.
- Clearing deletes every record kind, including error records and metering references; there is no way to clear only
  messages.
- A backend without `deleteForConversation` refuses `clearTranscript` with an error; there is no test for a custom backend.

**Regressions.** None. The return type of `delete` changed from `void` to an object, which source-compatible callers do
not notice but a consumer that implements `AgentConversationManager` itself would have to follow.

---

## Phase 7: the rest of the persistence-policy spec (audit, metering, checkpoints)

**Done.** The remainder of `9-24-SPEC-conversation-persistence-policy.md`, in the order of its implementation sequence:
- **Fingerprint stamping.** `SqliteAuditOutboxPersistence.enqueue` no longer overwrites `agent_audit_state.capture_fingerprint`
  with each item's fingerprint; only `initialize` writes it, so the state holds the Agent's base policy while an entry
  carries the fingerprint of the policy that projected it.
- **Audit overrides.** `resolveConversationAuditConfig` (`src/audit/config.ts`): the Agent's destination unchanged, its
  capture layered over by the conversation's override, its own fingerprint (the base object itself when the override changes
  nothing); agent-scope kinds are refused (`conversation audit capture cannot select agent-scope kind: identity`).
  `ManagerSettings.auditCaptureConfig` keeps the Agent's capture as configured. In the resolver, `auditLog: false` sets the
  conversation's audit settings to none (so the lifecycle, the error records and the checkpoint record enqueue nothing), an
  object needs an Agent audit log (`conversation audit capture requires an Agent audit log`; `false` is accepted either way).
- **Exclusion.** `identity` entries are skipped for an excluded conversation (`updateConversationIdentity`), and
  `internal_inference` audit observations about one are not written (`DefaultAgentConversationManager.auditExcluded`, asked
  before each such observation). If the policy cannot be resolved, the observation is not written either and the error is kept
  as the pending audit-observation error.
- **Metering retention.** `meteringRecords` override (validated: `"all"`, `"none"` or `{ retain: n >= 1 }`), applied by the
  lifecycle and, through the new `ConversationWritePolicy`, to the detailed records of a conversation's internal inferences.
- **Checkpoint records and background writes.** `InternalInferenceManager` asks the Agent for the conversation's
  `ConversationWritePolicy` before an attempt runs (`resolveConversationWrites`; a failure fails the attempt through the
  normal retry rules and writes nothing). The checkpoint strategy appends its `native_action` record through the new
  `appendRecord` of the completion context, so it follows the conversation's `native_action` capture (stored or dropped) and
  audit policy, inside the completion transaction. Without a resolver the policy is the Agent's. Audit delivery is notified
  after commit.
- **Relaxed checkpoint guard.** An Agent may enable checkpointing with message capture `none`; only `metadata` is refused
  (Agent and per conversation). The previous message ("requires content or raw") is gone.
- Guide: a new section "Choose what each conversation persists". Phase 1's "not supported yet" rejections were removed.

**Tested.** `test/agent-conversation-persistence-policy.test.ts` (12 tests) and the Phase 1 file (updated):
- `auditLog: false`: no audit entry about the conversation or caused by its records (messages, identity, its
  checkpoint's internal-inference entries), while another conversation is audited; refusals (capture override without an Agent
  audit log, agent-scope kind) before any write; a load failure under `auditLog: false` is stored but not audited.
- a conversation's own audit capture and fingerprint: its entries use its level and content, the other's stay at the Agent's
  level and fingerprint, agent-scope entries and `status().captureFingerprint` stay the base; an override that changes
  nothing stamps the base fingerprint.
- the checkpoint record follows `native_action` capture and audit (dropped and unaudited for one conversation, stored and
  audited for another, the checkpoint itself exists for both); a resolver that throws during a background checkpoint fails
  the attempt and writes nothing.
- checkpointing with a default `message: "none"`: allowed with a conversation overriding to `content`, `metadata` refused; a
  conversation storing no messages has no successful responses counted, `request()` creates no checkpoint, a lost provider
  session throws; a sibling's identity context contains nothing from it.
- metering retention `none` keeps no detailed records (live turns and a checkpoint's inference) while another keeps them; an
  invalid retention is refused before any write.
- Whole suite: `bun test` 977 pass / 0 fail (965 before); `tsc` clean.

**Gaps.**
- The 9-24 test list items not covered: recovery with a resolver (records written by the recovered provider thread and a
  `recovery_failed` record following the policy; the resolver not called twice), and handoff/switch/reset keeping the
  policy (true by construction). Resolution of the policy for an audit observation that fails (the pending audit error) is
  implemented but not asserted.
- Behaviour change without a resolver: checkpoint completion records, which used to bypass capture and audit, are now stored
  at the Agent's `native_action` capture level (default `metadata`, as every other native action) and, if the Agent audits,
  audited. The existing suite did not notice; a consumer that relied on them being unaudited would.
- `agent_audit_state.capture_fingerprint` used to hold the last enqueued item's fingerprint and now holds the base policy; a
  reader that inferred "the latest policy" from it would see the difference.
- Each internal-inference audit observation about a conversation costs one extra read (the exclusion check), and each
  attempt one conversation read for its write policy.
- A conversation still receives identity from its siblings; the per-conversation switch (`identity: false`) is the parked TODO.
- The Hub follow-up in the spec lives outside this repository and was not done.

**Regressions.** None in the suite. The two Phase 1 tests that asserted "not supported yet" were rewritten for the real
behaviour.

---

## Final state

**Done.** Phases 0 to 7 of `10-2-PLAN-adopt-session-and-persistence-resolver.md` are committed on `session-loading` (commits
`680f7a8` to `b97cebd`, after the steering commit `9dd5005`). `agent.ts` went from 1637 to 427 lines after Phase 0 and is 467 at the end (the later phases added re-exports and wiring).

**Verified at the end.** `bun test` 977 pass; `tsc --noEmit` clean; the mock steering smoke test passes every check; adoption
was run against real Codex and OpenCode sessions (no model call) and passed (Phase 5).

**Intermittent test failures seen, not reproduced, not caused by a change in the failing area as far as could be told.**
1. `test/session-manager-restoration.test.ts` "reactivates a tombstone with its retained transcript and reports continuation"
   failed once in a full run (Phase 2); passed in four isolated runs and in the next full run.
2. `test/agent-session-config-persistence.test.ts` "ordered continuation falls back to a consumer reconstruction after load
   fails" failed once in a full run after Phase 7 (216 ms); it passed in eight isolated runs and in the next six full runs.
Both are in the older session layer and spawn processes; both look like timing under a loaded machine. If either returns, the
first thing to check is whether the replay seam (`onSessionReplay`, Phase 3) or the steering controller changed a startup
path they use.

**Not done, by design or for lack of authorization** (details in each phase's gaps):
- the recap and `session/delete` were not run against a real harness (token cost; destructive);
- adoption retry through `open()` does not import history or recap, and a failed recap has no retry;
- `attach` and per-conversation `identity: false` (parked TODOs); the Hub follow-up (outside this repository);
- the 9-24 tests for recovery under a resolver, and a custom-backend test for adoption/clearing;
- `conversation-manager.ts` was 658 lines after Phase 0 and is 1006 at the end (adoption, listing, removal and the write
  policy were added to it), against a 400-line budget in the plan; it was not split further. `agent-session.ts` grew from
  4467 to 4581 lines (`importHistory`, `requestRecap`, `recordRecap`), although the plan said it should only gain wiring.

---

## Review (2026-10-05)

A review of phases 0 to 7 against the specs and the plan. `bun test` 977 pass / 0 fail and `tsc --noEmit` clean before the
fix below; neither intermittent failure appeared.

**Fixed.**
- `ConversationSettingsResolver` refused a conversation's `message: "metadata"` whenever checkpointing was *configured*
  (`this.base.checkpointing` truthy), including `checkpointing: { enabled: false }`. It now checks `.enabled`, as the Agent-level
  guard does (`src/agent/persistence-policy/resolver.ts`). Test added in `test/agent-conversation-persistence.test.ts` (it fails
  without the fix).

**Verified (closes a Phase 2 gap).** The v13 migration was run on copies of real databases written by earlier builds:
`smoke-tests/test11-steerTurn/data/agent.sqlite` (v12: 13 conversations, 946 records) and
`smoke-tests/end-to-end/data/agent.sqlite` (v8: 4 conversations, 129 records). Both reached version 13 with the two columns and
`provider_sessions_internal_idx`, the same row counts, no foreign-key violations and `integrity_check` ok. The migration is one
way: an older build refuses a v13 database.

**Open findings (not fixed).**
1. Checkpoint `native_action` records at the default `native_action: "metadata"` capture lose their `output`
   (`checkpointId`, `coveredSequence`, `internalInferenceId`): `captureRuntimeRecord` strips `input`/`output` at `metadata`.
   Nothing in the library reads them, but a consumer might. Keep the output, or say so in the release note.
2. The recap is on by default when identity is shared, so `adopt` spends tokens by default, yet it never ran against a real
   harness. `create()` waits for it with no timeout, and tools the model runs during it are neither recorded nor audited
   (`meteredInternalPrompt` passes no handlers). Run `ACP_TEST12_RECAP=1` on Codex and OpenCode, or default `recap` to `false`.
3. A failed recap, or an adoption retried through `open()`, leaves the conversation out of the Agent's memory for good. The spec
   rejects "leave it out of memory" as a solve-later choice.
4. "`create()` waits, so nothing can interleave" is not strict: the conversation is in `live` during the recap, so `open(id)` with
   a caller-supplied id returns it as `already_open` and can prompt mid-recap; and an `open(id)` during the load sees an adopted
   row without a session and starts a second load.
5. `listProviderSessions` and `delete({ providerSession: "best-effort" })` start the harness with the Agent's
   `conversationDefaults` (launcher, env, cwd), not the conversation's runtime; a conversation opened with another env (for
   example another `CODEX_HOME`) is deleted against the wrong store and reports `false`.
6. `turnsFromReplay` merges consecutive user messages that have no `messageId` into one (Codex and OpenCode send ids; Claude Code,
   Pi and Kimi were not probed).
7. A resolver that throws inside the background audit check (`auditExcluded`) becomes the pending audit error, so
   `Agent.close()` throws it.
8. Step 6 of the spec's flow (place the checkpoint cursor after the adopted history) was not done; the imported turns and the
   recap count toward the checkpoint schedule.

**Release note items.** The one-way v13 migration; `delete()` returns an object instead of `void`; checkpoint records follow
`native_action` capture and audit (item 1); `agent_audit_state.capture_fingerprint` holds the base policy; checkpointing accepts
an Agent default of `message: "none"`.

---

## Phase 8: the checkpoint floor of an adopted conversation (2026-10-05)

**Why.** The review's open finding 8 (step 6 of the flow, not done), made concrete by a measurement: Codex refuses a message
past 1,048,576 characters, so summarizing stored records cannot be the way an adopted history is summarized.
`ConversationCheckpointStrategy.prepare()` serialized every message since the previous checkpoint (from sequence 0 if none)
into one prompt, so `importHistory: true` on a long session made the first scheduled checkpoint an impossible prompt, and
`classifyError` treated it as retryable. The recap is the only summary of a long provider history, because the model holds the
history itself.

**Design (discussed with the user before coding).** The whole transcript stays stored and readable; only the checkpoint
machinery has a floor. An adopted conversation gets a checkpoint at adoption: `coveredSequence` = the later of the recap
message and (last stored message − 50). With a recap its summary is the recap (`source: adoption_recap`); without one it is a
baseline with an empty summary (`adoption_baseline`). The recap stays a message too. Chaining then makes the strategy read only
what follows the floor.

**Done.**
- Schema v14: `conversation_recovery_checkpoints` rebuilt (SQLite cannot relax NOT NULL / CHECK): `generator_internal_inference_id`
  nullable, `source`, `responses_counted_after_sequence`, a CHECK tying each source to generator/summary. One-way, like v13.
- `ConversationRecoveryCheckpoint.source` and optional `generatorInternalInferenceId`; `publish` validates per source, includes
  `source` in the idempotency comparison; `successfulResponseCount` counts after the adoption checkpoint's base, so imported
  turns do not use up the milestones.
- `src/agent/adoption/checkpoint-floor.ts` (`publishAdoptionFloor`); `conversation-manager.ts` calls it after recap and import
  when the conversation checkpoints. A failure to place it is recorded (`adoption_checkpoint_floor_failed`) and does not fail the
  adoption.
- Strategy: tolerates a previous checkpoint with no summary; `MAX_CHECKPOINT_SOURCE_CHARS` (700,000) with a terminal
  `checkpoint_source_too_large`; recovery seed and identity treat an empty summary as absent.
- `withoutRecapTurns`: an earlier adoption's recap question (and its answer) is not imported as a turn.

**Tested.** `bun test` 995 pass, `tsc --noEmit` clean. New: v13→v14 migration on a v13-shaped table (row kept, foreign keys,
integrity); repository (sources and their rules, response count base, later checkpoints do not move it); strategy (reads only
after a baseline floor, no summary to fold; oversized source is terminal, one attempt, the model is never called); adoption
(recap as first checkpoint and response count; recovery seed has the recap once and the tail; 60-turn history imported whole with
and without recap; no floor when little is stored or checkpointing is off; failed recap leaves a baseline; identity does not
deliver an empty summary; delete with checkpoints removes it; replay containing the recap turn).

**Not tested / gaps.**
- Not run against a real harness: the floor does not touch the provider, but a recovery from one has only been exercised with
  the mock agent.
- The floor is 50 *messages*, not tokens: one turn with enormous tool output can still make the post-floor range too large;
  that now fails clearly instead of retrying, and checkpointing stays failed for that conversation until it is fixed by hand.
- `open()` retrying a failed adoption does not place a floor (it does not import or recap either).
- The tail size (50) is not configurable per adoption.

**Verified afterwards.** The v14 migration was run on copies of the real smoke-test databases: `end-to-end` (v8, 5 checkpoints,
129 records) and `test11-steerTurn` (v12, 946 records) both reached 14 with the same row counts, no foreign-key violations and
`integrity_check` ok.

---

## Default busy delivery is now `steer` (2026-10-05)

**Done (at the user's request).** A prompt sent while a turn runs now defaults to `delivery: "steer"` instead of `"queue"`
(`src/agent-session.ts`, `config.busyDelivery ?? "steer"`; the doc comment and `CONSUMER_GUIDE.md` say so, and how to keep
the old behaviour with `busyDelivery: "queue"`). This is a behaviour change for every consumer that sends while a turn is
running: the message is delivered at the next tool boundary (the running turn ends `cancelled`, `endedBy: "steer"`) instead of
waiting. It belongs in the release note next to the v13 and v14 one-way migrations.

**Tested.** `test/steering.test.ts`: "the default is steer" (replaces "the default is queue") and "busyDelivery: queue waits for
the turn to end". Full `bun test` run after the change: see below.

**Intermittent failures.** Seen once during this run, not reproduced on re-run: `session-manager-load` "loads the recorded
provider thread and continues publishing checkpoints" failed with `CheckpointValidationError: internalSessionActivatedAt must
not be after updatedAt` (a timestamp-ordering check in `persistence/checkpoint.ts`, reached from `runSetConfig`). That makes
three intermittent failures logged (with the two in the final state above); none has a known cause.

A second full run failed once in `session-manager-restoration` ("installs explicit replacement generations for deleted
artifacts"); that file and `session-manager-load` then passed three times in a row. Both sit in the same family as the earlier
`session-manager-restoration` failure, and none of these tests sends a prompt while a turn runs, so the new default does not
reach them. Not investigated further.
