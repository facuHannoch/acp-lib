# Long-running mock implementation log

Base `da59a6c8734baabf911b98014e3fc080e90ca91b`, including approved
operator behavior `95670a2` and closure `8f2a139`. Work is on
`aiagent/cod1a-long-running-mock`. Clad reviews each gate.

## Gate 1 fixture and loader inventory

- Managed stdio uses `src/testing.ts`, which currently parses configuration's
  script file as JSON and validates again when it creates a channel model.
  `interfaces/cli/serve.ts` assembles that path.
- Development startup in `interfaces/cli/development.ts` reads the script
  twice and currently accepts a named-channel wrapper and fallback.
  `interfaces/cli/scenario.ts` and `test:scenario` use `loadScriptedModel`.
  The JSONL loader will replace all three paths.
- Checked-in files to convert under `test/fixtures/`: `approval-e2e.json`,
  `crash-scenario.json`, `development-scenario.json`, `echo-scenario.json`,
  `hold-scenario.json`, and `model-e2e.json`.
- Generated files to convert: harness `config-policy`, `model-large-reply`,
  `operator-controls`, `portability`, `scripted`, and `tools-protocol`
  tests, plus root `test/native/support.ts` and `host.test.ts`. Inline
  model-runner and stream-adapter fixtures should use validated scenario
  sequences when they exercise scripted playback. Unrelated persistence and
  provider JSON fixtures stay in their current formats.

## Review examples

Model-only, channel override and timed sends can share one fixture:

```jsonl
{"type":"scenario","version":1,"name":"mixed"}
{"type":"model","content":"Default reply"}
{"type":"send","atMs":0,"channelId":"alice","participantId":"operator","inputId":"a1","text":"Start"}
{"type":"model","channelId":"alice","delayMs":10,"chunks":[{"afterMs":5,"text":"One"}],"content":"One","usage":{"outputTokens":1}}
{"type":"send","atMs":0,"channelId":"bob","participantId":"operator","inputId":"b1","text":"Overlap"}
{"type":"model","channelId":"alice","failure":{"kind":"transient","message":"fixture transient"}}
{"type":"model","channelId":"alice","content":"Retry reply"}
```

Removing both sends makes this a model-only fixture. Alice uses only her
three records. Bob and any other channel independently use the default.
Appending a line with both `content` and `wait`, an invalid version, or a
duplicate input ID fails at that line. Equal offsets send Alice before Bob
without waiting for Alice's turn. After a crash with Alice's second position
reserved, subsequent work uses her third position; reopening with
changed model content fails before any recovery write. Editing only sends or
formatting preserves the model digest and changes the independent file digest.

The existing status, reconcile and bounded history path can establish the
final revision by comparing settled status again after paging. No protocol
method is added. Contract details are pinned in decision 0023.

Gate 1 submission passed `bun run typecheck --pretty false` in the root
and harness package. No loader, playback, storage runtime or fixture
conversion is in this revision. Independent review is pending.

## Gate 1 review follow-up

Clad declined `779a200f97b5b5c44f19d6be71f13c33cf84acb6` after passing both
typechecks. This revision pins the boundary evidence and storage check
ordering, and completes the loader inventory. The exact model-boundary IDs
are separate from the existing receipt set. Gate 2 will include a golden
provider request that omits them.

`interfaces/cli/start.ts` (`bun run start --script`) passes the selected
script into `openDevelopment`. The shared JSONL loader belongs at that
development assembly point so explicit paths and saved configuration both
reach one read and validation.

| Remaining harness test user | Script source |
| --- | --- |
| approval-gate, model-channel-double, owner-config, tools-catalog | Inline model doubles with placeholder paths. They never open script files. |
| model-crash, crash, e2e | Checked-in crash and hold fixtures, converted to JSONL. |
| model-e2e | Checked-in model-e2e and echo fixtures, converted to JSONL. |
| permissions-e2e | Checked-in approval fixture, converted to JSONL. |
| persistence, protocol, suspension | Checked-in crash, echo or hold fixture for public tests, plus inline model doubles for direct session tests. |
| startup-channel-changes | Checked-in hold fixture, converted to JSONL. |
| session-file | Config path string only, deliberately absent for portability tests. No file is read. |

The contract-only follow-up passed both package typechecks. Independent
re-review is pending.

Clad approved Gate 1 at `53d99b827978b8c22600dff9862b6f27793fdf54`. Both
typechecks passed independently on a clean checkout.

## Gate 2

Managed stdio, development startup (including saved config), and the scenario
command now share the JSONL loader. The checked-in and generated file
fixtures use JSONL. Some unit tests still inject inline model doubles or
use the in-memory scripted helper. Those paths do not read files.

