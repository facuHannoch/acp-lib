# Operator and consumer controls implementation plan

Date: 2026-11-20.
Status: proposed for review.

## Scope and base

Implement [SPEC.md](SPEC.md) across the harness and acp-client. Record the
accepted integration and callbacks revisions at handoff. Gate 1 checks the
public API on that base, especially callback phase reporting and recovery of
turns started by the agent.

The harness owns lifecycle and durable outcomes. acp-client owns process
orchestration, attachments, and consumer-facing status. Follow the harness
[architecture](../../../../ARCHITECTURE.md) and
[contribution rules](../../../../AGENTS.md). acp-client imports only public
harness exports. The kernel depends on contracts. Record any contract changes
in a harness decision before implementation builds on them.

## Code ownership

| Area | Existing code | Work |
| --- | --- | --- |
| Harness lifecycle | `src/native-harness/src/kernel/channels.ts` and `src/native-harness/src/state/storage/` | Reuse admission, suspend, resume, stop, interrupt, and recovery. If phase information is missing, expose it from the execution boundary that owns it. Use the existing records for durable outcomes. |
| Harness storage reads | `src/native-harness/src/contracts/storage.ts` and `src/native-harness/src/state/storage/` | Add bounded, indexed sequence-range reads for conversation and timeline pages. Add focused reads for current channel state and tracked input or turn IDs. Give memory and SQLite the same read contract. |
| Harness public protocol | `src/native-harness/src/contracts/protocol.ts`, `src/native-harness/src/interfaces/protocol/`, and public `src/native-harness/src/client.ts` | Replace the full-load and forward-replay endpoints with the open, observe, reconcile, conversation, and timeline operations in the spec. Keep the lifecycle and model-call methods. Keep cursor validation and frame budgeting at the protocol boundary. |
| acp-client host | `src/native/host.ts` | Own the shared connection and child lifecycle. Compose agent controls from existing harness requests. Route channel operations through the existing host path and keep status and interrupt available while suspend waits. Route harness-owned approvals to authorized responders independently of channel attachments. |
| acp-client recovery | Extract from `src/native/host.ts` into one focused module under `src/native/` | Share channel observation, targeted reads, and snapshot/live reconciliation between process reopen and channel reattachment. Keep startup channel changes and submission retry orchestration with the host. Keep application submission records in `src/native/records.ts`. |
| acp-client history | Existing transcript pagination in `src/persistence/transcript-reader.ts` and the native adapter under `src/native/` | Retain consumer-facing cursor pagination. Resolve the conversation ID to a channel ID. Support explicitly requested backward history and forward catch-up. Persist the catch-up position with committed messages, and skip harness history reads when the consumer does not request them. |
| acp-client controller | `src/native/controller.ts` | Own the conversation attachment and adapt harness turns to the existing supervisor. Add attachment disposal separately from interrupt-and-detach `stop()`. Await the targeted interrupt outcome for confirmed stop. Reconcile live agent-started turns even when there is no local submission record. |
| Shared controller | `src/conversation-controller/` | Keep the common start and stop contract and use the capability surface for attach-only where supported. If Restart is exposed, compose stop then start once at the shared call site. Keep native protocol types inside `src/native/`. |

The harness reports channel lifecycle, running turns, and execution phase.
The host combines that with process health and derives the working-channel
count. The attachment owns connected or disconnected state. Use the public
`aggregateUsage` helper over model-attempt records, and carry separate
completeness information for missing provider fields.

For reattachment, register delivery before taking a revisioned channel view.
Reconcile tracked work, then merge buffered live events. Several events can
share one revision. Use the snapshot boundary and stable IDs for reconciliation.
Keep the boundary local to the reattaching channel so other channels keep
receiving events. History paging is a separate read. Remove acp-client's
startup loop that exhausts every message page on the new open path.

## Implementation gates

| Gate | Work and evidence |
| --- | --- |
| **1. Contract** | Pin the reviewed base. Encode the replacement operations from the spec. Define their types, bounds, cursor validation, live message positions, and commit ordering. Confirm command completion, approval routing, status ownership, and blocking-tool observation. Typecheck contract changes. |
| **2. Harness control and observation** | Reuse lifecycle methods and implement focused reads in both adapters. Verify open, attachment, targeted lookups, and pages avoid full history reads. Verify oversized events advance the cursor. Check responsive status and interruption during suspend, stale interrupts, and independent channel suspension. Exercise both transports. |
| **3. acp-client host and controller** | Switch startup to the replacement protocol. Add host controls, approval routing, and attachment disposal. Share reopen and reattach recovery. Verify confirmed stop before shared Restart, authorization while detached, idempotent reattachment, and recovery of live agent-started turns. Exercise both transcript sources, targeted recovery with history disabled, and explicit forward catch-up with live overlap. Run shared controller conformance. |
| **4. Public stdio checkpoint** | Extend `test/native/checkpoint.test.ts` and run the scenarios below through acp-client with a real scripted harness child. Check config validation, negotiated capabilities, and partial usage. Run both packages' typechecks and test suites. Update architecture and usage docs for the accepted behavior. |

## End-to-end acceptance

1. Detach Alice while her turn runs and let it finish. Trigger another turn
   on her active channel with no attachment. Reattach and request the newest
   page. Recover each committed reply once and receive later events. Bob's work
   and subscription continue throughout. Exercise an event arriving during
   reattachment.
2. Suspend a session during a controlled host callback. Observe the blocking
   invocation, let it settle, and wait for the committed suspension. Replace
   the child, reload the same session, and explicitly resume. Verify the
   callback effect happened once and an individually suspended channel stays
   suspended until explicitly resumed.
3. In a separate run, stop during suspension. Verify the stop remains
   responsive, the host does not automatically reopen, and explicit reopen
   reconciles the interrupted outcome and any uncertain tool effect.
4. With at least 10,000 timeline records and a full-load view over the frame
   limit, verify agent open and channel attachment issue zero history requests
   when acp-client uses its transcript. Hold inference and verify the harness
   avoids full history reads for open, attach, and targeted recovery. Reconcile
   a tracked turn by ID. Then request Alice's newest page and walk older
   pages during live delivery. Check channel scope, actor attribution, and
   stable cursors. Verify tool records stay outside the conversation count and
   remain available in the independently paged timeline. Verify SQLite serves
   page reads through a bounded range query without materializing the timeline.
5. Detach the last observer from a pending approval and exercise a new request
   made with nobody attached. Verify an authorized responder can reattach
   and answer before expiry. Verify an unauthorized observer cannot answer
   and that expiry and approval connection loss retain their existing effects.
6. Verify shared Restart waits for confirmed interruption and leaves the next
   turn untouched. Lose the connection before confirmation and verify shared
   Restart reports the unconfirmed stop and does not start the conversation.
7. Page across an oversized timeline record. Explicitly catch up an untracked
   reply after stream loss without duplicating live output. Interrupt catch-up
   between pages and verify retry uses the last persisted position.

Use scripted inference and controlled barriers. Put focused harness checks in
the harness test suite and host, attachment, and controller checks in
`test/native/`. Use a fixture for unattended input if the scripted endpoint
needs one. Run `bun run typecheck` in both packages, `bun test ./test/native`
from the repository root for the focused integration gate, and `bun test ./test`
from both packages for the final gate.

## Handoff and closure

Use one implementer and one independent reviewer. Record the base, exact
stage revisions, review outcomes, and verification in `LOG.md` once work
starts. The reviewer approves each gate before work builds on it. Record the
accepted revision, known limits, and a short retrospective at closure.
