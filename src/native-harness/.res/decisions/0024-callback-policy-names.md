# 0024 Callback policy names

## Problem and options

The callback consumer needs the policy names that authorized the invocation
to apply its own rules. Model arguments are untrusted. Re-reading policy
inputs after an approval can give the callback a different answer from
the authorization gate. Carry the authorization snapshot as required wire
metadata.

## Choice

After structural tool checks and before deciding allow, ask, or deny,
collect one deduplicated snapshot from the stored resolved and inherited
policy names of inputs already taken by the turn. Notices contribute their
transitive inherited names. Pending inputs contribute when taken, and channel
policy edits affect later admissions under the existing policy rules.
Evaluate the tool decision using that snapshot and the open configuration.
Retain it across approval and use it to build the callback at dispatch.
Neither approval nor dispatch re-reads the contributors for this invocation.
Existing denial, cancellation, and one-time dispatch rules still apply.

The callback carries the same set with the internal `__legacy_allow`
fallback omitted. The fallback still participates in authorization as
before. Empty explicitly means no configured policy contributed. Names
retain their exact spelling and are sorted lexically for reproducible
output. Order grants no precedence. The harness
sets the field independently of model arguments, including any argument
that happens to be named policyNames.

Both stdio and in-process validate the required top-level field before
invoking a handler. It must be an array of unique nonblank strings. A
missing field, wrong type, duplicate, or leaked legacy sentinel is
`invalid_params`. The harness records one paired failed tool result
through the existing callback error path, without retrying. Expose the received names as read-only metadata in
`NativeFunctionContext`. The orchestrator owns name lookup against the
mapping bound at open, refusal of unknown names, default worker rules for
the empty list, and retaining resolved assignment rules. These are separate
orchestrator acceptance cases.

## Compatibility

Update the native harness and acp-client together. Older callbacks with the
field absent are incompatible with this boundary and are refused. An
explicit empty list is valid. There is no new capability, storage change,
archive version, or migration.
