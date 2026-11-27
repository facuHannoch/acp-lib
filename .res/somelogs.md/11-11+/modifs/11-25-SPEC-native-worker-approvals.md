# Native model responses to worker approvals

Status proposed.

## Goal and ownership

A native conversation that delegates to an ACP worker can receive and answer
an eligible worker permission request. The host can remain a responder.
ACP-client owns forwarding, pending requests, the answer tool, and notice
delivery. The native harness supplies its existing tool catalog, turn policy,
and `channel/notify` operation.

A worker policy decision of allow or deny settles as it does today. This spec
applies only when the decision is ask. The worker's giving conversation when
the ask is issued owns the request. Once a redirect takes effect, route new
asks to the new giving conversation. An outstanding ask remains bound to its
original giving conversation even if the worker is later redirected. A
conversation can have pending asks from workers it has since redirected.

## Configuration and eligibility

Add `orchestrator.workerApprovals` with these modes.

| Mode | Eligible native worker asks |
| --- | --- |
| `consumer` | Existing host or UI behavior. This is the default. |
| `model` | The native model receives the ask and can answer through the worker answer tool. |
| `both` | The native model and the existing host or UI can answer. The first valid answer wins. |

Add an optional `modelApproval: { rules }` field to each entry of
`orchestrator.policies`. Use the existing worker permission rule keys and
matching semantics with a fixed `deny` default. For example,
`modelApproval: { rules: { "kind:read": "allow" } }` delegates the resolution
of eligible read asks. The worker's `workerPermissions` still decides whether
the action requires an ask. The new field only controls model answers.

At issuance, use the existing worker ask actor, rather than the policy union
from durable result delivery. Require at least one contributing policy and an explicit
matching allow in every contributing policy. An absent grant, an
unrecognized action, or any other match result makes the ask ineligible for
the model. The native harness must also allow the answer tool on the
answering turn. Recheck the model approval grant against the answering
turn's contributing policies before claiming the ask. Ineligible asks and
asks for a non-native giving conversation follow the existing consumer
path in all modes.

Offer only one-time choices to the model. Preserve any persistent choices
that the existing policy permits for the human responder. Requests without
an eligible one-time option use the existing consumer path. A model answer
settles the individual ask and carries no authority to change worker policy.

For the initial action projection, support structured workspace-relative read
requests. Each contributing grant must list the exact path in
`modelApproval.shareReadPaths` before it may be included in shared history.
Other requests use the human path until a safe projection is available.
Match the original structured request and derive the displayed action from
those same fields. Do not copy a worker-supplied title or assignment label.

## Pending request and delivery

Reuse the live giving-conversation lookup. If there is no live coordinator,
use the existing unanswered outcome.

Extend the existing conversation permission coordinator to hold one pending
request for the worker ask. Allocate the coordinator request ID and freeze
the destination conversation, worker handle, original contributing policy
names, offered choices, and expiry
before publishing a notice or allowing an answer. Reuse the existing
permission deadline measured from request ingress. Notice delivery and
retries do not reset that deadline.

Send a bounded native notice with a stable item ID derived from the
coordinator request ID. Include the worker handle, a concise action summary,
the request ID, the available one-time choice names (`allow_once` and
`reject_once`), and the expiry. Map the choice to the original worker option
inside the coordinator. The summary must give the model enough information
to distinguish the action it is approving. Use the human path when that
detail cannot safely fit in the notice. Keep raw permission payloads,
secrets, and private action details out of the notice, which may appear in
shared history. The action summary is information for the responder. Use
the originating policy names and the native host's channel ordering when
calling `channel/notify`.

Use normal channel admission and active-turn intake. A notice can wake an
idle channel on a running harness. Approval notice delivery never cold-starts
the harness, resumes a suspended channel, or overrides an explicit host
stop. Use the same item ID if a delivery result is ambiguous and a retry is
still eligible. Check the request is still live inside the channel queue before each send or retry.
Track pending, delivered, or failed delivery for active asks. Keep live
request state separate from the durable worker result ledger. A notice
retained in history carries no continuing authority.

