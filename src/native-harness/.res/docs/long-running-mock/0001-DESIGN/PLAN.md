# Long-running mock mode implementation plan

Date: 2026-11-21.
Status: proposed for review.

## Base and scope

Implement [SPEC.md](SPEC.md) on the accepted acp-client integration, host
callbacks, and operator-controls revisions. Record the exact base at handoff.
Keep harness code independently runnable and use its public client and testing
exports from acp-client. Follow the [architecture](../../../../ARCHITECTURE.md)
and [contribution rules](../../../../AGENTS.md). Record changes to contracts or
conformance suites in a decision before implementing against them.

Use one JSONL file format. The scripted model reads model records and the
rehearsal driver schedules participant sends. Deterministic lifecycle actions
and barriers live in test code. The mock uses the existing model runner,
permission gate, tool dispatch, scheduler, and recovery paths.

## Module ownership

| Area | Code seam | Work |
| --- | --- | --- |
| Scenario loading and model behavior | Harness `src/capabilities/model/scripted.ts` and `src/testing.ts` | Use a single parser and validation path for model-only and timed JSONL files. Keep selection, delays, stream chunks, failures, and cancellation in the scripted adapter. Expose scenario loading to the driver through the public testing entry point. Keep parsing separate from running attempts if the adapter needs a focused module. |
| Launch paths and fixtures | Harness `src/interfaces/cli/scenario.ts`, `development.ts`, `serve.ts`, and both packages' scripted fixtures | Route all file-based scripts through the shared loader, including the development channel fixtures. Replace on-disk JSON scripts. Preserve named channel and default-sequence behavior. Keep CLI code limited to arguments, configuration, and assembly. |
| Model execution and storage | Harness `src/capabilities/model/runner.ts` and `src/state/storage/` | Reuse durable per-channel attempt reservations, deadlines, usage, and response commits. Derive scripted compatibility from the validated model sequences used at open. Keep driver scheduling state outside the session store. |
| Built-in notices and test tools | Harness `src/capabilities/tools/` and session composition in `src/index.ts`; acp-client test fixtures for host callbacks | Supply one harness-owned `notify_channel` definition and handler across session entry points. Reuse notice admission and the permission gate. Reuse hold and effect-recording helpers and put host callback fixtures on the consumer side. |
| Rehearsal driver and reports | acp-client `test/native/`, sharing `support.ts` and the existing native host setup | Add a focused test driver that schedules sends, owns the child for the run, and records outcomes and cleanup. Keep an opt-in entry point here for longer runs. Reuse the native host and public harness APIs for observation, approvals, and replacement. |

Use the same loader for the model adapter and driver. Reuse the driver's
scheduling and reporting code for short tests and longer runs. The driver
submits prompts and reads events through acp-client. Test code can coordinate a
barrier with a handler signal when a particular ordering matters. Keep model
and tool details behind their existing contracts.

## Implementation gates

| Gate | Work | Evidence required |
| --- | --- | --- |
| **1. Contract and fixture inventory** | Define JSONL record shapes and validation, delay and stream timing, channel selection, script identity, and the run's completion and error report. Inventory every file loader, generated fixture, and in-process test helper. Agree how the built-in notice is composed on the accepted base. | Review representative model-only, multichannel, timed, malformed, and restart examples. Confirm each launch path uses the same format and document any public contract changes. Typecheck changed contracts. |
| **2. Harness adapter and built-in notice** | Implement shared script loading and model playback. Convert existing fixtures and route all script entry points to the loader. Reuse attempt reservation and default tool composition. | Verify line diagnostics, independent channel positions, stream events, synthetic usage, cancellation, exhaustion, retry consumption, child reopen, and rejection of changed model sequences on reopen. Verify a scripted `notify_channel` request reaches its target through admission and policy. Run harness typecheck and the offline suite. |
| **3. acp-client driver and deterministic checkpoint** | Schedule sends, collect outcomes, and exercise controls in test code using the existing native host setup. Add compact reporting and deterministic cleanup. | Verify same-timestamp submission order, overlap between channels, timed-run deadline, and cleanup after success and failure. Pass the deterministic real-stdio scenarios below. Run acp-client typecheck and its native tests. |
| **4. Full driven rehearsal** | Run the same driver against a real stdio child with a multi-minute JSONL file. Exercise the public acp-client path and produce a compact report. Update usage docs with a verified command and fixture. | Verify concurrent progress, terminal outcome accounting, and process cleanup. Compare observed committed messages with bounded harness reads for the channels under test. Run both packages' full offline suites and record the independently reviewed revision, test commands, and rehearsal evidence. |

## Final acceptance runs

### Deterministic real stdio test

1. Start Alice and Bob in one session. Alice streams text and requests a host
   callback under `ask`. Approve it, wait until its handler enters, and hold it.
   Prove Bob finishes through the same connection while Alice waits. Interrupt
   a held turn and verify the target and tool effects from the observed outcome.
2. Detach Alice, deliver a notice through a scripted `notify_channel` call, and
   let the resulting turn commit. Reattach with explicit recovery and prove the
   reply appears once. Check that Bob continues receiving events.
3. Suspend with a callback outstanding. Let it settle, wait for suspension to
   commit, replace the child, and resume. Verify model positions continue and
   the committed callback effect occurs once. In separate crash cases, kill
   the child after attempt reservation and during a dispatched tool effect.
   Verify recovery preserves the consumed attempt and does not replay an
   uncertain effect.

Use test-code barriers and the real approval, notice, and callback paths.
Record expected interruption or failure as an assertion. Fail if later work on
another channel stops progressing or a completed operation is delivered twice.

### Timed rehearsal

Run a checked-in synthetic JSONL fixture for multiple minutes through the
same driver. Use bursts, idle gaps, overlapping channels, and both short and
tool-heavy turns. Run a short version in CI and record the actual multi-minute
run before acceptance. Hour-scale files use the same entry point. Full request
capture is off during the long run.

Record fixture identity, elapsed time, accepted and terminal outcomes,
callback effects, unused model records, and any duplicate or missing committed
replies. Verify the child exits and cleanup also runs after a forced timeout.
The run uses a scripted model and controlled handlers without provider credentials.

## Handoff and closure

Use one implementer and one independent reviewer. Record the accepted base,
exact stage revisions, review decisions, commands, and run evidence in `LOG.md`
once implementation starts. Review each gate before building on it. Record
limitations and a short retrospective at closure.