The selected scenario loads once per open and uses the index reserved by
storage for each attempt. Scripted attempts send accepted before their
terminal response, so the converted tests check both delivered and seen
milestones. The receipt-crash fixture now kills after the second confirmation
to retain its original Seen coverage. Full request capture is opt-in.
The lightweight attempt log includes the reserved step, attempt ordinal,
and inputs first included at the boundary. The OpenRouter golden request
omits the input IDs.

Both adapters reject untagged, malformed and changed scripted keys before
application recovery. The real stdio crash fixture leaves accepted input
pending with no checkpoint, compares the complete database bytes after a
changed-script rejection, and reopens with the original script at step zero.
Separate coverage checks per-channel selection, retry consumption, usage,
streaming, delayed cancellation, and exhaustion. The existing real-stdio
notice case runs through the JSONL adapter and ordinary tool dispatch.

Verification passed both package typechecks, all 343 harness tests with
`bun test ./test --timeout 30000`, and all 76 native tests with
`bun test ./test/native`. The final exact-key conformance rerun passed on
both adapters. Removing the redundant test-only file wrapper was followed
by a 13-test scripted, JSONL and provider adapter rerun. The stand-alone echo
command returned the expected result and captured no requests by default.
Independent review of this submission is pending.

Clad approved Gate 2 at `17949137cb39999aed4726fe0d3c2239578b7bfd`.
Both typechecks, 343 harness tests and 1411 root tests passed independently.

## Gate 3

The driver uses the acp-client native host, with the real stdio transport
and normal callback path. It pre-creates test channels, orders sends by
monotonic offset and file order, and keeps the action position in memory
while replacing the child. Status and targeted reconcile settle scheduled
input IDs against durable turn outcomes. A second status read brackets the
bounded history comparison at one revision. Consumer delivery comes from
the host's channel port and explicit catch-up. Reporting includes callback
outcomes and unused model positions. Failed or timed-out runs report
blocking status and use a bounded stop and reap sequence.

The deterministic checkpoint drives streaming with approval and a held
callback, independent Bob progress, steering with exact boundary IDs,
and targeted interruption. It also verifies a notice-only turn after
the final scheduled sends settle, detached notice recovery, suspension and
replacement with one effect, both real crash fences, timeout reporting,
and unexpected tool failure. Timed rehearsal and final full offline suites
remain Gate 4.

Gate 2 follow-up: the loader rejects empty chunks with a line diagnostic.
Script exhaustion uses an Error with a stable reason at the scheduler
boundary. The exact reason remains covered by the JSONL harness test.

Gate 3 verification passed both package typechecks, the six focused harness
JSONL tests, and all 84 native tests including eight real-stdio rehearsal
cases (6559 assertions, seven files). The first full native run exposed a
driver startup RPC timing issue when it inherited the short workload
deadline. Startup and workload budgets are separate in this submission.
The forced-timeout case verifies active work diagnostics and a reaped child.
Independent review is pending.

Clad approved Gate 3 at `41232cd842aa08158fc86b5deb01fd61bf2b5121`.
Independent checks passed both typechecks, 343 harness tests, 1419 root
tests and the stdio process cleanup check.

## Gate 4 timed run

From the root:

```sh
bun run test/native/rehearsal-cli.ts test/native/fixtures/rehearsal-two-minutes.jsonl 150000
```

The fixture `two-minute-operations` has file SHA-256
`083a7dd529dcaec05c3ef1c435a4dbbb191ec426d3d48846541700769d0a7634`.
The actual offline run finished in **127,467 ms** under its 150,000 ms
deadline. All five scheduled inputs were accepted and completed.

| Input | Scheduled ms | Issued ms | Turn | Outcome |
| --- | ---: | ---: | ---: | --- |
| a-early | 0 | 0 | 1 | completed |
| b-early | 0 | 1 | 2 | completed |
| b-mid | 45,000 | 45,000 | 3 | completed |
| a-mid | 45,000 | 45,000 | 4 | completed |
| a-final | 125,000 | 125,000 | 5 | completed |

Bob's first turn completed at 284 ms while Alice continued until 2,281 ms.
The final scheduled turn completed at 125,746 ms. The notice-only
follow-up turn 6 finished at 127,451 ms. Four bounded callback invocations
completed with IDs `1:a-work-1`, `1:a-work-2`, `3:b-work`, and
`6:follow-work`. There were no tool failures or unused records on Alice,
Bob or follow-up. Full request capture was off. The one child exited with
code 0 and was reaped before the report was emitted.

Final revision **82** matched seven consumer reply IDs to history. Alice
received `model:1`, `model:4`, `model:6`, and `model:10`, Bob received
`model:2` and `model:7`, and follow-up received `model:11`. Comparison
took 4 ms over 3 pages. The driver creates a fresh home and checks only
the tested channels, so their history is bounded by the current run's
delivery window, including child replacement. Final settlement reconciles
each distinct input or turn in batches of up to 100 per request, and
only after the status is idle. The CI regression uses 105 inputs. The
short rehearsal scales the checked-in schedule and callback waits and uses
the same driver, policy and handlers. The separate deterministic deadline
case checks blocking work diagnostics and verifies reap.

