# TODO: Node-level coordination for native harnesses

Date: 2026-11-21.
Status: deferred until after the second milestone makes the harness usable.

## Context

The first milestone gives acp-client an offline integration path. The second
adds bounded context and the user-facing capabilities that make the shared
agent useful. Measure the resulting harness before optimizing how multiple
instances share a Node. Context assembly, storage reads, and model request
size can change substantially during that milestone.

The capacity question is how a Node can keep roughly 50 agents available on
modest hardware. Each agent has its own harness process and can serve several
channels. A turn alternates between local work and waiting on a model or remote
tool. Many processes can wait concurrently. If they all start together, or if
many responses arrive together and trigger expensive local work, they can
compete for CPU and memory. A Node scheduler could spread those bursts and
keep warm the agents most likely to receive work. The agent count is a workload
to measure, with capacity determined by the observed resource use and latency.

## Proposed shape

Use two independent connections. The Hub runs conversations through acp-client
and the existing runtime bridge. Today the native harness uses its own stdio
protocol behind acp-client. ACP can remain the conversation transport where the
Hub uses it. The harness initiates a separate outbound connection to a
Node-owned control socket, so each process needs no additional listener.

The Node owns launch, allocation, and eviction decisions. The harness owns
its channels, tool execution, and session lifecycle. Wire the optional control
adapter at the harness runtime edge, using existing lifecycle and observation
operations. Standalone harnesses continue to run independently. Control
messages carry process identity, readiness, aggregate activity, and lifecycle
results. Conversation content, tool arguments, and model output stay on the
conversation path.

| Control | Proposed behavior |
| --- | --- |
| Cold start and wake | The Node limits concurrent launches and prefers interactive work over background starts. The host can request a wake when work arrives for a stopped process. The harness reports readiness after it can serve work. |
| Warm retention | Use observed working-set memory and recent activity to choose idle candidates for eviction. Leave headroom for running work to finish. |
| Drain | Request suspension through the existing lifecycle boundary. Confirm the checkpoint before closing the child and releasing storage ownership. |
| Local resource permits | If profiles show repeated CPU bursts, gate specific expensive operations through asynchronous Node permits. Context assembly and genuinely local tool work are candidates to measure. |
| Fairness | Give Hubs a fair share before scheduling among their agents. Keep interactive starts responsive during background bursts. |
| Provider capacity | If needed, govern model-request concurrency separately from local CPU. A model wait must release its local CPU permit. |

## Drain, wake, and failure boundaries

Idle is a hint for choosing an eviction candidate. A channel may have pending
input or a checkpoint while nothing is running, and new work can race an idle
notification. Request a drain, close new admission through the harness's
suspension path, and wait for confirmation from that process. A callback that
holds the drain open remains visible. If the host explicitly interrupts it,
preserve the existing rules for uncertain tool effects. A forced process exit
uses crash recovery. See [suspend, stop, and resume](../../architecture/suspend-and-resume.md).

On wake, reopen the same stored session and explicitly resume a scheduler-
initiated suspension. Preserve operator-requested suspension and individually
suspended channels. The Node must know which suspension it initiated before
resuming it. Define how the host handles a new wake request during drain or
eviction so work arriving at that boundary receives a clear outcome and uses
the existing durable receipt rules.

After control connection loss, keep local session semantics and treat the
Node's last activity view as stale. A drain without confirmation cannot be used
as a clean eviction. Correlate commands and replies with the process instance
so a late acknowledgment from an old process cannot authorize stopping its
replacement. Before implementation, confirm how the container reaches the
Node socket and how the Node authenticates that connection and binds it to the
launched instance.

If permits are added, acquire them before expensive work and outside storage
transactions. Release them on completion, cancellation, and before waiting
on a model or remote tool. Decide how permits expire or are reclaimed when a
process exits and what a connected harness does while its scheduler is
unavailable. Use Node resource limits for hard ceilings. Permits coordinate
when cooperating processes begin work.

## Order and evidence

1. **Measure the usable harness.** Profile cold start, readiness, memory per
   process and channel, context assembly, tool execution, and time spent
   waiting. Use the target container runtime and representative active and
   idle mixes. Treat coding harness profiles as comparison points.
2. **Try startup scheduling and idle/drain first.** Add only the activity and
   lifecycle signals those paths need. Test a startup burst, a new interactive
   request during the burst, eviction and wake, and loss of the control
   connection while a drain is in flight.
3. **Add warm retention or permits where data warrants them.** Measure the
   effect of each change. A burst in provider waits, local CPU, or memory calls
   for a different control. Keep per-chunk and ordinary cheap operations off
   the control path.

Reuse and extend the [long-running mock](../long-running-mock/0001-DESIGN/SPEC.md)
to drive the same multi-process workload with coordination disabled and
enabled. Run both startup bursts and steady traffic with synchronized response
bursts. Compare startup queue time, time to first reply, p95 reply latency,
CPU saturation, resident memory, and progress by Hub. Verify that a new turn
can make progress under load and that eviction preserves accepted work and
does not replay uncertain effects. Keep Node scheduling and socket design out
of the current harness milestones until the baseline shows where coordination
would help.
