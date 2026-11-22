# External channel notices implementation plan

Date: 2026-11-21.
Status: proposed for review.

## Base and ownership

Implement [SPEC.md](SPEC.md) on the reviewed operator-controls base. Pin the
exact revision at handoff. The harness owns notice admission, storage, and
turn scheduling. acp-client owns durable staging and retries. The orchestrator
owns assignment identity, completion recovery, and selection of the target
channel. Worker delivery uses the agreed
[callback policy metadata](../../tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md).

The generic `channel/notify` path can be built and verified before the
orchestrator is ready. The worker-delivery milestone needs an actual worker
backend that can recover a completed result after acp-client exits. A fake
worker can test the delivery contract during development. Acceptance of the
restart guarantee requires the first supported backend's recovery path.

Follow the [architecture](../../../../ARCHITECTURE.md) and
[contribution rules](../../../../AGENTS.md). Record contract changes and shared
conformance changes in decision records before implementation. Keep the kernel
dependent on contracts and compose implementations at the entry points.
acp-client uses public harness exports. The harness imports no acp-client code.

## Code ownership

Paths in this table are relative to the repository root. The operator-controls
implementation may move the protocol and recovery seams. Confirm their final
locations on the pinned base.

| Area | Existing code | Change |
| --- | --- | --- |
| Harness contracts | `src/native-harness/src/contracts/agent.ts`, `storage.ts`, `context.ts`, and `protocol.ts` | Add the external notice kind, request and receipt, and durable attribution and policy fields. Reuse existing inbox milestones, turn events, and lifecycle error codes. |
| Harness admission and storage | `src/native-harness/src/state/storage/engine.ts`, `policy-metadata.ts`, `memory.ts`, `sqlite.ts`, and `archive.ts` | Extend `acceptItem` and the existing signature path for external notices. Resolve destination and inherited policies at acceptance, reject new external input while draining, and preserve accepted duplicates. Keep the adapters behind one engine and extend archive validation and restoration. |
| Harness context and history | `src/native-harness/src/capabilities/context/build.ts` and the timeline projection from operator controls | Render external attribution through the existing builder. Include notices in timeline reads and leave them out of the conversation message count. Add a golden scenario with the new inbox kind. |
| Harness scheduler and protocol | `src/native-harness/src/kernel/channels.ts`, `src/native-harness/src/interfaces/protocol/server.ts`, `src/native-harness/src/interfaces/client.ts`, and `src/native-harness/src/client.ts` | Route protocol validation through a host-facing notice operation into the same scheduler admission path used by messages and internal notices. Reuse turn take, wake, and receipts. Keep the kernel free of protocol, persistence implementation, and worker details. |
| acp-client persistence | `src/persistence/backend.ts`, `sqlite-backend.ts`, and `sqlite-schema.ts` | Add the transaction-scoped storage needed to persist assignment recovery data and atomically record completion plus pending notice. Reuse the Agent database transaction seam. Keep any memory implementation for ephemeral Agents under the same record contract. |
| acp-client native delivery | `src/native/host.ts`, `src/native/records.ts`, and the operator-controls recovery seam | Use the existing per-channel sequencing and startup reconciliation. Flush durable notices after earlier channel changes and on successful resume. Keep durable notices distinct from the host's current message waiter lifecycle. If `host.ts` needs a helper, extract only the delivery logic with a clear owner. |
| Orchestrator delivery | Delivery port in the [orchestrator plan](../../../../../../.res/somelogs.md/11-11+/library/11-11-SPEC-orchestrator.md#flow-3-the-way-back); existing worker conversation and persisted results where applicable | Persist assignment provenance before dispatch, recover the worker result by stable assignment ID, and stage completion and notice together. Use the existing worker result source once Gate 1 proves it can replay or retrieve completion. Keep provider-specific recovery behind the worker side of the port. |

The current file-backed `NativeHostRecords` is useful for understanding retries
and startup sequencing. A separate file write cannot join the Agent database
transaction that records worker completion. Reuse the transaction pattern in
`PersistenceBackend.transaction` and the existing SQLite repository assembly.
Keep notice delivery records separate from the audit outbox, which has a
different destination and acknowledgment contract.

## Implementation gates

| Gate | Work | Evidence required |
| --- | --- | --- |
| **1. Contracts and recovery proof** | Record notice shape, owning host authority, read-only duplicate lookup, signature semantics, typed refusals, and storage and archive compatibility. Define assignment correlation, redirect versus staging commit order, and delivery transitions. Trace worker completion to a durable recovery source on the first supported backend. | Typecheck changed contracts. Demonstrate that a replacement acp-client can retrieve the completed result by assignment ID after the first process loses the event before staging. Pin the backend and document the path. If no backend provides it, the generic harness work can proceed and worker-delivery acceptance stays open. |
| **2. Harness inbox, rendering, and wire** | Extend storage and rendering behind the agreed contracts, then wire the scheduler and public client in separate dependent changes. Preserve message and internal-notice behavior. | Run shared memory and SQLite inbox conformance and a golden context test. Verify duplicate receipts during suspension and read-only incompatible opens. Test conflicts, refusal of new work, inherited policy, legacy signatures, and archive round-trips. Exercise both transports, including detached idle and active-turn delivery. |
| **3. acp-client durable handoff** | Wire assignment recovery, result and notice staging, and delivery through the native host. Keep worker results and delivery outcomes inspectable. | Test transaction rollback, repeated completion, both redirect/staging commit orders, and a crash after redirect. Verify one intent per completion, channel changes before delivery, retries after resume or confirmation of an earlier change on the same connection, and explicit retry after `invalid_policy`. |
| **4. Public checkpoint** | Drive a worker completion through the supported recovery path and a real scripted stdio harness. Use deterministic barriers at the commit boundaries. | Pass the crash scenarios below. Verify the committed reply is recoverable after reattach and that notices stay outside the conversation count. Run both packages' typechecks and full offline test suites. Record the reviewed revision, backend, and test evidence. |

## Final driven acceptance

Use a persisted Agent and a worker completion that can be recovered independently
of the acp-client process. Use the public client to drive the real harness and
SQLite for Agent and harness persistence. Run without inference credentials.

1. Have a guest-delegated worker complete for an owner channel while the
   harness is offline. Kill acp-client before it stages the notice. Reopen and
   recover the completion by assignment ID with the original provenance.
2. In a separate run, kill acp-client after result and notice staging commit
   and before any send. Reopen with a pending channel suspension. Verify the
   suspension applies first, then resume live and deliver the retained notice.
3. In another run, kill acp-client after the harness commits the notice but
   before acp-client records the reply to `channel/notify`. Reopen and retry
   the exact payload. Verify one accepted item and no additional take or wake
   caused by the retry. The original turn may be interrupted.
4. In a separate run, let the notice-driven reply commit while the chat is
   detached. Reattach and recover it once. Verify worker attribution in
   context and timeline, inherited policy enforcement, and the conversation
   page count. Verify that a retired destination exposes a delivery failure
   while the result remains available. Cover pending and taken notice archive
   round-trips in the harness gate.

Keep focused harness tests in `src/native-harness/test/` and extend
`test/native/` and the Agent persistence suite for host delivery and crash
recovery. Reuse the existing scripted harness and process checkpoint helpers.
Run `bun run typecheck` and `bun test ./test` in each package at the final gate.

## Handoff and closure

Use one implementer and one independent reviewer. Record the base, contract
decisions, exact stage revisions, review outcomes, and test commands in
`LOG.md` when work starts. Review each gate before dependent work lands. Record
the supported recovery backend and any remaining limits at closure.
