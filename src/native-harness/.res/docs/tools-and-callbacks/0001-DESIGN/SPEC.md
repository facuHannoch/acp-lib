# Native harness tools and host callbacks

Date: 2026-11-20.
Status: proposed for review.
See [PLAN.md](PLAN.md) for implementation and acceptance gates.

## Scope

Let a consumer register functions that the harness can offer to the model and
execute through the existing permission gate. Define a common tool-call
lifecycle and prove it with a consumer-registered function over real stdio.
Support the same behavior in process.

Build on [configuration and permissions](../../11-19-config-permissions/SPEC.md)
and the [acp-client integration](../../acp-client-integration/0001-DESIGN/SPEC.md).
Reuse the original
[`functions/call` proposal](../../../../../../.res/somelogs.md/11-11+/11-12-SPEC-harness-protocol.md).
HTTP, command, and MCP executors, per-channel tool selection, and
[user-entered code](../../todos/11-20-TODO-user-entered-tool-code.md) remain
separate work. Existing built-in tools keep working through the same gate.

## Tool catalog and availability

The session owns tool definitions. A definition has a unique name, description,
input schema, and a binding to a handler supplied by the consumer. The handler
name is the binding for this slice. Tool names also identify policy rules.
Reject duplicate names across the session, including conflicts with built-ins.

| Group | Behavior |
| --- | --- |
| **Configured, fixed** | The consumer declares these at session open. Runtime operations cannot remove their registrations. |
| **Configured, revocable** | The consumer declares these at session open and can revoke or restore their grants. Save those decisions with the session so reconnect and export/import preserve them. |
| **Runtime** | The consumer can enable or remove tools by name from its registered catalog. Keep the enabled set in memory for this slice. The consumer supplies it again when it reconnects. |

The consumer provides definitions for runtime tools and binds their handlers
before enabling them. Changes by name reuse that definition and binding.
Changing schemas or replacing handlers live is deferred. Tool definitions and
grants are data. The consumer supplies handler implementations at runtime.

The host advertises its available handler names during connection setup.
Provision bindings and any initial runtime selection before recovered work
can start. A missing handler makes a tool unavailable. A fixed registration
remains subject to handler availability and policy. Expose availability
separately from policy so a consumer can tell why a tool cannot run.

## What the model sees

For each inference, take a snapshot of the available tool definitions and the
turn's effective policy. Show tools the turn may call or ask to use. Omit
unavailable tools and tools the policy denies. Keep the snapshot fixed across
retries of that request. Changes to definitions offered to the model take
effect on the next inference.

Preserve a stable group of available fixed definitions and a changeable group
for model adapters. For OpenRouter, combine them into one native tools array
with fixed tools first and deterministic order within each group. Other
adapters can use the groups for provider-specific placement. Both groups use
the same execution gate.

Before dispatch, require a call to match a definition offered in its request.
Validate the arguments against that definition and check current availability
and applicable policy. Revocation or removal before dispatch prevents execution,
including after an approval has been given. Close a pending approval for a tool
that becomes unavailable. A tool already dispatched follows the normal
completion and cancellation rules.

## Invocation and lifecycle

Each invocation belongs to the channel and turn that requested it. Give it a
stable harness invocation ID for client and callback correlation. Keep the
provider's tool-call ID for pairing its result with the model response. The
record includes the channel, turn, tool name, arguments, disposition, and
outcome. Channels execute independently. Within one iteration, continue
processing tool calls in order.

| State | Meaning |
| --- | --- |
| **Requested** | A complete tool request was committed with the assistant response. |
| **Waiting for approval** | Policy requires an approval for this particular call. Dispatch has yet to occur. |
| **Started** | The harness dispatched the authorized call after recording dispatch evidence. For a remote callback, this does not confirm the host handler began. |
| **Succeeded** | The executor returned a result and the harness committed it. |
| **Failed** | The executor returned a known error. Record the error without inferring that the handler had no effect. |
| **Skipped** | The harness did not dispatch the call. Reasons include invalid arguments, an unavailable tool, policy denial, or approval cancelled by suspension. |
| **Interrupted** | Interruption, timeout, or disconnect ended the harness's wait after dispatch. Without an authoritative outcome, report the effect as unknown. |

Publish live state changes with the invocation ID. Expose stored calls and
outcomes by ID after reconnect. Keep dispatch evidence before a possible
external effect, and persist the result before publishing a terminal result
event. On recovery, dispatch evidence without a committed outcome means the
effect is uncertain, including a crash between recording dispatch and sending
the callback.
The harness never automatically repeats an uncertain callback.

For a turn that continues, give the model a paired result with inline output,
a preview and a result reference, or a typed error. Include a reason it can
act on, such as correcting arguments or requesting a new approval after
resume. An interrupted turn retains its records and starts no further work.