The first root run had one failure. Its 105-input regression let the model
start a new turn throughout the verification burst, which hit the workload
deadline under load. The regression now holds one tool until all 105
inputs are accepted and then verifies that every input resolves to that
turn. The focused rerun passed in 5.2 seconds. This isolates the request
batch boundary from model throughput.

The Gate 4 submission passed both package typechecks. Complete harness
`bun test ./test --timeout 30000` passed 343 tests with 3653 assertions.
The final complete root `bun test ./test` passed 1421 tests with 12110
assertions and 35 snapshots, including the short fixture, forced deadline
and 105-input regression. Both suites had zero failures. Independent
review is pending.

## Closure and retrospective

Clad approved Gate 4 and the long-running mock slice at
`e13b405e72e71318393cf76111b2c91e184bddad`. The accepted chain starts at
`da59a6c8734baabf911b98014e3fc080e90ca91b`. Gate 1 approved the contract at
`53d99b827978b8c22600dff9862b6f27793fdf54`. Gate 2 approved the loader,
playback and storage identity at `17949137cb39999aed4726fe0d3c2239578b7bfd`.
Gate 3 approved the shared driver and deterministic stdio checkpoints at
`41232cd842aa08158fc86b5deb01fd61bf2b5121`.

On a clean detached checkout, both independent typechecks passed and the
full root suite passed 1421 tests with zero failures. The first independent
harness run passed 341 tests with two load-sensitive failures while other
agents' harness processes were running. The failing tests were the stdio
invalid callback arguments case and the development startup controls case.
Both passed in isolation and the full harness rerun passed 343 tests with
zero failures. Gate 4 did not change either test file.

Clad independently ran the documented fixture and deadline. The run
completed in 128,129 ms, with approximately 2 minutes 23 seconds wall time
and 120 MB peak RSS. The file digest matched the value recorded above.
All five inputs completed on turns 1 through 5. The notice-only turn 6
finished after the final scheduled turn. Four callback effects completed,
with no tool failures or unused model records. Seven replies matched
exactly once at revision 82 in three history pages and 3 ms. The child
exited 0 and was reaped.

The shared JSONL loader made short and timed fixtures use the same durable
attempt reservation and permission path. Approval, steering, and crash
barriers exposed details that elapsed time alone could not verify. The
controlled 105-input turn verified the reconcile batch boundary separately
from inference throughput. The timed fixture then verified unattended
concurrent progress and completion after the final scheduled input.

Accepted limits

- The timed fixture has five inputs, bursts with one send per channel, and
  at most two tool calls per turn. It covers idle gaps and overlapping
  channels. It does not stress dense steering or many concurrent channels.
  Hour-scale and denser fixtures use the same entry point and were not run.
- Settlement polls every 10 ms. After idle, it reconciles input and turn
  IDs in batches. The final reply comparison pages all history for tested
  channels in the fresh run home. Costs grow with sends and replies.
- The two independently observed harness failures were load-sensitive and
  passed in isolation and in the full rerun.
- Driver scheduling state stays in memory across child replacement. The
  driver itself does not resume after its process exits.

## CI rehearsal stability follow-up

Based on accepted alpha `713a76a`. The ordinary offset-only fixture passed
four local baseline runs before edits. A controlled reproduction compressed
the same sends by 1000 instead of 25 while keeping its offset-only scheduler.
It failed exact consumption with an idle harness, no working channels,
and no unresolved sends. The forced-deadline regression showed the distinct
blocked-model case with one working channel, an active model phase, and
the unresolved input ID. Under load the deadline can fire during inbox
acknowledgments even when the later diagnostic snapshot shows a running turn.
No scheduler defect was established.

The CI fixture gates each later burst on completion of the previous burst.
It holds Alice's first callback until Bob completes and holds the notice
target until the last scheduled turn completes. This preserves concurrency
and notice-settlement assertions, along with exact consumption. The documented
timed command still uses elapsed offsets. Deadlines are unchanged. Failure
diagnostics cap the operator-status wait at 250 ms and report stage, unresolved
inputs, pending counts, and active phases before the existing stop and reap
sequence. Eight repeated focused runs passed both the shortened fixture and
forced-deadline case.

Both package typechecks and all 87 native tests passed on the follow-up.
Independent review is pending.

Clad approved `27c7166e96a1f91ee8420f8743b5745f2fb19490` independently.
Root typecheck passed on a clean checkout. Ten serial and three concurrent
runs of the complete rehearsal test file passed all 130 tests; no rehearsal
stdio child remained. The original intermittent deadline before settlement
remains unroot-caused. The bounded diagnostics can identify the stage and
active phase if it recurs. The CI barriers serialize bursts while preserving
concurrency within them. Timing-driven overlap between bursts is exercised
by the real timed CLI run.
