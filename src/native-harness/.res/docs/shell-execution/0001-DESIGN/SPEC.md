# Shell execution

Date: 2026-11-22

Status: Proposed for M2. Define the rest of the initial tool set before
starting implementation. Foreground execution is the first increment.

## Tool contract

Expose one optional `shell` tool for running commands directly in an Agent's
execution environment. The initial runner executes Bash on Linux. The tool
description tells the model which shell syntax is available.

```json
{
  "command": "git branch --show-current",
  "cwd": "/dir3/d"
}
```

`command` is a non-empty shell command string. `cwd` is an absolute path in the
runner's environment. Each call supplies its own directory. A `cd` within one
invocation changes the directory for that shell and its children. Later calls
and other channels keep their own directories. The configured environment
determines which directories and programs are available.

The first increment returns exit status, bounded inline stdout and stderr, and
an explicit clipping flag. Clipped bytes are unavailable afterward. A nonzero
exit status is a command outcome with its output. A failure to start, deadline
expiry, or interruption uses the existing execution outcome conventions.

When retaining output is added, use the existing `read_tool_result` contract.
The producer retains the bytes and declares retention and expiry. The harness
routes reads by result reference and checks session, channel, and invocation
ownership. This works with a runner on a separate filesystem.

## Permission and dispatch

Reuse the checked harness-owned tool registration defined for [web tools](../../web-tools/0001-DESIGN/SPEC.md).
Validate availability, the command, and the working directory before approval.
Pair unavailable or malformed calls with a rejection before prompting or
starting a process. If approval is required, show the exact command and working
directory. Recheck availability at dispatch, execute the approved arguments,
and record the call and paired outcome through the existing tool lifecycle.
Command-specific rules such as matching a Git subcommand can be added to the
permission layer later. The initial policy applies to `shell` as a tool.

## Runner and execution environment

The runner implements process execution behind the [architecture's execution
port](../../../../ARCHITECTURE.md). It receives the validated command, working
directory, invocation identity, and cancellation signal. It starts the shell,
captures output, and tracks the process and its children through exit or
termination. The harness owns tool admission, turn state, and recording the
paired result. The shell implementation lives outside the kernel.

The deployment selects the runner and its environment. If the harness is
already inside the Agent container and that container provides the intended
boundary, the runner can be an in-process adapter that spawns Bash there. If
execution happens in a different environment, the runner can dispatch to it
behind the same tool contract. A sandbox controls which filesystem mounts,
network access, and resources the processes receive. The working directory
selects a starting location within that environment.

Start with one supported Linux deployment and verify the boundary from an
actual command. Reuse the existing Agent environment if it keeps harness-only
credentials and process state out of reach. Otherwise, run commands in a
separate execution environment. Supply an explicit subprocess environment
with credentials intended for commands. Isolation also covers what commands
can access through mounted files and process information. A local subprocess
can serve trusted development with its host access documented. The model
chooses the command and directory. Deployment owns the target and its access.

The [attachment tools](../../tools-and-callbacks/0003-DESIGN-attachment-tools/SPEC.md)
copy inputs into this same runner environment and publish outputs from it.

## Foreground execution

Foreground is the default. The calling turn waits for the tool outcome before
its next inference. Other channels can continue. Follow the existing
[tool execution and deadline rules](../../tools-and-callbacks/0001-DESIGN/SPEC.md),
including configurable deadlines and suspension behavior.

The runner owns process and output cleanup through settlement. On normal shell
exit, capture its status, terminate managed children left running, and drain
the output pipes within bounds. On timeout or interruption, request termination
and escalate after a bounded grace period. Report whether termination was
confirmed or remains uncertain. A process group can cover ordinary foreground
commands. A deployment that promises cleanup of detached children needs
runtime-managed process containment. Report the outcome as uncertain when a
crash prevents confirmation. Recovery keeps the original invocation identity
and does not launch the command again.

## Background execution

A follow-up increment adds `background: true` to `shell`. The call returns a
job ID after successful launch. The turn can continue and finish while the
runner manages the job and its output. Shell syntax such as a trailing `&`
does not create a tracked job.

Each job belongs to its originating channel. The runner must support checking
status, reading bounded output, and cancelling by ID. Record the job's terminal
outcome before sending a completion notice with its ID, outcome, and output
reference when available. Use the existing channel notice path. The notice
can start an idle channel or reach a running turn at its next inference
boundary, subject to channel and session admission. Retrying notice delivery
uses a stable identity and never launches the command again.

Channel suspension interrupts every live background job owned by that channel.
Once suspension starts, fence new launches and cancel jobs already launched,
including their child processes. A launch racing with suspension is either
rejected or tracked and included in cancellation. The runner handles this by
channel even when the launching turn has ended. Use the same cancellation path
as for an interrupted foreground command. A successful suspension acknowledgment
requires confirmed job termination. If confirmation misses the control deadline,
report suspension as pending and keep the channel fenced. Other channels can
continue. Preserve an outcome already recorded before cancellation. Keep
undelivered notices pending until the channel can accept them again. Resume
makes those notices eligible for delivery and leaves cancelled jobs terminal.

The background increment must define where job records live, which jobs
survive a harness or runner restart, how output is retained, and how channel
deletion and session-wide lifecycle operations affect jobs. If the outcome
cannot be established after a failure, report it as uncertain. A job can
outlive its launching turn. Background shell jobs run commands chosen by the
agent. Delegated workers can plan and carry out work themselves.

## Acceptance

1. Run commands in two different directories from concurrent channels. Show
   that changing directories within one shell has no effect on another call.
2. Show that denied, unavailable, and malformed calls start no process. Verify
   that unavailable and malformed calls produce a paired rejection without an
   approval prompt, and that approval shows the exact command and directory.
3. Verify stdout, stderr, exit status, bounded output, and interruption of a
   command with child processes. Test Bash exiting while a child still holds an
   output pipe open. Exercise the supported execution boundary with a visible
   workspace, an inaccessible path, and a harness-only secret.
4. For the background increment, show that the original turn ends while the
   job runs, then observe completion waking an unattached idle channel and
   steering an active channel. Verify status, output, cancellation, and retry
   of a lost completion receipt without another launch.
5. Let the launching turn finish, then suspend its idle channel while both
   channels have jobs. Verify that suspension acknowledges confirmed termination
   of its job and the other job continues. Check the launch race, pending status
   if confirmation misses the deadline, notice delivery after resume, and that
   the interrupted job runs only once.
