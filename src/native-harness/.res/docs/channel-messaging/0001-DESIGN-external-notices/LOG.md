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

## Generic closure and retrospective

Clad approved generic Gate 2 at `f5220726f55320a1df214e5ebe46cdd5e260f548`,
with storage and rendering at `131ad3a1ee7539b6f86b917d0fea5797f04739f4`
and the approved contract at `56285d81d0e53f8ec54590fb7ab5ec433a011b39`.
The clean detached review passed both typechecks, 360 harness tests
(`bun test ./test --timeout 30000`) and 1422 root tests
(`bun test ./test`), with zero failures.

The contract review separated new notice admission from replay and pinned
the external drain refusal. Storage conformance then verified that replay
keeps the original receipt across suspension, incompatible inspection,
and archive import. A real stdio crash after inbox acceptance verified one
take and one model call on recovery. The format 5 upgrade preserves item
signatures, and format 6 prevents older readers from taking unfamiliar
notice records.

The endpoint with the open session owns notice authority. The current
protocol uses one endpoint per session. After stop, checking an inbox ID
uses a full storage snapshot. This is an accepted cost on that rare path.

Worker Gates 3 and 4 remain open. The accepted receipt-loss result covers
harness inbox recovery. A supported worker backend still needs independent
proof of completion recovery by assignment ID after lost delivery before
staging. Assignment correlation, backend selection, and the worker staging
transaction remain with the orchestrator workstream. Haurness-l coordinates
that dependency.

## ACP worker recovery prerequisite

Base `5274d5466e81e0ff27f9dbf4bab8ba0ddb547393` amends the recovery
boundary to use finalized ACP worker conversation records. The proof uses
the production Agent lifecycle, SQLite persistence and stdio ACP transport
with deterministic fixture peers. It adds no schema or runtime changes
and does not touch the R1–R3 integration files.

Before ACP dispatch, the Agent persists the user record with its operation
ID and consumer metadata. The fixture uses that metadata for the assignment
ID, destination and originating policy names. The supervisor kills and
reaps the Agent process after the final commit and inspects SQLite before
starting a replacement. The replacement uses only stored operation and
conversation records and has no runnable ACP command. It recovers the
same final record ID, exact response and provenance on repeated lookup.
An unknown assignment returns no match. A second case kills after a
provider chunk and before finalization. The mapping survives, but no
completed result is available.

Run `bun test test/worker-recovery-process.test.ts` from the repo root.
The lookup is a test fixture scoped to one conversation and one page.
No live provider was exercised. The post-prompt kill covers the finalized
operation and its completion evidence together, with no result staged
for delivery. It does not cover every intermediate persistence write
or implement uncertainty staging. Worker delivery remains open pending
independent review and subsequent staging and delivery gates.

Verification under normal local subprocess permissions passed three serial
runs of the focused test (2 tests and 28 assertions per run) and both
package typechecks. The restricted sandbox did not finish the ACP prompt;
the successful runs used local process escalation.

## Production worker handoff contract gate

Clad independently ran the two process-death tests at
`8fd669711290a5290df40050be52959f4ecf229e` three times (2/0 each).
Haurness-l accepted that revision as a feasibility proof of the Agent
saved-record boundary. The fixture lookup scans conversations and the
first 100 records of each. It does not establish production indexed
correlation, strict pre-dispatch persistence, uncertainty staging, or
live-provider semantics.

Decision 0025 now specifies the production binding, staging and retry
contract and the process-death gates. This revision changes documentation
only. Core coordination for the implementation base, owned files and
schema allocation remains pending. Worker delivery acceptance remains open.

Clad withheld contract approval at `c6d4198`. The revision adds the Agent
owner-lock rule, finalization versus uncertainty commit ordering, the
redirect policy union, explicit delivery transitions, and the optional
backend recovery hook. Typed Agent repository contracts and shared
conformance remain required before runtime changes, after coordination
with Core. No runtime behavior changed.

The follow-up adds the standalone typed contract in
`src/persistence/worker-delivery-contract.ts`. Placement does not claim a
schema version or change any existing adapter. The repository stages by ID
so the final-record recheck belongs inside the write transaction.

Clad approved the contract at `89f873dae1c221f0889641ef1cde3a46314d41cb`.
Merge `b3c9be8` carries that history onto Core's R1 base `a902ccf`.
Core assigned Agent schema 18 and authorized the single finalization call
in the existing Agent transaction. The first repository commit is
`5ec4cf004374e055610cdc3d702e11bc4d374193`.

The repository stores a final record pointer in the conversation commit
and reads the result from the conversation records when staging. Before
staging, the assignment contains no separate copy of the result bytes.
Both typechecks and 34 focused repository/SQLite persistence tests passed.
The process-death tests are prepared against Core's beforeDispatch hook.
On this base the peer rejects both prompts at receipt because the binding
has not committed. This is expected until the reviewed hook is merged.
The production process-death gate and full suite are still pending.
