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

Clad declined Gate 1 at `09c7e3dfa5382940015d3f15e768558dd447f569`
because session drain admission needed an explicit external-notice rule.
The follow-up pins the full validation order, duplicate lookup before the
inspection fence, rejection of reserved inherited names, and the format 6
columns and migration. Both typechecks still report the same eight
expected contract-only errors. Worker recovery remains unproven on the
pinned backend. Independent re-review is pending.

Clad approved Gate 1 at `56285d81d0e53f8ec54590fb7ab5ec433a011b39`
after confirming the same eight contract-only errors in both packages.

## Generic Gate 2

Storage, archive and context rendering landed in
`131ad3a1ee7539b6f86b917d0fea5797f04739f4`, before the dependent scheduler
and wire changes. The format 6 migration adds nullable attribution columns
and preserves existing format 5 signatures. SQLite and memory share
admission, signature and policy composition. A known external ID returns
its recorded receipt before the execution fence even on an inspection
open. Archives preserve the submitted inherited set, attributed item and
matching timeline entry. Protocol delivery uses ordinary wake and take.

Shared storage coverage checks conflicts, set normalization, admission
during drain, the internal notice exception, inspection-only duplicate
receipts with unchanged revision, and pending/taken archive round trips.
The format 5 SQLite fixture has no external columns before upgrade.
A golden context test pins user-role rendering with external attribution.
Both transports exercise detached wake and active-turn steering with
inherited denial, timeline attribution and conversation counting.
The real child receipt-loss test kills after inbox acceptance and retries
over a fresh connection.

The coordinator and reviewer confirmed that worker recovery is still
unproven. A native worker conversation is only a candidate. The stable
assignment-to-input mapping and recovery after completion before staging
are unimplemented and unapproved. ACP replay has no equivalent proof.
No worker staging or orchestration changes are included. Worker Gates 3
and 4 remain open. Haurness-l coordinates backend selection.

Generic Gate 2 verification passed both package typechecks. Full harness
`bun test ./test --timeout 30000` passed 360 tests with 3777 assertions
across 47 files. Root `bun test ./test/native` passed 87 tests with 6576
assertions across seven files. Both suites had zero failures. Independent
review of the generic harness behavior is pending.
