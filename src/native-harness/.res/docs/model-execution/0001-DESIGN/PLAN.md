# Model execution implementation plan

Date: 2026-11-19.
Status: ready for implementation. Start with the contract gate after the base is accepted.

## Scope and module map

Implement [SPEC.md](SPEC.md) on a base containing the accepted configuration
and permissions slice. Record the actual base at assignment. Preserve the
permission gate and dispatch events. Add a model call runner, streaming
adapters, and durable call summaries. Topic notices and image input have
their own work items.

Paths below are relative to the native harness package.

| Area | Existing or proposed code | Ownership |
| --- | --- | --- |
| Contracts | `src/contracts/{loop,events,session,storage,protocol}.ts` and a model contract file if needed | Define adapter attempt events, call and attempt outcomes, receipt evidence, reply IDs, and summary retrieval. |
| Model execution | New call runner and retry policy in `src/capabilities/model/` | Run one logical call, classify retries, apply a shared deadline, and fence late output. Keep the 120-second deadline, one-second delay, and single retry budget in named defaults. |
| Model adapters | Existing `src/capabilities/model/{openrouter,scripted}.ts` | Report one attempt using neutral events. Assemble provider tool-call fragments and handle terminal response and usage translation at the edge. Preserve complete-response support. |
| Kernel and assembly | `src/kernel/{loop,channels}.ts` and `src/index.ts` | Connect the call runner and lifecycle signals through contracts. Commit responses before tool dispatch. Finish iterations and take input at existing boundaries. |
| State | `src/state/storage/{engine,memory,sqlite,archive}.ts` as needed | Persist summaries, receipts, and scripted attempt position. Commit successful calls and their responses atomically. Recover unfinished calls as interrupted. Settle export/import treatment in the storage contract. |
| Consumer interfaces | `src/contracts/protocol.ts`, the typed client, and `src/interfaces/{protocol,inspector}/` | Expose both subscription modes, bounded live delivery, completion by ID, reconnect reconciliation, and summary reads. |
| Verification | `src/testing.ts` and `test/` | Use scripted streams, controlled timing, and local provider fixtures. Verify the same contract through in-process and real stdio clients. |

Keep retry and provider details out of the kernel. Permission and tool timeouts
remain at their own boundaries. Update
[BUSINESS_RULES.md](../../BUSINESS_RULES.md) with the implementation locations
for the defaults and behavioral choices once they ship.

## Implementation stages and acceptance gates

| Stage | Work and dependencies | Acceptance gate |
| --- | --- | --- |
| **1. Contracts** | Define adapter outcomes, receipt evidence, stable reply IDs, atomic success commit, and durable script reservation. Settle usage ordering, storage and archive compatibility, bounded buffering, and reads of large replies. Record decisions before dependent changes. | Typecheck. Trace retry in both subscription modes, interruption, slow delivery, and crashes before and after response commit. Each trace identifies which records commit and what the consumer can recover. |
| **2. Call execution** | Implement the model call runner and named defaults. Adapt OpenRouter and scripted inference. Apply the retry cutoff before subscription filtering. Wire cancellation and the permission gate. | A transient failure can retry the identical request once within its deadline. Partial text closes retry in both modes. Interrupt cancels an attempt or retry wait, fences late output, and leaves the channel usable. Invalid tool fragments never dispatch. |
| **3. Streaming and storage** | Correlate drafts, terminal outcomes and committed replies. Implement the atomic success commit, scripted attempt position, durable receipt and usage retrieval, and bounded live delivery. | Verify both sides of the crash boundary and reconnect by message ID. Slow delta readers cannot stall another channel's execution. Oversized replies remain retrievable by ID. Known usage survives reopen without duplicate counts. |
| **4. End to end and review** | Connect the public API and inspector. Run the scripted process checks, update usage and architecture docs, and run the full harness suite. | Typecheck and the full offline suite pass. Run the public flow below. Independently review the exact revision and record the evidence. |

### End-to-end gate

Run a SQLite session through the public client against a real scripted stdio
child. Alice streams part of a reply, then the script stalls. Bob completes a
turn on another channel. Trigger Alice's model deadline with a short test
setting. Verify Alice's live reply ends as incomplete, the call does not
retry, no tool runs from that stream, and the timeline has no completed reply
for it. Verify Alice accepts fresh work. Reopen and confirm the recorded call
outcome and any confirmed receipts remain available.

Use focused tests with controlled timing for retry before output, expiry
during retry wait, and interruption versus a late terminal response. Exercise
suspension at the iteration boundary with a completed response and tool
result. The runtime deadline stays at its documented default for ordinary use.

Verify both subscription modes with a text-and-tool response followed by a
later assistant reply. Messages mode delivers complete messages and tool
events. Streaming uses the same message IDs for deltas and completion.
Exercise a slow reader and verify that Bob's work commits and is recoverable
even if his events are delayed. Test dropping deltas separately from failing
a fully blocked connection, which follows the existing stop rules.

## How we work

### Shared rules

- Follow [AGENTS.md](../../../../AGENTS.md) and [ARCHITECTURE.md](../../../../ARCHITECTURE.md).
  Land contract changes and their decision record ahead of dependent changes.
- Use one implementation branch and record its base, decisions, and gate
  results in `LOG.md` when work starts.
- Use offline checks with scripted models and local fixtures. Identify the
  exact revision in each review handoff.

### Coordinator

Assign one implementer and one independent reviewer once the scope is approved.
Confirm the accepted base, settle changes to scope or contracts, and check final
evidence against the spec.

### Implementer

Own branch edits. Run each gate and send the reviewer the exact revision and
evidence. Address findings directly and send the revised revision back.

### Reviewer

Review each revision independently and send findings directly to the implementer.
Check that retries cannot duplicate visible output or tool effects, late
results cannot advance a stopped turn, and usage remains attributable to the
right attempt. Approve each gate explicitly. Bring disputed blockers or changes
to the spec back to the coordinator.

## Closure

Record the accepted revision, review outcome, gate results, remaining
limitations, and a short retrospective in `LOG.md`.
