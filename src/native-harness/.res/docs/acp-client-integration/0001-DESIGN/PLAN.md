# acp-client integration implementation plan

Date: 2026-11-20.
Status: proposed for review.

## Scope

Deliver the first scripted stdio checkpoint in [SPEC.md](SPEC.md) using the
[protocol profile](PROTOCOL.md). Start from a branch that contains the accepted
model-execution stack. Gate 1 can run on that base. Before Gate 2, combine the
Gate 1 revision with the reviewed `controller-interface` revision that provides
`ConversationController`. Record both revisions and the integration base in the
work log.

Keep the harness portable. Its code lives under `src/native-harness/`.
Production integration lives under acp-client's `src/native/` and imports
only the public harness entry points. Reuse the host launcher, conversation
records, and permission presentation where they fit. Keep the native adapter
opt-in and verify existing ACP conversations still behave as before.

## Code ownership

| Area | Code seam | Responsibility |
| --- | --- | --- |
| Harness contracts and protocol | `src/native-harness/src/contracts/protocol.ts`, `src/native-harness/src/interfaces/protocol/server.ts`, and the public `HarnessClient` | Validate the create/load request, call the session operations through contracts, and return the applied batch before recovered work starts. |
| Harness state and lifecycle | `src/native-harness/src/state/storage/engine.ts`, storage contracts, and session assembly | Reuse the channel edit, suspend, and delete transitions. Keep durable state and conflict handling in storage and execution eligibility in the harness lifecycle. |
| acp-client host | New shared host under `src/native/`, with the launcher contract in `src/launcher.ts` | Own one process per agent, startup, reconnect, and process shutdown. Add the native launcher kind through the host launcher. |
| acp-client conversation adapter | New native controller under `src/native/`, wired through `src/conversation-controller/factory.ts` on the reviewed controller-interface base | Map harness events to the existing controller contract. Reuse host prompt records, supervisor attachment, and conversation finalization. |

The harness kernel depends on contracts. The host imports the public harness
client and transport entry points. Neither the protocol layer nor acp-client
duplicates channel state transitions.

## Implementation gates

| Gate | Owner and work | Evidence required |
| --- | --- | --- |
| **1. Harness protocol** | Finalize the pending channel-change batch and outcomes. Record the contract decision before wiring create/load, storage transitions, and the typed client. Apply the startup batch before recovered work starts. | Offline suspension prevents early execution. Invalid batches leave channel state untouched. A blocked delete suspends the target and preserves accepted work while another channel remains usable. A lost open response is safe to retry, both on the same connection and after reconnect. |
| **2. acp-client adapter** | Implement `ConversationController` with the shared native host. Persist input before push and flush post-cutoff edits before fresh input. Buffer early turn output until the prepared prompt attaches. Map conversation `forceStop()` to targeted interruption and expose native `startFresh()` as unsupported. | Run controller conformance and existing ACP checks. Verify early output and terminal outcomes settle the prepared turn once. Concurrent first sends launch one process. Take before push acknowledgment still correlates. An old acknowledgment cannot clear a newer edit. An ambiguous push uses its saved ID and payload. Verify `startFresh()` leaves the timeline intact. |
| **3. Real stdio checkpoint** | Drive the scripted harness through acp-client's public conversation interface and a real child process. Run the host and harness checks against the same revision. | Two conversations share one durable session. Input steers an active turn, one approval dispatches one call, and conversation `forceStop()` leaves the shared child and the other channel running. Lose a push response and an open response at their commit boundaries. Restart also recovers a missed committed reply without duplicating work or records. |

Use deterministic barriers for the startup and recovery cases. For the missed
reply check, stop the child after the reply commit and before the host records
it. Run the harness typecheck and offline suite, the acp-client checks relevant
to the adapter, and the public stdio checkpoint.

## Follow-up boundary

Use the current small-session recovery view for this checkpoint. Add bounded
recovery for turns and inputs before relying on long-running mock sessions.
Consumer-registered tool callbacks, broader operator controls, and the
long-running mock each have their own designs. Context reset is deferred.

## Handoff and review

Follow [AGENTS.md](../../../../AGENTS.md). Assign an implementer and an
independent reviewer for the checkpoint. Record the base, test evidence,
findings, and exact revisions in `LOG.md` when work starts. Review each gate
before building on it, with particular attention to the load-to-execution
ordering and to host records after a disconnect.
