# Suspend, stop and resume

Status: agreed design direction, 2026-11-17. Not implemented. Concrete contract
types, protocol operations and storage transactions require a decision record
before implementation.

## Purpose

A consumer must be able to stop the harness for an update or relocation and later
continue accepted work. The harness saves execution boundaries, not live promises,
model connections or process memory. This requires durable inputs, notices and
turn state in addition to conversation history.

| Operation | Responsibility |
| --- | --- |
| Suspend | Stop starting iterations and reach durable resumable boundaries |
| Stop/close | Release resources and database ownership after suspension |
| Open | Validate and load stored state without implicitly executing work |
| Resume | Explicitly continue cleanly suspended work using supplied services |

The host owns updating software, launching processes and moving files. The harness
reports when it is safe to close and provides enough state to reopen. It does
not update or relocate itself.

## Session lifecycle

Normal execution transitions `running → suspending → suspended`. Explicit resume
transitions `suspended → running` after compatibility checks and service assembly.
Repeated suspend on a suspended session is harmless. Repeated requests during
suspending observe the same transition rather than initiating competing drains.
Exact API shapes remain to be defined.

Process connection state is separate: a suspended session can remain open for
inspection. Conversely, a disconnected client does not suspend a running session.
An unexpected process exit does not establish a clean suspended state.

## Admission during suspension

Once suspension begins:

- Reject new external work with an explicit lifecycle error. A caller can retry
  after resume; do not acknowledge work that was not accepted.
- Stop dequeuing turns and starting new model iterations across all channels.
- Preserve already accepted queued inputs in channel order.
- Continue accepting valid internal notices from finishing iterations, commit
  them durably and defer their delivery to execution after resume.

Internal notices must not wake new execution while suspending. A notification
between two finishing channels must therefore never keep the drain alive. Notice
acceptance and the final suspended transition must be coordinated so no accepted
notice falls between persisted states.

## Iteration checkpoint

If suspension arrives during inference, let that response finish and record it.
Execute all tool calls requested in that response, preserving current per-turn
order, and record their results. Stop before the next model call. If an iteration
is already running tools, finish its remaining calls in the same way.

At the boundary, persist one of these outcomes:

| Situation | Outcome |
| --- | --- |
| No tool calls and no pending notices; turn naturally finishes | `completed` |
| Tool results or pending notices require another inference | `suspended`, next step is inference |
| Turn accepted but not started | Keep `queued` |
| Model/tool execution failed | `failed`; do not label it resumable |

A pending notice does not force another inference while suspension is requested.
It remains durable for the resumed turn or a later notice-driven turn according
to the existing admission boundary. The checkpoint must preserve that distinction.

For a suspended active turn, save its identity, original input, next execution
step and references to recorded messages and pending inbox items. Resume the same
turn rather than creating a second input or reusing its ID for unrelated work.
Native tool-call/result pairing and provider-specific state must remain usable
with the configured model adapter.

Only commit session `suspended` after every active turn has settled and all
accepted inputs, notices and checkpoints have committed. Completion of the suspend
operation means this durable condition has been reached. It need not mean every
client received every output event; output replay is a separate contract.

## Restart and failures

On open, clean suspension preserves queued and suspended work without starting
it. Resume reconstructs services and inboxes, continues suspended turns before
later queued turns on the same channel, and permits independent channels to run
concurrently again.

A database left in `running` or `suspending` by a dead process has no clean
session-level suspension guarantee. Mark formerly running turns interrupted and
report unresolved work; do not automatically retry tools. Retain individually
committed checkpoints, but automatic recovery of a partially suspended session
is outside the initial implementation. Preserve completed work and recorded
inputs in every case.

Waiting for tools may take arbitrarily long. A host deadline can force process
termination, but that is interruption, not successful suspension. A tool may have
changed external state before its result was recorded. No lifecycle flag can
resolve that uncertainty by itself.

## Updates and relocation

The host requests suspension, waits for success, closes the harness and releases
exclusive ownership. It can then update or move the database using a supported
SQLite backup/copy procedure. Copying an open database's main file alone is not
a relocation guarantee, especially with WAL files present.

On reopen, check schema version, checkpoint format and execution configuration
compatibility before resume. Stable tool names alone do not guarantee compatible
behavior. Credentials and implementation functions are supplied by the new host;
do not serialize them into the checkpoint. Relative paths, external resources and
tool-owned state may need host migration and cannot be assumed portable because
the conversation database moved.

## Acceptance scenarios when implemented

- Suspend two channels during different tool iterations, reopen in a new process,
  and continue without repeating completed calls or losing queued inputs.
- Deliver an internal notice while another channel reaches its checkpoint;
  verify durable delivery after resume and no extra inference during suspension.
- Complete a tool-free turn during suspension and verify it stays completed.
- Force termination before suspension completes and verify interruption is
  reported without claiming a clean checkpoint or retrying unknown tool effects.
- Reject incompatible reopen/resume and concurrent database ownership clearly.

These scenarios use scripted models and controlled tools. History restoration
can land first, but reliable suspend/resume must wait for durable inboxes and
checkpoint semantics.
