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
