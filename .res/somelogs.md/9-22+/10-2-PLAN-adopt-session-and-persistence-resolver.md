# Plan: session adoption first, then the rest of the persistence policy

Status: proposed.

Specs:

- `10-2-SPEC-adopt-provider-session.md` (the adoption spec; **prioritized**)
- `9-24-SPEC-conversation-persistence-policy.md` (the resolver; only the part adoption needs
  goes first, the rest follows)
- `10-2-TODO-attach-and-identity-false.md` (not in this plan)

The approach: restructure the files adoption has to touch **first**, with no behavior change, so
the new code lands in small modules and the large files do not grow.

## 1. Codebase review

Source is about 62k lines including tests. The relevant files:

| File | Lines | Notes |
|---|---|---|
| `src/agent-session.ts` | 4411 | The older single-session layer. Largest file. Not touched by this plan beyond a possible small seam (see Spikes). |
| `src/persistence/sqlite-backend.ts` | 2205 | All SQLite persistence in one file. |
| `src/agent.ts` | 1627 | Holds five unrelated things, see below. **The main target.** |
| `src/persistence/transcript-reader.ts` | 1212 | Not touched. |
| `src/persistence/sqlite-schema.ts` | 678 | Schema and migrations. Adoption adds a migration here. |
| `src/persistence/sqlite-conversation-records.ts` | 472 | Already split out of the backend; the right home for new conversation SQL. |
| `src/persistence/error-records.ts` | 104 | Small, already separated. |
| `src/out-of-band-messages.ts` | 187 | New (untracked). Candidate mechanism for the recap. |

`src/agent.ts` is the file adoption and the resolver both change. It contains, in one file:

| Lines | Content |
|---|---|
| 114–212 | Config and public interface types (`AgentConfig`, `CreateAgentConversationConfig`, `AgentConversationManager`, ...) |
| 213–567 | `Agent` class (about 350 lines) |
| 568–1180 | `ManagerSettings` and `DefaultAgentConversationManager`: create, open, start, recovery, error recording, metering locks (about 600 lines) |
| 1180–1435 | `PersistedConversationLifecycle`: the write path for every record (about 255 lines) |
| 1435–1627 | Free helpers: observation persistence, `captureRuntimeRecord`, `enqueueAuditObservation`, error details |

Adding the resolver (policy carried through `ManagerSettings`, the lifecycle and the helpers) and
adoption (new branches in `create`, `start`, `open`, failure handling) to this file would push it
past 2000 lines and tangle the two features through the same classes. The restructure below
prevents that.

The persistence and conversation-owner code is already partly separated
(`agent-conversation-*.ts`, `persistence/*`, `checkpointing/*`). The plan follows that existing
direction and does not reorganize anything it does not need to touch.

## 2. Principles

- **Refactor first, in commits that change no behavior.** The existing tests pass unchanged after
  each one.
- **New behavior goes in new modules.** The large files receive only thin call sites.
- **Size budget.** A new file stays under about 400 lines. No existing file over 1000 lines
  grows by more than a few lines of wiring. `agent-session.ts` and `sqlite-backend.ts` do not
  grow.
- **Public API is unchanged by the refactor.** `src/agent.ts` stays as a facade that re-exports,
  so `src/index.ts` and consumers see no difference.
- **One concern per module**, named after what it does, not after the feature.
- **Tests per phase**, not at the end.

## 3. Target structure

