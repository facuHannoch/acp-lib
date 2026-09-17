# AgentSession / AgentConversation refactor log

This log is updated after each completed and committed step. It records both the
architectural intent and the evidence used to verify each change.

## Step 1 — Architecture and invariants

### Completed

- Defined the target ownership hierarchy:
  `AgentSession -> AgentConversation -> AgentController`.
- Chose `ags-` for stable agent-level IDs and `agc-` for stable conversation IDs.
- Defined `internalSessionId` as provider-owned and replaceable rather than a
  logical identity.
- Removed the idea of a privileged main conversation from the core model.
- Recorded that each agent stores only its own locally observed conversations;
  agent-to-agent conversations are not mirrored or transactionally replicated.
- Kept identity opaque and agent-scoped. No fact/memory/RAG representation is
  imposed by the library.
- Preserved explicit persistence locations and the intended one-database-per-agent
  topology.
- Recorded SQLite as the intended online backend and JSONL as a retained
  compatibility/export/archive option, without implementing either change yet.
- Separated stable participant attribution from authentication or authorization.
- Reserved discovery, incoming-message routing, messaging tools, MCP/native tool
  adapters, and identity merge semantics for the post-refactor design pass.
- Defined a seven-step behavior-preserving refactor sequence and an explicit
  compatibility rule: the current exported `AgentSession` name is not silently
  repurposed while consumers still depend on it.

### Files

- `.res/ARCHITECTURE-agent-conversations.md`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Compared the target terminology against the current `AgentSession` and
  `AgentController` responsibilities.
- Checked the existing persistence and session notes so this document supersedes
  only the newly discussed ownership model, not unrelated protocol decisions.
- No runtime source changed in this step.

## Step 2 — Stable identifier vocabulary

### Completed

- Added branded `AgentSessionId` and `AgentConversationId` types.
- Added the authoritative `ags-` and `agc-` prefixes.
- Added collision-resistant ID generators backed by `randomUUID()`.
- Added strict predicates and parsers for persisted/external values.
- Exported the primitives from the package's public surface.
- Deliberately did not apply the new validation to existing records yet. Current
  releases accepted arbitrary and UUID-only `agentSessionId` values; rejecting
  those during a structural refactor would break persisted data and tests. The
  migration layer will translate legacy IDs explicitly when the new owner is
  introduced.

### Files

- `src/agent-ids.ts`
- `src/index.ts`
- `test/agent-ids.test.ts`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Unit coverage checks prefixing, uniqueness, disjoint namespaces, parsing, and
  rejection of legacy/invalid shapes.
- Typecheck and the focused test are run before this step is committed.

## Step 3 — Conversation contracts and errors

### Completed

- Moved public lifecycle, continuation, recovery, configuration-resolution,
  handoff, notification, prompt-result, activity-capture, and provider-session
  contracts out of the 3,600-line implementation module.
- Moved public conversation errors into a dependency-light error module.
- Named the new boundary `agent-conversation-*` to reflect that these contracts
  describe the role which will become `AgentConversation`.
- Preserved the established `AgentSession*` symbol names temporarily and
  re-exported every moved symbol from `agent-session.ts`. Existing direct and
  package-barrel import paths therefore remain source-compatible.
- Kept `AgentSessionOpenResult` beside the implementation for now because it
  contains the concrete compatibility class. It will move when the actual
  `AgentConversation` class boundary exists.

### Files

- `src/agent-conversation-contracts.ts`
- `src/agent-conversation-errors.ts`
- `src/agent-session.ts`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Typecheck proves the implementation consumes the extracted contracts without
  widening or duplicating their definitions.
- The complete test suite is run before committing because this extraction
  touches the central public module and all prompt/lifecycle consumers.

## Step 4 — Serialized conversation operation queue

### Completed

- Added `AgentConversationQueue<T>`, a focused FIFO scheduler that owns serial
  draining, queued counts, concurrent-drain suppression, and removal of work that
  has not started.
- Replaced the `AgentSession` implementation's raw array and `pumping` flag with
  the extracted queue.
- Kept operation dispatch and lifecycle meaning in the conversation runtime. The
  queue intentionally does not know what a prompt, handoff, recovery, mode change,
  or configuration change means.
- Preserved the important re-entrant behavior: work queued while another
  operation is executing is consumed by the active drain without an idle gap.
- Preserved promise-observation ordering across the new async component boundary:
  the last operation publishes idle before its caller resumes, while a queued next
  operation still prevents an intermediate idle state.
- Preserved cancellation semantics: `interrupt({ clearQueue: true })` receives
  exactly the queued, undispatched items and resolves/rejects them using the
  established per-operation rules.

### Files

