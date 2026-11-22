# External notices work log

Branch `aiagent/cod1a-external-notices` starts at
`4d341ddc8fc2016acc2468d93134bc32db959102`. Clad owns independent review.
Decision 0025 and the harness contract types are the first gate.

## Worker recovery prerequisite

The pinned tree's orchestrator spec describes workers as ordinary external
ACP conversations, including Codex and Claude. Its workers repository and
assignment correlation are design seams. The pinned source tree has no
committed orchestrator implementation or assignment-indexed worker result
repository. The actual ACP client opens or reloads by provider session ID
in `src/client.ts`, and `AgentSession.promptFrom` returns a locally allocated
prompt handle. The Agent persistence interface can query recorded operations
by operation ID, but that does not recover a backend completion lost before
acp-client records it. No named backend on this base exposes a supported
terminal-result recovery or acknowledgment operation by assignment ID.

The required replacement-process proof is unavailable on this revision.
Conversation reload and local transcript inspection do not establish it.
Generic channel/notify can proceed after independent contract approval.
Worker-dependent staging, delivery and public acceptance stay open until
the orchestrator workstream identifies and proves the supported recovery
backend. No orchestrator worktree was modified.

Both package typechecks were run on the contract-only tree. Each reports
eight errors in existing consumers still missing the new operation or
writing the previous format. Implementation will update those consumers
after contract approval. No runtime paths have changed.
