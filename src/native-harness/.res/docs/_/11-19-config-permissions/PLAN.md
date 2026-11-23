# Configuration and tool permissions implementation plan

Status: proposed for review.

## Scope and module map

Implement the session configuration, tool policy, and consumer approval flow in
[SPEC.md](SPEC.md). Start from session-file closure `df43007`, which includes
the accepted channel-controls revision and session-file codec. Record the exact
base in the work log at assignment. Use existing tools to prove the flow through
the session API and typed client, including export and reopen.

Paths below are relative to the native harness package.

| Area | Code | Responsibility |
| --- | --- | --- |
| Contracts | New config and permission contracts in `src/contracts/`, plus existing agent, session, storage, event, and protocol contracts | Define validated config, policy references, approval requests and answers, and lifecycle outcomes. |
| Configuration | Existing `src/runtime/config/` | Add pure config validation and managed session path resolution. Load one config at open from the optional sidecar or saved config. Keep credential resolution at runtime and expose validation to the consumer. |
| Policy | New `src/governance/policy/` | Resolve the named policy for accepted input and calculate the strictest applicable decision for each tool call. Keep the resolver independent of transport, storage and inference. |
| Permissions | New `src/governance/permissions/` | Gate the executor. Own pending requests, IDs, allow-once decisions, timeouts and cancellation. Tie each decision to the exact tool call. |
| Storage and recovery | Existing `src/state/storage/` | Persist policy references with channels and items, preserve them across restart and export, and validate checkpoint compatibility. Save and load portable config through the session-file contract. |
| Scheduler and assembly | Existing `src/kernel/` and `src/index.ts` | Supply the policies of taken inputs and lifecycle signals through contracts. Assembly injects the gate at the existing tool execution boundary. Reuse paired tool results and the current iteration checkpoint. |
| Public interfaces | Existing `src/client.ts`, `src/interfaces/client.ts`, and protocol adapters | Expose validation and approval operations. Carry request publication, the consumer's answer, and disconnect to the appropriate session services. |
| Verification | Existing `src/testing.ts` and `test/` | Use scripted inference, controlled lifecycle barriers, and tools with observable effects. Exercise the same gate through in-process and stdio entry points. |

Keep policy resolution out of the kernel and approval state out of the transport.
The policy resolver decides `allow`, `ask`, or `deny`. The permissions gate
applies that result and controls dispatch. A grant for one call cannot authorize
another call, including a later call with the same tool name and arguments.

## Implementation stages and acceptance gates

| Stage | Work and dependencies | Acceptance gate |
| --- | --- | --- |
| **1. Contracts** | Define the config schema and provisioning, input signatures and resolved policy metadata, and inherited policy references on notices. Align the portable config with the session-file contract. Specify approval outcomes, the dispatch boundary, and how skipped calls are reported. | Typecheck and trace retry after a policy edit, notice delivery across restart, and both orders of suspension versus approved dispatch. Identify when the executor may run and which events the caller sees. |
| **2. Config and policy** | Implement validation, startup lookup, policy resolution, persistence of references, and the session-file integration. Keep the effective config fixed for the open session. | Validate startup and reopen behavior, including import into a fresh home without a sidecar. Verify an identical retry retains its original policy, a changed explicit policy conflicts, and a restored notice carries source restrictions that apply at take. |
| **3. Execution gate** | Gate every dispatch for the existing executor. Add approvals, one-time consumption, timeouts and lifecycle cancellation. Emit `tool_call: started` at dispatch and record paired results for skipped calls. | Check allow, deny, approval, timeout, missing handler and disconnect with an observable tool. Verify another channel keeps working. Use a barrier to test both orders of suspension versus dispatch after approval, including tool effects and started events. |
| **4. Client and end-to-end** | Expose the flow through the typed client and both transports. Update the architecture and usage docs. | Run the scripted stdio scenario below, typecheck, and run the full harness suite. Verify equivalent approval behavior in process. Independently review the exact final revision and record the results. |

For the wire contract, start by evaluating an approval event plus an answer
request keyed by request ID. It fits the current event and request paths.
Gate 1 should compare it with the callback shape in the older protocol spec
and record the choice, including how requests become unavailable on disconnect.

### End-to-end gate

Run a scripted SQLite session through the public client against a real stdio
child. Alice proposes a tool call that requires approval. While her approval is
pending, Bob completes a turn. Suspend Alice's channel, verify the tool has
produced no effect, and send a late answer for the closed request. Resume Alice
and verify that the next model call receives the recorded
`approval_cancelled_by_suspension` result. Have the script request the action
again. Approve the new request and verify that the tool runs once.

Use deterministic barriers to check the boundary between approval and dispatch.
Cover session suspension, interruption, and stop at the focused test level.

## How we work

### Shared rules

- Follow [AGENTS.md](../../../AGENTS.md) and [ARCHITECTURE.md](../../../ARCHITECTURE.md).
  Land contract changes with their decision records ahead of dependent changes.
- Use one implementation branch. Record its base, stage revisions, decisions,
  and verification results in `LOG.md` once work starts.
- Use scripted models and controlled tools for offline checks. Identify the
  exact revision in each review handoff.

### Coordinator

Assign one implementer and one independent reviewer when scope is approved.
Confirm the channel-controls base, resolve product or contract questions,
and check the final evidence against the spec.

### Implementer

Own the branch edits. Run each stage's gate and send the reviewer the exact
revision and evidence. Resolve findings directly and send the revised commit
back for review.

### Reviewer

Review each revision independently and send findings directly to the
implementer. Check that every tool dispatch passes the gate, policy reflects
the inputs the turn took, and late responses cannot reach the executor.
Approve each gate explicitly after fixes. Bring scope changes or disputed
blockers to the coordinator. An approved stage can proceed to the next one.

## Closure

Record the accepted revision, review outcome, gate results, and remaining
limitations in `LOG.md`. Include a short retrospective on coordination,
review, and any work that had to be repeated.