```
src/agent.ts                         facade: re-exports only (about 20 lines)
src/agent/
  config.ts                          AgentConfig, create/open config, result types, manager interface
  agent.ts                           class Agent
  conversation-manager.ts            DefaultAgentConversationManager: create/open orchestration only
  conversation-start.ts              start(), prepareStart(), provider-session start/recovery
  conversation-errors.ts             recordConversationError, throwCreateFailure, error details
  persisted-lifecycle.ts             PersistedConversationLifecycle
  record-capture.ts                  captureRuntimeRecord, enqueueAuditObservation, observation persistence
  persistence-policy/
    types.ts                         override, context, resolver types
    resolve.ts                       resolution, validation, memoization
    index.ts
  adoption/
    config.ts                        AdoptProviderSessionConfig and defaults
    validate.ts                      pre-row checks
    replay-capture.ts                capturing and filtering the session/load replay
    recap.ts                         recap request and seeded checkpoint
    provider-sessions.ts             listProviderSessions
    index.ts
src/persistence/
  sqlite-provider-sessions.ts        provider-session lookup by ID, failed-adoption record
  (migration entry in sqlite-schema.ts, following the existing pattern)
```

Splitting `DefaultAgentConversationManager` further than `conversation-manager.ts` /
`conversation-start.ts` / `conversation-errors.ts` is deliberately not planned. Those three
already separate orchestration, the provider start path and error recording, which are the three
areas the new features touch.

## 4. Phases

### Phase 0: structural preparation (no behavior change)

Goal: put the seams where the new code will attach.

1. `refactor: move agent config and interfaces to src/agent/config.ts`
2. `refactor: move PersistedConversationLifecycle to src/agent/persisted-lifecycle.ts`
3. `refactor: move capture and audit enqueue helpers to src/agent/record-capture.ts`
4. `refactor: move conversation error recording to src/agent/conversation-errors.ts`
5. `refactor: split DefaultAgentConversationManager into manager and start modules`
6. `refactor: carry a resolved persistence policy per conversation` (the 9-24 sequence step 1)
   - Split the per-conversation part out of `ManagerSettings`.
   - The lifecycle and error recording receive it.
   - `enqueueAuditObservation` takes the projecting capture and its fingerprint.
   - With no resolver the policy is the Agent defaults, so there is no behavior change.
7. Leave `src/agent.ts` as the re-exporting facade.

Gate: the full existing test suite passes with no test changes. `src/index.ts` exports are
unchanged.

Step 6 is the first piece of the 9-24 spec and is a prerequisite for both features.

### Phase 1: the minimal resolver (the part of 9-24 that adoption needs)

Scope: canonical capture only.

- `persistence-policy/types.ts` and `resolve.ts`: `AgentConversationPersistenceOverride`
  (with only `capture` active for now), `ConversationPersistenceContext` (including `adopted`,
  defaulting to `false` until Phase 2), `ConversationPersistenceResolver`,
  `AgentConfig.conversationPersistence`.
- Resolution at conversation start, held on the lifecycle (9-24, "When the policy is resolved").
- Validation reusing the existing capture resolvers; a resolver failure at start rejects before
  any write.
- Memoization by canonical JSON.
- Export the types from `src/index.ts`.

Tests (from the 9-24 list): 1, 2, 5 (the capture-related cases), 6, 7, 8, 15, 16.

Deliberately **not** in this phase: `auditLog` and `meteringRecords` overrides, fingerprint
changes, checkpoint action records, the relaxed checkpoint guard, background-write resolution,
`error` record policy changes beyond receiving the resolved policy. The override type accepts
those keys but they are rejected with "not yet supported" until Phase 6, so a consumer cannot
rely on something that silently does nothing.

### Phase 2: adoption storage

- Migration: `adopted` column on the conversation row, default `false`.
- `sqlite-provider-sessions.ts`: lookup of the owning conversation by provider session ID, backed
  by a new index on `provider_sessions`.
