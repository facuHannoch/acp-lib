# Durable evidence at the approval dispatch boundary

## Problem and choice

Decision 0016 requires interruption or a crash while approval is pending to
report no uncertain effect, while a dispatched call with no result remains
uncertain. An assistant's durable call record alone cannot distinguish these
states. Alternatives are volatile tracking (lost on crash), recording a skipped
result after interruption (violates the turn fence), or durable dispatch evidence.
Choose evidence in the existing turn state, without a schema-format bump.

When a running turn first records an assistant message with calls, its state
contains `dispatchedCallIds` (initially empty) in that same transaction. Before
the executor is invoked, `markToolDispatched` verifies the call is outstanding
and adds its ID in a transaction. The gate does this synchronously after its last
cancellation check and before publishing `tool_call:started` and invoking the
executor, without an intervening await. Thus a crash after evidence commits but
before invocation can conservatively report an uncertain effect; it never causes
an automatic replay. A crash or interrupt while awaiting approval has no dispatch
evidence and does not report that call as uncertain. Skipped calls get paired
results; already dispatched calls without results stay uncertain. No dispatch
marker authorizes a later call or survives as a grant.

Carry dispatch IDs through a checkpoint/resume. Legacy running or checkpointed
turns without the field use the previous conservative rule: all unanswered
calls are uncertain. Import validates any present list against calls belonging
to its turn. The marker is internal execution evidence, not an approval record.
The existing SQLite JSON turn state and logical archive carry it without a
format bump; existing saved files remain readable.

The scheduler exposes a per-turn suspension signal, distinct from interruption.
The permission gate consumes approval only at the synchronous dispatch boundary;
its last check observes both signals. The loop receives a gated result and never
directly invokes a tool. `approval_requested` is an always-on channel event;
`approval/respond` answers once. A connection disconnect closes its requests.
