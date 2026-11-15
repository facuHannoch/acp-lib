# Notices and simulated work

`Agent.notify` accepts a directed notice for an existing channel. An accepting
active turn queues it; otherwise it schedules a new turn without awaiting its
completion. Receipts distinguish inbox delivery from a new turn and expose an
internal completion promise for observation, not model serialization.

Each runner receives a mailbox: drain appends notices as attributed user messages
before inference, and finish synchronously closes admission only when empty.
The loop ends only on no tool calls and a successful finish. This removes the
busy-to-idle delivery gap without additional validation calls or a notice-pass
limit. Tool results are paired before queued notices are appended.

The development tools share one five-step dashboard job. Each step takes five
seconds; duplicate dashboard calls in one inference are rejected by the tool
executor. Concurrent attempts return busy. The model decides whether changed
instructions warrant stopping; no background job runs between steps.

The new contracts extend internal APIs; existing callers are updated. General
policy, cancellation, persistence and cross-process notice APIs are deferred.