- A place to keep the `providerSessionId` of a failed adoption (decide: column on the
  conversation row or the error record's details; the spec leaves it open).
- Feed `adopted` into `ConversationPersistenceContext` from the stored row.
- Backend interface additions in `persistence/backend.ts` are minimal; implementations live in the
  new SQLite module, not in `sqlite-backend.ts`.

Tests: migration on an existing database, lookup by session ID, `adopted` round-trips and reaches
the resolver after a restart.

### Phase 3: adoption core (no recap)

- `adoption/config.ts` and `validate.ts`: pre-row checks (content capture required, `recap`
  requires checkpointing, session not already bound).
- `create({ adopt })` in the manager: validation inside `prepareStart`, row with `adopted = true`,
  `start(..., "load")` with the supplied session ID.
- Failure path: error record, row kept, `open()` of a failed adoption retries or refuses and
  never creates a new session.
- `adoption/replay-capture.ts`: capture the `session/load` replay and write it through the normal
  capture path according to `importHistory`, including `{ last: n }` at a turn boundary.
- Cursor placed after the adopted history.

Tests: adoption of a fake provider session; each validation failure writes nothing; a missing
`loadSession` capability and a failed load keep the row and record the error; `open()` on a failed
adoption; double adoption refused with the owner named; `importHistory` false, true and
`{ last: n }`; resolver sees `adopted: true`.

`test/fixtures/echo-prompt-agent.ts` is the likely base for the fake provider; extend it to
support `session/load` with a replay.

### Phase 4: recap

Starts with a spike (see section 5). Then:

- `adoption/recap.ts`: the recap request (fork where available, otherwise a hidden turn), seeded
  checkpoint record with a distinct origin, "recap pending" state and retry.
- Decide whether `create({ adopt })` waits for the recap.
- Wire the cursor so the periodic summarizer continues after the adopted history.

Tests: recap stored as the first checkpoint; nothing written to the chat; failed recap leaves a
usable, pending conversation that retries; identity delivers the recap plus the imported tail to a
sibling conversation; first user message queues behind the recap.

### Phase 5: session listing

- `adoption/provider-sessions.ts`: `listProviderSessions`, built on `client.listSessions()` and the
  existing catalog (`session-manager.ts`, `session-store.ts`), with `adoptedBy` filled from the
  lookup added in Phase 2.

Tests: capability missing throws a structured error; `adoptedBy` populated; cwd scoping.

### Phase 6: removal methods (separable)

`clearTranscript()` and `delete({ providerSession, checkpoints })` from the adoption spec. Independent
of the phases above; can move earlier or later. Needs the open decision about derived checkpoints
for `clearTranscript()`, or ships `delete` first.

### Phase 7: the remainder of the 9-24 spec (after adoption)

In the order of the 9-24 implementation sequence, minus what Phases 0 and 1 already did:

1. `fix: stamp audit entries with the fingerprint of the projecting policy` (9-24 step 2)
2. `fix: apply capture and audit policy to checkpoint action records` (step 3)
3. Resolver completion (step 4): `auditLog` overrides and exclusion, `meteringRecords`, resolution
   before background writes, relaxed checkpoint guard, the "not yet supported" rejections removed.
4. Tests 3, 4, 9–14 from the 9-24 list (step 5).
5. Consumer guide documentation (step 6).
6. Hub follow-up (step 7).

Docs for adoption (`CONSUMER_GUIDE.md`) land at the end of Phase 5.

## 5. Spikes to run before the phase that needs them

| Before | Question | How |
|---|---|---|
| Phase 3 | Where does the `session/load` replay go today? Does `AgentSession` discard it, or can the conversation observe it so it can be captured? | Read the load path in `agent-session.ts` and the conversation owner contract. If a hook is needed, add the smallest seam there and put the logic in `replay-capture.ts`. |
| Phase 3 | Can replay notifications be told apart from live updates, and do they identify turn boundaries? | Run against the fixture agent and one real adapter. |
| Phase 4 | Can a hidden recap turn run without being recorded as a conversation message, given the capture pipeline? | Read `src/out-of-band-messages.ts` and the internal-inference path. |
| Phase 4 | Does the checkpoint record contract allow a distinct "seeded baseline" origin without a record schema change? | Read `checkpointing/contracts.ts` and the records schema. |
| Phase 2 | How are migrations written, and does the custom-backend interface need a version bump? | Read `sqlite-schema.ts`, `migration.ts`, `backend.ts`. |

## 6. Risks

- **Phase 0 touches many call sites.** The refactor is mechanical, but `agent.ts` holds private
  state shared between the manager and lifecycle (metering locks, `live`, `openings`). The split
  must keep those inside the manager and pass explicit dependencies, not widen their visibility.
- **`agent-session.ts` may need a seam for replay capture.** If the replay is unavailable at the
  conversation level, Phase 3 grows. The spike decides this early.
- **Hidden recap turn.** If it cannot be kept out of the recorded conversation, the fallback is the
  scratch-session approach from the design discussion (more expensive, works anywhere).
- **Partial resolver in Phase 1.** Rejecting audit and metering keys until Phase 7 is a visible
  limitation of the intermediate release; it must be documented, not silent.
- **Migration on existing databases.** The `adopted` default and the new index must apply cleanly to
  databases from earlier releases.

## 7. Order, dependencies and releases

```
Phase 0 -> Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5 -> Phase 7
                                      \-> Phase 6 (any time after Phase 0)
```

- Phases 0 and 1 can be released on their own (the resolver is useful to the Hub already for
  capture).
- Phases 2–5 make up the adoption release.
- Phase 7 completes the 9-24 spec. Its fixes (fingerprint stamping, checkpoint capture) are
  separable and may land earlier if wanted.

## 8. Definition of done

- Adoption works end to end as specified, including failure and retry.
- The resolver supports canonical capture; the unsupported keys fail explicitly.
- `src/agent.ts` is a facade, and no new file exceeds the size budget.
- `agent-session.ts` and `sqlite-backend.ts` have not grown beyond a few lines of wiring.
- Existing tests pass unchanged after Phase 0, and every phase adds its own tests.
- `CONSUMER_GUIDE.md` documents the adoption API and the resolver's capture behavior.

## 9. Later: steering, and making it the default (major release)

Separate from adoption and the persistence resolver; independent of them. Not designed in detail
yet. Summary of the current direction:

- A message sent while a turn is running is accepted as **pending**, with an id. It is delivered
  automatically at the next tool boundary (`steer`), or at turn end, and the consumer can
  **promote** it (cancel the turn and send it now) or **withdraw** it. Interrupt is a promotion
  of steer, not a third mode. `queue` remains available per message.
- Guarantee: delivered no later than the end of the turn, at the earliest clean tool boundary,
  with no dependence on harness or model support (no MCP, no adapter queue).
- Consumer API: `prompt(text, { delivery })` with an id-carrying handle, plus `promote(id)`,
  `withdraw(id)` and `pendingMessages`. New events on the existing stream: `message_pending`,
  `message_delivered` (with `via`), `message_withdrawn`, `message_merged`. The interrupted turn's
  result says why it ended (`endedBy: "steer"`, `followedBy`). Queued prompts share the same
  pending list and events.
- Setting: a busy-delivery key in the shared conversation config (`conversationDefaults` on the
  Agent, `runtime` per conversation, `delivery` per prompt).
- Code goes in a new module (for example `src/steering/`) with thin call sites in
  `agent-session.ts`, which must not grow.
- **Smoke test first:** `smoke-tests/test11-steerTurn`, covering (a) the overall steer behavior
  across adapters, including the boundary race and what each harness does with a cancelled
  turn, and (b) metering of cancelled and follow-up turns, especially OpenCode
  (`billing_required`). The results decide how cancelled turns are handled in metering,
  checkpoint scheduling and presentation.

### Release sequencing

1. Ship steering with the busy-delivery default left at `queue`, so existing consumers are
   unaffected. Consumers opt in through configuration.
2. Make `steer` the default in a **major release**. That is a behavior change (a mid-turn
   `prompt()` now cancels the turn at the next tool boundary where it used to wait), so it goes
   with other breaking changes.
3. The adoption work (sections 4 to 7) is expected to be released in that same major version, so
   the two share one migration note.

Full design: `10-2-SPEC-steer-pending-messages.md`.