- `src/agent-conversation-queue.ts`
- `src/agent-session.ts`
- `test/agent-conversation-queue.test.ts`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Unit coverage verifies FIFO ordering, absence of overlap, re-entrant enqueue,
  concurrent drain suppression, and clearing only undispatched work.
- Existing AgentSession state tests verify queued counts, no false idle state,
  terminal stop behavior, and cancellation through the integrated queue.
- Typecheck and the relevant focused suites are run before committing.

## Step 5 — Presentation and activity coordination

### Completed

- Added `AgentConversationPresentation`, the conversation-owned runtime for the
  single lifetime activity aggregator and ordered presentation persistence.
- Moved turn begin/flush behavior, reasoning-boundary settlement, activity
  application, legacy JSONL activity filtering/projection/truncation, V2 activity
  projection, ordered V2 presentation writes, and presentation-item callbacks out
  of `AgentSession`.
- Kept the persistence runtime behind a getter because it can be installed during
  managed creation/open after the conversation object is constructed.
- Kept public lifecycle emission in `AgentSession`: the extracted runtime reports
  presentation items through a callback and does not know about session events.
- Preserved one aggregator for the entire conversation lifetime so its sequence
  clock never restarts between turns.
- Preserved fire-and-forget update ingestion and explicit drain points before
  operation completion/stop.

### Files

- `src/agent-conversation-presentation.ts`
- `src/agent-session.ts`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Existing activity tests cover folding, deltas, sequence continuity, turn
  boundaries, filtering, truncation, and legacy transcript behavior.
- Existing presentation tests cover stable IDs, revisions, message/activity
  interleaving, persistence, and reload behavior.
- Typecheck plus those focused suites are run before committing; the full suite is
  used if the focused boundary stays green.

## Step 6 — Continuation and opening policy

### Completed

- Added `agent-conversation-continuation.ts` as the policy boundary used by both
  ordinary transcript opens and registry-authoritative managed opens.
- Moved validation and immutable snapshotting of ordered continuation strategies
  out of the implementation class.
- Moved reconstruction classification, continuation report construction,
  checkpoint-to-provider-descriptor mapping, portable continuation prompt
  construction, the handoff summary prompt, and staged provider-identity
  verification into that boundary.
- Left the side-effectful acquisition loop in `AgentSession` for this tranche. It
  coordinates controller start/fresh-start, configuration restoration, metering,
  transitions, and mutable recovery state; moving it now would require exposing a
  broad callback bag rather than producing a real independent component. The new
  policy module is the seam from which that loop can move once `AgentConversation`
  owns those dependencies explicitly.

### Files

- `src/agent-conversation-continuation.ts`
- `src/agent-session.ts`
- `test/agent-conversation-continuation.test.ts`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Focused tests cover default load-only behavior, policy ownership, rejection of
  empty/blank strategies, immutable reports, exact provider-identity staging, and
  portable prompt construction.
- Existing continuation integration tests cover load failure, ordered fallback,
  cross-adapter reconstruction, activation failure, recovery, and configuration
  restoration.
- Typecheck and the focused continuation suites are run before committing.

## Step 7 — Boundary audit and next API specification

### Completed

- Audited the current runtime after the extractions. `AgentSession` is still large
  (3,201 lines), but its extracted queue, presentation runtime, continuation
  policy, contracts, and errors now have one-way dependencies and conversation
  terminology. The remaining responsibilities are all conversation-level
  coordination rather than top-level agent ownership.
- Specified the concrete responsibilities and initial API shapes for
  `AgentSession`, `AgentConversation`, `AgentConversationManager`, and the optional
  `AgentSessionManager`.
- Specified the minimum participant boundary and made attribution explicitly
  separate from authentication.
- Specified a domain-oriented `AgentStore` direction so chat reconstruction does
  not depend on interpreting vague events.
- Recorded SQLite concurrency requirements: one database per agent, WAL, busy
  handling, short transactions, database constraints for cross-process races, and
  no transaction held across a model call.
- Defined an explicit compatibility sequence for the public `AgentSession` name.
  The current conversation class is not silently replaced by an owner with
  different semantics.
- Defined idempotent legacy migration: one old session becomes one new agent plus
  one generated `agc` conversation; valid existing `ags` IDs remain unchanged;
  arbitrary old IDs remain resolvable through aliases; existing artifacts and
  provider IDs are retained.
- Listed the identity, discovery, messaging, tool, SQLite schema, blob, and audit
  questions that must be designed before implementation steps 8–12.

### Files

- `.res/SPEC-agent-session-conversation-boundary.md`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Reviewed all imports of the extracted conversation modules. None imports the
  `AgentSession` implementation class.
