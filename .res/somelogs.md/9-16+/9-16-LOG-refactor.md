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