## Host callback

The proposed [callback policy amendment](../0002-AMENDMENT-callback-policy/SPEC.md)
adds contributing policy names for downstream authorization.

After authorizing and recording dispatch, send `functions/call` to the host
over the same connection. Include the invocation ID, session, channel, turn,
tool name, and validated arguments. The handler returns inline structured
output, a preview with a result reference, or a typed error. The harness
owns the callback wait and keeps other channels running. Match responses to
the exact outstanding request even when several callbacks are in flight. The
in-process client follows the same lifecycle.

The consumer can set an execution deadline per tool, with an optional session
default. If neither is set, the harness applies no wall-clock execution deadline.
Any configured deadline starts at dispatch. Approval has a separate deadline,
and the model deadline is already finished.

Interrupt and stop request cancellation of an active callback. Suspension
closes undispatched approvals and waits for dispatched tools to settle.
Report the call suspension is waiting on. A tool without a deadline can keep
suspension waiting until it settles or an operator interrupts it. Timeout or
disconnect closes the wait and requests cancellation where possible. Ignore
late responses for closed invocations. Cancellation cannot undo an external effect.
If a deadline expires while the turn is still live, commit a paired timeout
result with an unknown effect and let the turn continue. Interrupting the
whole turn ends execution for that turn.

### Status and connection health

Use the existing `session/status` operation for an on-demand connection probe.
A response confirms the control connection is responsive. Turn status shows
the current phase, when it began, and the relevant model call, approval, or
tool invocation ID. A tool can be active while producing no text or progress.

Keep timeout enforcement at the model, approval, and tool boundaries. This
slice adds no periodic ping or iteration-wide stall deadline. In acp-client,
native turn supervision uses the harness phase and outcome. A quiet callback
does not trigger the host's ACP output-silence timer. Connection failure
continues through the existing stop and recovery rules.

## Large results

When a successful result exceeds the inline limit, the producing process
saves the full result in its private result directory and returns a short
preview and an opaque result ID. This keeps the callback response within its
frame limit. An oversized inline result uses the reference path and remains
a success if the producer stored it successfully.

Offer a narrow `read_tool_result` tool that accepts the result ID and reads a
bounded portion of its contents. Route the read to the process holding the
bytes. For a consumer callback this can be another callback to the host.
The harness and host can have separate filesystems. Each uses storage it is
permitted to access, with no dependency on a shared `/tmp` path.

Bind the reference to the producing session, channel, and invocation.
Authorize the read using the requesting channel supplied by the harness,
alongside the normal tool policy. The producing channel can retrieve the
result when policy allows it. An unrelated channel cannot use the reference,
including when it encounters the ID in shared history. The reader accepts
result IDs rather than filesystem paths. The producer owns retention and
declares the lifetime and availability of the bytes across restart or
relocation. Preserve that information with the result reference. If a
temporary result expires, report that explicitly. The original call retains
its recorded outcome.

The contract gate defines callback negotiation, request and response envelopes,
cancel signaling, inline limits, result reference and read shapes, result
retention, and client event and recovery shapes. Record adjustable defaults in
[BUSINESS_RULES.md](../../BUSINESS_RULES.md).

## Acceptance

Use scripted inference, controlled handlers, and observable effects:

1. Register one consumer function and call it through a real stdio session.
   Verify schema validation, approval for the exact call, one invocation, and
   a committed result that reaches the next inference. Verify Bob's channel
   completes while Alice is waiting for her callback.
2. Verify fixed registration cannot be removed, revoked grants survive reopen,
   and runtime tools can be enabled and removed from the registered catalog.
   Check that denied tools stay out of the offered list and that retry uses
   the same list as the initial attempt.
3. Revoke a tool after inference offered it but before dispatch, including
   while approval is pending. Verify a skipped outcome and no callback effect.
4. Time out a dispatched callback while the turn stays live. Verify one
   paired timeout result reaches the next inference and a late reply cannot
   change it or trigger another inference. Separately interrupt a turn and
   verify a late reply starts no further work. Simulate a lost response, then
   reopen and verify the effect remains uncertain and the callback is never
   repeated automatically. Verify other channels continue while the connection
   is available.
5. Verify a callback can outlast a short test deadline on a different tool.
   Check that tool-specific deadlines override the session default, and that
   an unset deadline does not end a running call. While suspension is waiting
   on the untimed call, show its identity and verify interruption resolves
   the wait without replaying it. Verify acp-client supervision leaves a
   quiet callback active beyond the host's ordinary output-silence interval.
6. Return a result larger than a stdio frame from a producer that the harness
   cannot reach by a shared filesystem path. Verify the callback succeeds,
   the model sees a preview and result ID, and the producing channel can
   read the result through the scoped reader. Verify another channel, an
   arbitrary path, and an expired reference produce the appropriate errors.
