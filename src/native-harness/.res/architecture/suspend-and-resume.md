# Suspend, stop, and resume

The harness owns lifecycle transitions and checkpoints. The host owns launch,
shutdown, updates, and relocation.

| Scope | Operation | Outcome |
| --- | --- | --- |
| Session | Suspend | Block new external work, reach resumable boundaries, and acknowledge once suspension commits. |
| Session | Resume | Check compatibility and make eligible channels runnable. Individually suspended channels stay suspended. |
| Session | Stop | Interrupt running work immediately and refuse further work in this runtime. Stdio EOF has stop semantics. |
| Channel | Suspend | Close that channel's admission and wait for its execution boundary. Other channels can continue. |
| Channel | Resume | Clear that channel's suspension. Execution also requires an eligible session. |
| Turn | Interrupt | End the exact running turn and fence its late results. The channel can run other eligible work. |

## What suspension saves

The running model request can finish. Already dispatched tools can settle.
Pending approvals affected by suspension close through the existing permission
gate. The turn can complete naturally or checkpoint before its next inference.
Accepted input stays durable. During session suspension, valid notices from
finishing work can be accepted for open target channels and wait for resume.
An individually suspending or suspended target refuses new work.

A checkpoint preserves the turn ID, messages, paired tool results, and pending
work. Resume continues the same turn without repeating recorded calls. A
suspension may wait as long as a running tool. Interrupting the turn can end
that wait; already performed tool effects can remain uncertain.

## Process replacement and recovery

For a planned update, wait for suspend to confirm, then close the process to
release storage ownership. Reopen the same session with the replacement.
Loading a suspended session preserves its suspension. Explicit resume
checks compatibility before making work eligible.

If the process dies while still suspending, recovery interrupts unfinished
work outside previously committed individual channel suspensions. It preserves
untaken input, committed output, and uncertainty records. For relocation
between homes, use the [session file](persistence.md).

A client attachment and the host's stdio connection have distinct lifetimes.
Closing the stdio connection stops execution. The proposed operator view
models client connection, channel lifecycle, and agent lifecycle independently.
See [operator and consumer controls](../docs/operator-controls/0001-DESIGN/SPEC.md)
and [the accepted channel controls](../docs/11-19-channel-controls/SPEC.md).
