# Shell execution

Date: 2026-11-22

Status: Proposed for M2. The first delivery includes foreground execution,
tracked background jobs, and per-call timeouts. See the
[implementation brief](IMPLEMENTATION-BRIEF.md) for the proposed code structure.

## Implementation handoff

Give the implementation agent this spec and a committed base revision. Work
in a separate branch and worktree so other harness changes can proceed.
The assignment is to deliver an independently tested shell capability and
the integration handoff described below.

### Files and dependency boundary

- Keep the tool definition, validation, runner, output handling, and job
  manager under `src/capabilities/tools/shell/`. Keep tests under
  `test/shell/` and shell-specific fixture code alongside them. These paths
  are relative to the native harness package.
- Depend on stable harness contracts for shared types. Keep provisional
  launcher, lifecycle, output storage, and completion-delivery interfaces
  in the shell module. Exercise them through a test assembly with an injected
  execution environment, controllable dependencies, and the real Linux runner.
- Leave shared session assembly, runtime tool registration, protocol, kernel,
  common storage formats, and ACP-client launcher wiring for the integration
  pass. When an existing interface falls short, record the exact missing
  operation and the proposed caller and result. Implement and test the shell
  side against the injected interface and continue with the other acceptance
  cases. Shared contract changes go through the harness decision process.

### Work through these checkpoints

1. **Definition and validation.** Implement the shell input and result
   contract below. Test that invalid input and unavailable execution fail
   before the runner is called. Use the existing tool-result byte ceiling for
   the complete inline preview. Keep the naming and shape of job inspection
   operations local to the capability until integration.
2. **Foreground and deadlines.** Use harmless commands in temporary
   workspaces to verify effective working directory, exit status, stdout and
   stderr, clipping, and timeout and cancellation cleanup. Include a child
   that holds an output pipe after the shell exits. Verify whether cleanup is
   confirmed under the chosen containment and report uncertain when it
   cannot be confirmed.
3. **Background jobs.** Verify that launch returns before completion, that
   the owner can inspect output and cancel, and that another channel cannot
   use the job ID. Test channel suspension, session shutdown, and a launch
   that races with suspension by invoking the lifecycle interface directly.
   Deliver completion to the fixture notice sink with a stable identity.
   A delivery retry must preserve the outcome and must never execute the
   command again.
4. **Replacement and handoff.** Give the runner ownership of live jobs.
   A reconnect to the same runner can inspect existing jobs when their
   identities are available. For a replaced runner, recover only outcomes
   that can be established from recorded evidence and report uncertainty
   for unresolved jobs. Process survival across runner replacement is outside
   the initial guarantee. Demonstrate the chosen ownership and recovery
   behavior with controlled fixtures.

Keep a `LOG.md` beside this spec with completed checkpoints, commands and
results, and gaps. Make routine choices within the contract and record them.
When a fixture fails, diagnose and rerun it. If shared wiring is needed,
capture the dependency and continue all capability work that can be verified
in isolation. The handoff includes the exact candidate revision, passing
focused tests and harness typecheck, and the seams required for integration.

The integration pass verifies model-facing registration, real policy and
approval decisions, scoped `read_tool_result` reads, lifecycle calls, and
completion notices through managed stdio. It also verifies the production
execution boundary in the chosen deployment. The capability gate can finish
while those integration checks are pending.

## Tool contract

Expose one optional `shell` tool for running commands directly in an Agent's
execution environment. The initial runner executes Bash on Linux. The tool
description tells the model which shell syntax is available.

```json
{
  "command": "git branch --show-current",
  "cwd": "/dir3/d",
  "timeoutMs": 120000,
  "background": false
}
```

`command` is a non-empty shell command string. An omitted `cwd` uses the
workspace selected by the launcher. An explicit `cwd` is an absolute path in the
runner's environment. A `cd` affects that invocation and its children. Later
calls and other channels keep their own directories.

`background` defaults to false. `timeoutMs`, when supplied, is a positive
integer in milliseconds and measures execution after launch. Foreground
calls default to two minutes. Background calls without an explicit timeout
run under the execution lifetime. The runner enforces deployment limits in
both modes.

Foreground results carry exit status, bounded stdout and stderr previews, and
clipping information. A nonzero exit status is a command outcome with its
available output. A failure to start, deadline expiry, or interruption uses
the existing execution outcome conventions. Budget the complete serialized
result in UTF-8, including escaping and result metadata.

When retaining complete output, return a scoped reference through the existing
`read_tool_result` contract. The producer owns retention and expiry. The
harness checks session, channel, and invocation ownership before routing a
read. Indicate when clipped output has no readable reference.

## Permission and dispatch

Reuse the shared policy, approval, dispatch, and result lifecycle. Use the
[web tools](../../web-tools/0001-DESIGN/SPEC.md) as a reference for checked
registration. Validate availability and the resolved arguments before approval.
Pair unavailable or malformed calls with a rejection before prompting or
starting a process. If approval is required, show the exact command and working
directory. Recheck availability at dispatch, execute the approved arguments,
and record the call and paired outcome through the existing tool lifecycle.
Command-specific rules such as matching a Git subcommand can be added to the
permission layer later. The initial policy applies to `shell` as a tool.

## Runner and execution environment

The runner implements process execution behind the [architecture's execution
port](../../../../ARCHITECTURE.md). It receives the validated command, working
directory, effective timeout, mode, invocation identity, and cancellation
signal. It starts the shell,
captures output, and tracks the process and its children through exit or
termination. The harness owns tool admission, turn state, and recording the
paired result. Keep the schema, validation, defaults, result formatting,
runner adapter, and job operations in the shell capability. Integrate any
shared resource lifecycle hooks independently of tool names.

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

With `background: true`, `shell` returns a job ID after successful launch.
The turn can continue and finish while the runner manages the job and its
output. A tracked job is created through this option. A trailing `&` has
ordinary shell semantics.

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

The implementation must document where job records live, which jobs survive
harness or runner restart, how output is retained, and how channel deletion
and session-wide lifecycle operations affect jobs. After a failure, report
uncertainty when the outcome cannot be established. Preserve the original
job identity and never relaunch a command to recover its result.

## Acceptance

1. Run commands in two different directories from concurrent channels. Show
   that changing directories within one shell has no effect on another call.
2. Show that denied, unavailable, and malformed calls start no process. Verify
   that unavailable and malformed calls produce a paired rejection without an
   approval prompt, and that approval shows the exact command and directory.
3. Verify stdout, stderr, exit status, bounded output, retained output reads,
   and per-call timeouts and interruption for commands with child processes.
   Test Bash exiting while a child still holds an
   output pipe open. Exercise the supported execution boundary with a visible
   workspace, an inaccessible path, and a harness-only secret.
4. Show that the original turn ends while the
   job runs, then observe completion waking an unattached idle channel and
   steering an active channel. Verify status, output, cancellation, and retry
   of a lost completion receipt without another launch.
5. Let the launching turn finish, then suspend its idle channel while both
   channels have jobs. Verify that suspension acknowledges confirmed termination
   of its job and the other job continues. Check the launch race, pending status
   if confirmation misses the deadline, notice delivery after resume, and that
   the interrupted job runs only once.
