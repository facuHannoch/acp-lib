# Callback policy names

Date: 2026-11-21.
Status: proposed for contract review.

Amends the [`functions/call` contract](../0001-DESIGN/SPEC.md#host-callback).
The acp-client orchestrator needs to know which policies contributed to a call
so it can apply its own worker rules. For example, the harness may allow a tool
that sends work to a worker, while the orchestrator must inspect the worker's
current assignment to decide whether the operation would take over busy work.

## Wire and handler contract

Add required `policyNames: string[]` to `functions/call`. It is a deduplicated
list of the configured policy names used in the harness's authorization of
that invocation. It includes the resolved policy of each input already taken
into the turn and any policies inherited from notices. Pending inputs start
contributing when the turn takes them. The list's order grants no precedence.
The harness omits its internal `__legacy_allow` fallback from the field. An
empty list explicitly means that no configured policy contributed.

Collect the names once for the dispatch authorization and use the same list to
evaluate the tool decision and build the callback. If the call waits on approval,
keep that list with the invocation. The harness sets the field independently of
the model's tool arguments. Existing denial, approval, and dispatch behavior
continues to apply.

Carry the field through stdio and in-process callbacks. Validate its shape at
the protocol boundary and expose it in acp-client's `NativeFunctionContext`.
Reuse the policy metadata on taken inputs. This amendment requires no storage
schema change. Update the harness and acp-client together in the same slice.
The contract gate records the wire and handler types before implementation.

## Responsibility in the orchestrator

When opening the harness session, acp-client binds the worker-rule mapping
that corresponds to its active policy configuration. The orchestrator resolves
names against that mapping and applies the most restrictive applicable worker
rules. An empty list selects the orchestrator's configured default worker
rules. This default is also available to other harness integrations that
explicitly indicate they have no policy context. A missing field on a native
callback or an unknown name is invalid. Decline delegation in either case.
When an assignment starts, retain its resolved rules for later worker
permission requests. The
[orchestrator spec](../../../../../../.res/somelogs.md/11-11+/library/11-11-SPEC-orchestrator.md#policy-limits)
owns those worker rules and their composition.

## Acceptance

1. An authorized callback from a single-policy turn exposes that policy name
   in the host handler.
2. A notice sent by a `guest` turn to an `owner` channel contributes both names.
   Verify the host receives both once, and that a pending input contributes
   only after it is taken. Check that model arguments cannot set the metadata.
3. Exercise `ask` over real stdio. Verify approval dispatches one callback with
   the same policy names used for the tool decision. A denied call produces no
   callback. Verify the in-process transport exposes the same handler context.
4. In the orchestrator's tests, show that `owner` plus `guest` can send work to
   an idle worker when both policies allow it, and that guest restrictions
   prevent takeover of a busy worker. Verify matching names in different
   sessions use the mappings bound at their respective opens. Verify later
   worker permission requests use the assignment's resolved rules.
5. A policy-free native session sends an empty list and uses the configured
   default worker rules. Missing native metadata and unknown names are refused.
