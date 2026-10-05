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
