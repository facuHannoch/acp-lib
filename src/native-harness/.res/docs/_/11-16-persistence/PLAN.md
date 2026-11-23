# Persistence implementation plan

Status: proposed for implementation review.

## Scope and module map

Deliver the SQLite persistence flow in [SPEC.md](SPEC.md), from durable message
delivery through restart, suspension and file export/import. Preserve sequential
execution within a channel and concurrent execution across channels. Messages
have a single delivery behavior, including when a message reaches an active turn.

Paths in this table are relative to the native harness package.

| Area | Existing or proposed code | Responsibility |
| --- | --- | --- |
| Contracts | Existing `src/contracts/{storage,agent,session,events,protocol}.ts` | Define atomic storage operations, acceptance and completion, lifecycle, load results and transport guarantees. |
| Storage | Existing `src/state/storage/`, with new SQLite and memory adapters | Own the timeline, durable inbox, stable IDs, transitions and exclusive ownership. Fold `shared-context.ts` into the memory adapter or retain it as a projection of the same timeline. |
| Portability | New archive implementation under `src/state/storage/` | Encode and validate the logical session snapshot. Publish imports atomically. |
| Scheduling and execution | Existing `src/kernel/channels.ts` and `loop.ts` | Schedule one live turn per channel. Coordinate delivery, completion and suspension at the iteration boundary through contracts. |
| Assembly and context | Existing `src/index.ts` and `src/capabilities/context/build.ts` | Inject storage and lifecycle services. Render timeline data, with interruption and uncertain tool outcomes visible where relevant. |
| Public interfaces | Existing `src/client.ts` and `src/interfaces/{client.ts,protocol/}` | Expose acceptance, lifecycle, load and archive operations. Enforce load response ordering and bounded transfer on the wire. |
| Development and verification | Existing `src/interfaces/{cli,inspector}/`, `src/testing.ts` and `test/` | Select storage, inspect restored state and exercise the same execution with scripted models through the public interface. |

## Implementation stages and acceptance gates

| Stage | Work and dependencies | Gate |
| --- | --- | --- |
| 1. Contracts | Revise the storage and wire contracts and record the decisions. Define atomic accept/take/finish, acceptance versus turn completion, checkpoint data, load snapshot ordering, and archive transfer limits. Resolve how local chat awaits a shared turn when multiple inputs steer it. | Typecheck and review a message arriving at the finish boundary, a crash on either side of take, and a load followed by live events. |
| 2. Storage | Implement the memory and SQLite adapters against the agreed storage contract. | Shared conformance passes for both. SQLite reopens with stable IDs and deduplication, enforces exclusive ownership, and rejects invalid or partial transitions. |
| 3. Delivery and recovery | Connect the scheduler, timeline and scripted stdio load path to storage. | Run real child-process crashes before and after input take. Verify a missed committed reply is recoverable, the same channel can accept fresh work, and an uncertain tool call is never replayed automatically. Test a message racing turn completion. |
| 4. Suspension | Wire checkpoints and suspend/status/resume through session assembly and the client. | Suspend two active channels. Reopen and verify execution stays paused until resume. Pending items reach exactly one turn and completed calls run once. |
| 5. Portability | Add `.harness` export/import and bounded stdio transfer. | Round-trip a suspended session into a fresh home. Transfer an archive larger than one frame. Invalid archives and occupied destinations leave no partial import. |
| 6. Development integration | Wire startup and inspector, then verify the complete public flow. | Restored timeline is visible before a new message. Run the spec’s end-to-end scenarios and existing harness checks. Record the manual inspector exercise and review the complete revision. |

Use scripted models and controlled tools for automated checks, with no provider
credentials. Exercise transport behavior through the public client. Keep the
clean relocation and forced-crash scenarios separate, as defined in the spec.

## How we work

### Shared rules

- Use one implementation branch for the slice. Record the base and branch in
  [LOG.md](LOG.md) once assigned. Identify the exact revision in review handoffs.
- Follow [AGENTS.md](../../../AGENTS.md) and [ARCHITECTURE.md](../../../ARCHITECTURE.md).
  Land contract changes separately, before dependent implementation. Keep SQLite
  in storage and the kernel dependent on contracts.
- Use direct communication for reviews and fixes. Record durable decisions,
  handoffs, blockers and gate results in one chronological log. Include the
  role and revision where they help identify what was tested or reviewed.

### Coordinator

Assign one implementer and one independent reviewer after scope approval.
Agree on branch ownership and resolve questions that change the spec or contracts.
Check the final revision against the acceptance scenarios and record closure.

### Implementer

Own the branch edits. Run each gate as its stage becomes runnable and record the
commands, results, and deviations. Ask the reviewer directly to review a named
revision. Address findings and send the revised revision back for review.

### Reviewer

Review the named revision independently. Check the spec and gates, then inspect
transaction boundaries, failure paths, channel concurrency, and the public API.
Send concrete findings directly to the implementer. Repeat the review after fixes
until the revision is approved. Bring scope or contract changes and disputed
blockers to the coordinator.

## Closure

Record the accepted revision, independent review outcome, gate results, relevant
test commands, manual verification and follow-ups in [LOG.md](LOG.md). Add a
short retrospective there covering what helped, where work stalled or had to be
redone, and what to change in the next implementation and review cycle.