Track host and model eligibility independently in the pending entry.
`answersPermissions` still governs the host path. An eligible model ask
stays pending even when `answersPermissions` is false. In both mode,
preserve the host path if notice delivery fails. In model mode or both
mode with no host responder, a final delivery failure uses the configured
unanswered outcome. Use that outcome when neither path is available.
Bound all waiting by the original request deadline.

## Answer and resolution

Register a worker tool with default name `worker_answer` and input
`{ request, option }` when model answers are enabled. Extend
`orchestrator.toolNames` to rename it and apply normal tool-name collision
checks. The harness policy uses the exposed name.

Resolve the calling conversation and policy from the invocation context.
Before claiming the ask, verify its destination, live deadline, selected
option, and the caller's current model-answer permission in addition to
the grant recorded at issuance. A different channel, a disallowed option,
and an expired request cannot claim it. Return a bounded status for rejected
answers without exposing another conversation's pending requests.

Both responders use the same coordinator entry and the same single-claim
operation. An invalid answer leaves the valid responder able to answer.
The winning answer resolves the worker request once and emits one
`permission_resolved` event. Add `by: "delegator"` for a model answer.
Preserve the host-facing `answerPermission()` result shape. A later host
answer returns `{ accepted: false }`. A later model answer reports that the request is no longer available.
The coordinator drops settled requests.

## Lifecycle

The turn that starts delegation may finish while the worker waits.
Request expiry, worker stop or interruption, and loss of the live worker
request or ACP-client coordinator close the pending ask. A native harness
child reconnect can leave the coordinator and worker request alive. If the
harness becomes available through its existing recovery path before expiry,
retry only an unconfirmed notice and use its original item ID. An already
accepted notice is delivered once. If the model did not answer it, an
eligible host can still answer or the ask can expire.

A historical notice cannot restore a lost request. A later execution may
issue a fresh worker ask with a new request ID. There is no automatic
replay of worker actions.

## Code boundaries

- Route eligible asks at `src/orchestrator/permissions.ts`.
- Own the pending entry and resolution race in
  `src/permissions/conversation.ts`. Keep `AgentSession.answerPermission()`
  on the existing host path.
- Deliver notices through `src/native/host.ts` using the channel ordering
  and notification path already used for results. Keep pending approvals
  outside `src/native/worker-delivery.ts`'s durable result repository.
- Register the answer tool in `src/orchestrator/native-delegation.ts` and
  document mode, policy and exposed tool name in the consumer guide.

## Acceptance

1. Default consumer mode preserves existing approval behavior. Verify
   model mode and both mode with a real native harness and an ACP worker,
   including model answers with `answersPermissions: false`.
2. Alice delegates, Bob takes over, and the worker issues a new ask.
   Bob's idle native conversation wakes, answers it, and the worker
   continues once. Alice cannot answer Bob's ask. An earlier forwarded
   ask remains with Alice after the redirect.
3. Race a model answer and a host answer in both mode in each order.
   Verify one worker response and one resolution event with the correct
   source. Wrong channel, expired, unauthorized and persistent-option
   attempts cannot win. Verify a renamed answer tool with its exposed
   policy key.
4. Verify empty or mixed grants, unavailable action detail, and a grant
   removed before the answer. Check that private action details stay out of
   the notice and shared context.
5. Exercise delivery failure with and without a host responder. Verify an
   idle channel wakes on a running harness, and that suspended channels
   and stopped harnesses are not started by an approval notice.
6. Exercise native reconnect with an unconfirmed and an already accepted
   notice, worker stop, coordinator loss, and expiry. Verify a historical
   ID cannot answer a new ask and that retry does not extend the deadline
   or execute worker work twice.
