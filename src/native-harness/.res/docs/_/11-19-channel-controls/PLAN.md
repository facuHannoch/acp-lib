# Channel controls implementation plan

Status: proposed for review.

## Scope and module map

Implement [SPEC.md](SPEC.md) on a base containing the accepted persistence
revision `9d9de35`. The persistence branch includes the closure notes at
`3a236ac`. Record the actual base and implementation branch when assigning the
work.

Preserve durable send acknowledgment, a single message delivery behavior, and
concurrent execution across channels. Add channel create, suspend, resume, edit,
and delete, plus withdrawal of untaken input and interruption of a named turn.

| Area | Existing code | Responsibility |
| --- | --- | --- |
| Contracts | `src/contracts/{agent,session,storage,events,protocol}.ts` | Define channel state, command results, status, and event correlation. Record the decision before changing implementations. |
| Durable transitions | `src/state/storage/{engine,memory,sqlite}.ts` | Keep shared transition rules in the storage engine. Persist channel state, withdrawn receipts and retired IDs. Make admission and state changes atomic. |
| Restart and portability | `src/state/storage/{engine,sqlite,archive}.ts` | Preserve individual suspension and checkpoints through restart and export/import. Define how an existing persistence database or archive opens after the change. |
| Scheduling | `src/kernel/{channels,loop}.ts` | Reuse iteration boundaries and cancellation. Combine session and channel lifecycle checks before starting or taking work. Fence late results by turn ID. |
| Assembly and API | `src/index.ts`, `src/client.ts`, `src/interfaces/{client.ts,protocol/}` | Wire the commands and expose outcomes and state through the typed client, in-process and over stdio. Keep lifecycle rules in the kernel and storage. |
| Verification | `src/testing.ts`, `test/conformance/storage.ts`, and existing protocol, crash, suspension, and end-to-end tests | Use controlled model and tool barriers to exercise exact commit boundaries and verify the public API with real child processes. |

The accepted persistence engine currently treats suspended turns as belonging
to a session-wide suspension. Channel suspension needs its own durable state.
Recovery and session resume must distinguish a committed individual checkpoint
from one created during an incomplete session suspension. Reuse the existing
storage and scheduler modules for this distinction.

## Implementation stages and acceptance gates

| Stage | Work and dependencies | Acceptance gate |
| --- | --- | --- |
| **1. Contracts** | Define effective admission and execution from both lifecycle states. Specify command outcomes, duplicate and stale requests, create versus first-send behavior for unknown IDs, and the result of overlapping channel and session lifecycle operations. Record database and archive compatibility and land contract changes ahead of implementation, following the repository rules. | Typecheck. The reviewer can trace suspend versus take, interrupt versus result commit, withdraw versus take, delete versus send, and session resume around an individually suspended channel. |
| **2. Storage and recovery** | Extend the shared engine and both adapters for channel state, withdrawal, targeted interruption and retirement. Update snapshot and archive records where needed. | Both adapters pass the same transition conformance tests. Real SQLite reopen preserves a committed suspension, a withdrawn receipt and a retired ID. An interrupted suspend recovers the work described by the spec. Test the agreed compatibility behavior against persistence fixtures and round-trip the new records through an archive. |
| **3. Scheduler** | Apply the effective gates to admission, take and scheduling. Finish an iteration for suspend, and request immediate cancellation for interrupt. Coordinate with session suspend, resume and stop. | Deterministic two-channel tests show Bob continues while Alice suspends or is interrupted. Alice's pending input is taken once after resume. A late tool result or stale interrupt cannot affect the next turn. Session resume preserves Alice's individual suspension. |
| **4. Client and end-to-end verification** | Expose commands and state through the typed client. Add real stdio process scenarios and update architecture and usage docs. | Run all acceptance cases in the spec through the appropriate storage, scheduler and public-interface tests. Run typecheck and the full harness suite. Independently review the final revision and record the results. |

### End-to-end gate

Run two channels through the public client against a scripted stdio child
with SQLite. While Alice is in a controlled tool, accept another input and
request her channel suspension. Verify new sends and notices are rejected for
Alice while Bob completes a turn. Let Alice reach her checkpoint, restart the
harness, and check that she stays suspended. Resume her channel and verify
the pending item is taken once and the completed tool is not repeated.

Run interruption separately against a tool that returns late. Verify the
interrupted turn cannot continue and a stale interrupt cannot affect the next
turn. Use explicit barriers around input take, tool-result commit, and checkpoint
commit for the withdrawal, deletion, and crash cases in the spec.

## How we work

### Shared rules

- Follow [AGENTS.md](../../../AGENTS.md) and [ARCHITECTURE.md](../../../ARCHITECTURE.md).
  Keep the kernel dependent on contracts and SQLite inside storage.
- Use one implementation branch. Record its base, stage revisions, test
  commands, results, and disputed decisions in `LOG.md` once work starts.
- Use scripted models for automated checks. Identify the exact revision in
  each review handoff.

### Coordinator

Assign one implementer and one independent reviewer once the scope is approved.
Confirm the persistence base and resolve questions that change behavior or
contracts. Check final acceptance against the spec.

### Implementer

Own branch edits. For each stage, run its gate and send the reviewer the exact
revision and evidence. Address findings directly and send the new revision
back for review.

### Reviewer

Review each revision independently and send findings directly to the implementer.
Check storage atomicity, independence of channel and session suspension, and
turn cancellation when tool results arrive late. Approve each gate explicitly
after fixes. Bring scope changes or disputed blockers to the coordinator.
An approved stage can proceed to the next one.

## Closure

Record the accepted revision, independent review outcome, gate results, and
remaining limitations in `LOG.md`. Include a short retrospective on what
helped, where work stalled or had to be redone, and what to change next time.
