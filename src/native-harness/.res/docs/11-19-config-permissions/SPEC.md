# Native harness configuration and tool permissions

Status: proposed for review.

## Scope

A consumer can configure a session, assign tool policies to channels and
individual messages, and answer approval requests for specific tool calls.
The harness enforces those decisions before executing a tool. Use the
existing tools and scripted inference to verify the flow.

This slice builds on the durable inbox and checkpoints in the
[persistence spec](../11-16-persistence/SPEC.md) and the channel lifecycle in
the [channel-controls spec](../11-19-channel-controls/SPEC.md).
Configured tool adapters, shared-history access policies, and
[automatic approval review](../todos/11-19-TODO-auto_review-approve.md)
are separate work.

## Session configuration

Each open session uses one validated configuration. The provisional
default home is `~/.harness`, with `--home` as an override.

```text
<home>/<session_id>/
  config.json       # optional
  session.sqlite
```

Configuration contains the system prompt, model selection, named tool policies,
and the default policy. At creation, the consumer can supply it directly or
provide `config.json`. The server keeps the validated configuration in memory
while the session is open and saves a portable copy with the session so it
can reopen without a sidecar.

When `config.json` is present at open, it supplies the configuration for that
open. Otherwise, load the saved copy. File edits take effect on the next open.
An invalid file produces a validation error without replacing the saved copy.
Expose validation separately so a consumer can check configuration before
starting inference. Errors identify the invalid field or policy reference.
Use environment references for credentials and resolve their values at runtime.

On reopen, validate stored policy references before enabling execution. A
configured policy that still exists can change its rules for future turns
after reopen. Resuming a checkpoint also requires compatible execution
configuration, including the policy definitions relevant to that checkpoint.
If the configuration is incompatible, leave the checkpoint and pending inputs
intact and allow inspection.

### Export and import integration

The [session-file amendment](../persistence/0002-AMENDMENT-session-file/SPEC.md)
defines the binary file format and saves the active, validated config
atomically with the imported snapshot. The config loader opens the restored
session from that saved config without a sidecar or an inline config argument.

Use the per-session directory for managed sessions. This slice replaces the
experimental flat database layout without migration support. Preserve the
explicit development `--db` path.

## Tool policy

Proposed first rule format. Each named policy has an explicit fallback of
`allow`, `ask`, or `deny`, and may override that fallback by exact tool
name. Require the session default to name a defined policy. An example
policy can allow `current_time`, ask for `dashboard_work`, and deny every
other tool. Pattern matching can be designed when a consumer needs it.

Resolve the policy for each input in this order:

1. The policy explicitly supplied by the trusted consumer for that message.
2. The channel's configured policy.
3. The session's default policy.

Reject an unknown explicit policy when accepting input or updating a
channel. Persist the resolved policy name with the accepted item so a
channel policy change cannot silently reclassify waiting input. A message
body cannot set its own policy.

Include the submitted explicit policy, or its absence, in the input's
deduplication identity. An identical retry returns the original receipt
and preserves the policy resolved at first acceptance, even after a
channel policy change. Reusing the same message ID with a different
explicit policy returns `item_conflict`, even if both requests would
resolve to the same policy.

For internal notices, the harness records the source turn's contributing
policy references at acceptance, including any restrictions inherited from
earlier notices. The model cannot supply a policy override. When the target
turn takes the notice, combine the stored source references with the
target's policy resolved at acceptance and the policies of any other
inputs the target turn has taken. Preserve those references across restart
and export/import. A notice cannot grant the target turn tool permissions
that its source turn lacked under the open configuration.

A policy contributes to the active turn when the turn takes the input.
For each proposed tool call, evaluate the applicable rules across all
inputs the turn has taken. `deny` wins over `ask`, and `ask` wins over
`allow`. The decision for one tool need not match the decision for another.
A later input can tighten tool permissions for the remainder of that turn.
An input still waiting in the inbox has no effect on the turn. A tool
already running is unaffected. A fresh turn starts with the policies of
the inputs it takes.

This intentionally makes no distinction between chat text that asks to
change the work and chat text that only asks for an update. Either can
tighten an active turn after take. Tool policy governs execution and does
not define who can read the shared timeline.

## Consumer approval

Check policy in code immediately before tool execution. `allow` permits
the call. `deny` produces a paired tool result without invoking it. `ask`
opens one approval request for the exact call, with a request ID, channel
ID, turn ID, tool call ID, tool name, and arguments. The consumer can
allow once or deny. Approval does not change a policy or authorize
different arguments, later calls, or another turn.

A waiting approval occupies only its own turn. Other channels continue.
Give each request a bounded timeout. Denial, timeout, a missing approval
handler, or disconnection of the approval consumer closes the request
and leaves its tool unexecuted. Record the reason in the paired tool
result if the turn continues.

Publish `tool_call: started` when the tool is dispatched. Waiting for
approval, granting approval, and recording a result for a skipped call
do not emit `started`. The execution gate orders dispatch against
cancellation. If suspension wins before an approval-gated call is
dispatched, close the request or discard the unused grant, and record
`approval_cancelled_by_suspension`. If dispatch wins, the running tool
finishes under the normal suspension rules. An allow-once grant is
consumed at dispatch and cannot be reused.

On channel or session suspension, close outstanding approvals in the
affected part of the session and record a paired tool result with reason
`approval_cancelled_by_suspension`. Further requests in the finishing
iteration that would require approval receive the same result. The
result explains that the tool did not run and that the resumed turn can
make a fresh call to request approval if the action is still needed.
Finish the iteration using the existing checkpoint rules.

Interrupt or stop closes requests for interrupted turns and fences off
tool execution. A late or duplicate response cannot reopen a request.
An unanswered request never survives as executable approval across
restart or resume. Serialize decision, cancellation, and tool dispatch so
a response arriving after cancellation cannot cause the tool to run.

## Acceptance

Use a scripted model and observable tool effects to verify the public
approval flow without provider credentials.

1. Open with valid configuration, reject invalid fields without changing
   saved state, and verify file edits apply on reopen. Remove the sidecar
   after opening, export a binary `.harness` file, then import and reopen in
   a fresh home without a sidecar. Verify the imported config matches the
   version the source server used. Reject invalid or unsupported file formats.
2. Resolve message, channel, and default policies. Verify one policy
   combination before and after take, including a tool that remains
   permitted by both policies. Reject an unknown named policy.
   Retry an accepted message after a channel policy change and verify
   its resolved policy stays the same. Reuse its ID with a changed explicit
   policy and verify a conflict. Reopen with a pending notice from a more
   restrictive source and verify that the target turn still enforces that
   restriction when it takes the notice.
3. Exercise allow, deny, and ask through the execution gate. An approval
   runs the exact call once. A denied, timed-out, disconnected, or
   unhandled request produces no tool effect. Verify a second channel
   can finish while the first waits.
4. Suspend a turn awaiting approval, resume it, and observe the recorded
   suspension reason in its model context. A late response produces no
   tool effect. If the model requests the action again, it receives a
   new approval request. Interrupt and stop likewise fence late approval.
   Exercise both orders of suspension versus dispatch after approval.
   Before dispatch, suspension produces the distinct cancellation result
   with no tool effect or started event. After dispatch, suspension lets
   the running call finish, with exactly one started event.

Record the configuration shape, policy metadata, approval wire contract,
and lifecycle race outcomes in a contract decision before dependent code
changes.
