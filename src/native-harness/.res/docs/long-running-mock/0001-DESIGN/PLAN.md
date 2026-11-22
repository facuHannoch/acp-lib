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
| Scenario loading and model behavior | Harness `src/capabilities/model/scripted.ts` and `src/testing.ts` | Use one loader and reuse validated sequences across attempts. Keep playback and opt-in request capture in the scripted adapter. Expose scenario loading to the driver through the public testing entry point. |
| Launch paths and fixtures | Harness `src/interfaces/cli/scenario.ts`, `development.ts`, `serve.ts`, and both packages' scripted fixtures | Route all file-based scripts through the shared loader, including the development channel fixtures. Replace on-disk JSON scripts. Preserve named channel and default-sequence behavior. Keep CLI code limited to arguments, configuration, and assembly. |
| Model execution and storage | Harness `src/capabilities/model/runner.ts` and `src/state/storage/` | Reuse durable per-channel attempt reservations, deadlines, usage, and response commits. Derive scripted compatibility from the validated model sequences used at open. Keep driver scheduling state outside the session store. |
| Built-in notices and test tools | Harness built-in `notify_channel`; acp-client test fixtures for host callbacks | Exercise the default notice tool from operator controls through ordinary dispatch. Reuse hold and effect-recording helpers and put host callback fixtures on the consumer side. |
| Rehearsal driver and reports | acp-client `test/native/`, sharing `support.ts` and the existing native host setup | Schedule sends, track outcomes through a final revision, and own diagnostics and child cleanup. Keep an opt-in timed entry point with documented handlers and policy. Reuse the native host and public harness APIs. |

Use the same loader for the model adapter and driver. Reuse the driver's
scheduling and reporting code for short tests and longer runs. The driver
submits prompts and reads events through acp-client. Test code can coordinate a
barrier with a handler signal when a particular ordering matters. Keep model
and tool details behind their existing contracts.

## Implementation gates

| Gate | Work | Evidence required |
| --- | --- | --- |
| **1. Contract and fixture inventory** | Define JSONL shapes, playback timing, channel selection, script identity, and completion reporting. Inventory file loaders and fixtures. Confirm whether existing status and idle operations can establish the final revision consistently. Add a focused status contract only if needed. | Review model-only, multichannel, timed, malformed, and restart examples. Record public contract changes and typecheck them. |
| **2. Harness adapter** | Implement loading and playback, convert fixtures, and reuse attempt reservation and default tool composition. | Verify line diagnostics, channel positions, streaming, usage, cancellation, exhaustion, and retry consumption. Reject a changed script after a crash with pending input and no checkpoint. Prove capture-off skips full-request copying and multiple attempts reuse one validated scenario. Verify scripted playback can call the existing `notify_channel` built-in. Run harness typecheck and offline tests. |
| **3. acp-client driver and deterministic checkpoint** | Schedule sends, collect outcomes, and exercise controls in test code using the existing native host. | Verify submission order, overlap, exact inputs at the inference boundary after steering, and completion when a notice starts work after the last scheduled input settles. Verify deadline diagnostics and cleanup after success and failure. Run the real-stdio cases below, acp-client typecheck, and native tests. |
| **4. Full driven rehearsal** | Run the same driver against a real stdio child with a multi-minute JSONL file and its documented tool and policy setup. Publish a verified usage command and fixture. | Verify unattended operation, concurrent progress, terminal outcomes, and process cleanup. Compare consumer delivery with committed replies at the final revision through bounded reads. Run both packages' full offline suites and record the independently reviewed revision, commands, and evidence. |

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
Assert which input IDs reached the inference after steering. Verify the driver
stays alive until a notice-driven turn finishes after the final scheduled input
has settled.
Record expected interruption or failure as an assertion. Fail if later work on
another channel stops progressing or a completed operation is delivered twice.

### Timed rehearsal

Run a checked-in synthetic JSONL fixture for multiple minutes through the
same driver. Use bursts, idle gaps, overlapping channels, and both short and
tool-heavy turns. Run a short version in CI and record the actual multi-minute
run before acceptance. Hour-scale files use the same entry point. Full request
capture is off during the long run. The command supplies bounded test handlers
and a fixture policy that allows the tools and built-in notices it uses. Manual
approval responses, hold and release, and deliberate stalls stay in CI cases.

Record fixture identity, elapsed time, accepted inputs and terminal outcomes,
callback effects, unused model records, and the final revision used to compare
committed replies. Verify the child exits. In a separate forced timeout case,
report which work was blocking and verify the child is reaped within the
cleanup budget. Both runs use a scripted model without provider credentials.

## Handoff and closure

Use one implementer and one independent reviewer. Record the accepted base,
exact stage revisions, review decisions, commands, and run evidence in `LOG.md`
once implementation starts. Review each gate before building on it. Record
limitations and a short retrospective at closure.
