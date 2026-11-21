# Execution

## Admission and scheduling

Messages and channel notices enter a committed inbox before acknowledgment.
A channel takes pending items before its next inference, or starts a turn if
it is idle. Several inputs can share one turn and its outcome. Scheduling is
serial within one channel and concurrent across channels.

In the development scenario, `notify_channel` submits an attributed internal
notice to an existing target channel. It can steer a running turn or wake an
idle channel. Ordinary shared timeline entries become visible at the next
inference without starting work. The pending-input check and the transaction
that finishes a turn determine whether a racing input extends that turn or
starts the next one.

## Inference and tool execution

Each iteration checks for suspension, takes eligible input, renders context,
and asks the model for a response. The model runner owns attempts and usage.
Its ordinary 120-second deadline includes streaming, any retry delay, and one
eligible retry. The retry window closes when the runner accepts the first
nonempty text delta for publication or commits a response. Draft text can be
delivered as deltas or buffered for clients that want complete messages.

The assistant response commits before tool dispatch. Tool calls run in order
within an iteration. The permission gate evaluates the policies contributing
to the turn, handles approval when required, and records dispatch evidence
before an executor can have an external effect. A result is paired with the
model's call ID. Approval waits and model deadlines are separate. Tool
approval identifiers and one-time grants are scoped to the live service.

When no tool calls or pending inbox items require another iteration, the turn
finishes. A failed or interrupted turn leaves the channel usable. The harness
fences late results from an interrupted turn. Recorded dispatch without a
committed result is reported as uncertain and is never automatically replayed.

See [model execution](../docs/model-execution/0001-DESIGN/SPEC.md) for attempts,
delivery, and usage, and [configuration and permissions](../docs/11-19-config-permissions/SPEC.md)
for policy composition and approval. The [callbacks proposal](../docs/tools-and-callbacks/0001-DESIGN/SPEC.md)
extends this dispatch path with host functions, invocation status, and scoped
result references.
