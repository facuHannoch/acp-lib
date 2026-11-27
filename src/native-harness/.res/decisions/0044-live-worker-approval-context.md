# 0044. Live worker approval context

Approval details need to reach the model for the giving conversation.
Putting those details in a wake notice makes them part of shared history.
Maintaining a second approval queue in the harness would duplicate timeout,
redirection and claim state. Read live views from the existing coordinator.

ACP-client owns one permission entry and one resolution for each forwarded
worker ask. Mode, permission policy, redirect routing and the single claim
stay there. A managed harness wakes through its existing notice intake.
The saved notice carries a generic wake message.

An opt-in host registers its answer tool with
`context/worker-approvals/serve` after initialize and before executable
open. The advertised method gates support. The existing initialize shape
remains compatible with earlier harnesses. The binding lasts for the
connection and can be registered again on reopen.

The harness issues `context/worker-approvals/read` on that connection only
when the answer tool is in the current inference's offer. Channel and
contributing policies come from the turn. The host scopes lookup to the
giving conversation and checks the live deadline and approval grant. At
most four views and 4 KiB of serialized views fit on the callback. The
harness waits up to 500 ms within the turn's cancellation boundary.

Complete views enter only the current provider input and are optional under
the existing context budget. Harness history and routine captures omit the
private view. Inspectors retain ordinary timeline material and model-call
metadata. Answering still uses the existing function callback with the
configured worker answer tool, and rechecks live choices, policy and
expiry. No persisted configuration, storage format or archive changes.