- Reviewed current README, consumer-guide, CLI, and REPL use of `AgentSession` to
  identify the compatibility surface that a rename must preserve.
- Confirmed all six preceding commits are individually scoped and the unrelated
  pre-existing worktree changes remain uncommitted and untouched.
- Final typecheck and full test suite are run before this checkpoint is committed.

## Step 8 — Persistence, search, identity, and transition contracts

### Completed

- Fixed `Agent` as the compatibility-safe top-level owner name and retained the existing
  `AgentSession` meaning until it can become a deprecated `AgentConversation` facade.
- Reduced the initial participant vocabulary to `agent`, `user`, and `external`, with
  mutable display names and attribution explicitly separate from authentication.
- Defined the common ordered record envelope, initial typed record families, exact
  message-boundary rule, and independent capture/query policies.
- Defined one caller-located SQLite database per agent as the online default, JSONL as a
  compatibility/per-conversation/export backend, and audit as an independent sink with a
  durable-outbox option.
- Defined external-content FTS5 search, per-kind searchable projections, capability
  detection, rebuild/integrity operations, and an optional vector-index boundary.
- Defined versioned persistence extensions so RAG tables can later live in the same agent
  database without becoming part of the core schema.
- Defined identity as append-only observations plus derived snapshots and watermarks,
  with `eventual` and `through-current` loading and an always-invoked no-op default.
- Unified handoff, cross-adapter switch, and reset as one recoverable transition. Added
  generated, consumer-provided, and absent continuation modes; custom summary guidance;
  and an optional atomic target prompt.
- Explicitly deferred markers, group routing, inter-agent messaging transports,
  AI-backed consolidation, and a concrete vector implementation.

### Files

- `.res/SPEC-agent-persistence-identity.md`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Confirmed the contract preserves current handoff behavior through the compatibility
  shorthand while providing the adapter registry required for a later switch.
- Confirmed every long-running model operation lies outside a SQLite transaction.
- Documentation-only step; the pre-step baseline passed typecheck, 698 unit tests, and
  the deterministic transcript, operations, and metering smoke tests.

## Step 9 — AgentConversation runtime boundary

### Completed

- Renamed the actual conversation runtime class to `AgentConversation` without adding a
  wrapper or second lifecycle.
- Preserved `AgentSession` as an exported alias to the exact same constructor, keeping
  static creation/opening, `instanceof`, and existing imports compatible.
- Added conversation-first aliases for configuration, opening, state, events,
  notifications, prompt results, recovery, and managed persistence contracts.
- Added a canonical `agent-conversation.ts` entry point and the `./conversation` package
  subpath.
- Kept existing error names and persisted vocabulary unchanged in this structural step.

### Files

- `src/agent-session.ts`
- `src/agent-conversation.ts`
- `src/agent-conversation-contracts.ts`
- `src/index.ts`
- `package.json`
- `test/agent-conversation-compatibility.test.ts`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Compatibility tests prove both public names are the same constructor and expose the
  same static factories.
- Focused startup, handoff, and managed-load suites passed.
- Typecheck passed.
- Full suite passed: 700 tests, 0 failures.

## Step 10 — Backend-neutral persistence contracts

### Completed

- Added the agent-scoped `PersistenceBackend` and transaction scope with direct
  conversation, record, message, checkpoint, provider-session, identity, search, audit
  outbox, and extension operations.
- Added stable participant references with the accepted `agent`, `user`, and `external`
  vocabulary plus the reserved implicit-user identity.
- Added the ordered record envelope and typed message, tool-call, permission,
  configuration, protocol, native action, future agent action, thinking, and activity
  records.
- Kept exact messages as first-class records and added a dedicated message retrieval
  contract so chat reconstruction never depends on private event reduction.
- Added immutable capture-policy resolution independently from query filters.
- Added identity observation, derived snapshot, projection-watermark, vector-index,
  search, durable audit-outbox, and persistence-extension contracts.
- Added per-record searchable text projection without joining separate messages.
- Added a `./persistence` package subpath while retaining all existing persistence APIs.

### Files

- `src/persistence/backend.ts`
- `src/persistence/index.ts`
- `src/index.ts`
- `package.json`
- `test/persistence-backend-contracts.test.ts`
- `.res/somelogs.md/9-16+/9-16-LOG-refactor.md`

### Verification

- Contract tests cover participant normalization, implicit identity, strict record kinds,
  immutable capture expansion, message-boundary-preserving search projection, and tool
  search content.
- Typecheck and the focused persistence-contract suite passed.
- A pre-existing audit-creation test failed once in the first parallel full run, then
  passed in isolation; the clean full-suite rerun passed 706 tests with 0 failures.
