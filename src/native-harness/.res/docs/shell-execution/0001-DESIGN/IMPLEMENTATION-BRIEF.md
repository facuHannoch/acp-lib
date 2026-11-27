# Shell tool implementation brief

Status proposed. This brief describes how to build the [shell spec](SPEC.md)
with tracked background execution and timeouts in the first delivery.

## Behavior to reproduce

- Follow [OpenCode's shell behavior](https://opencode.ai/docs/tools/).
  Foreground calls wait for the result. Background calls return a job ID and
  notify the conversation when they settle. A call can supply its own timeout.
- Follow [Pi's separation of tool and shell operations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts).
  Register the tool independently of the selected runner. The launcher binds
  that runner to the agent's execution environment.
- Use the existing native approval and invocation records. Run approved
  arguments once. Reuse the scoped result reference and channel notice
  contracts for retained output and completion delivery.

## Tool surface

`shell({ command, cwd?, timeoutMs?, background? })` launches one command.
Use the launcher's workspace when `cwd` is omitted. Default to foreground
execution with a two-minute timeout. A background call without an explicit
timeout runs under the existing execution lifetime. The runner owns any
deployment limits.

A foreground result carries exit status, stdout and stderr previews, clipping
information, and a scoped output reference when full output is retained.
A background launch returns a job ID. Expose status, bounded output and
cancellation for that ID within the originating conversation. Use the
existing channel notice path for completion. An exit code other than zero
is a command outcome and includes the available output.

## Implementation boundary

Use the [isolated handoff and checkpoints](SPEC.md#implementation-handoff)
for the first worktree. The notes below describe how the capability will
fit into the harness during integration.

Keep the shell schema, description, validation, defaults, result formatting,
runner adapter, and job operations under the shell capability. Attach the
tool definition to the shared dispatch gate in `src/index.ts`. The existing
checked web registration is a reference for admission and dispatch, with its
paid usage fields specific to web tools. Use the existing tool callback path
where it fits. If native registrations need a shared seam, make it
provider-neutral and keep tool names out of policy, dispatch and the kernel.

Use platform or runner lifecycle hooks for resources that can outlive a turn.
The existing turn abort signal covers foreground work. Background jobs need
hooks for channel suspension and deletion, session stop, and process
replacement. Keep those hooks generic so another tool can own a resource
without changing lifecycle code. A lost response or unknown outcome never
causes an automatic relaunch.

The implementation investigation should verify the runner's actual execution
boundary, channel ownership and suspension semantics from the shell spec, and
which job state must survive a harness reconnect. Routine choices such as
preview budgets and naming for job operations can follow existing harness
conventions. Prefer existing code for output paging and notification delivery.
