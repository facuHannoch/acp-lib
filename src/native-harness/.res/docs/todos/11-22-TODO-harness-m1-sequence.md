# TODO: Harness M1 implementation sequence

Date: 2026-11-22.
Status: ready to start operator controls Gate 1.

## Starting point

Start work from `aiagent/haurness-l`. It contains the accepted acp-client
integration (`7133c5c`) and tools and host callbacks (`f4eff94`, closure
`c1c3e88`). The reviewed callbacks also landed on `alpha`. Pin the worktree
base and the spec and plan revisions in the first handoff.

## Work in order

1. **Operator and consumer controls.** Start with Gate 1 on the accepted
   callbacks base. Review the replacement wire contract, bounded storage reads,
   and the host-level approval responder before implementing either side.
   Finish the real stdio checkpoint for independent attachment, recovery,
   approvals, and opt-in history. The short checkpoint can run as soon as
   operator controls is ready. [Spec and implementation gates](../operator-controls/0001-DESIGN/PLAN.md)
2. **Long-running mock mode.** Start from the accepted operator-controls base.
   Use the JSONL adapter and acp-client driver to run the deterministic CI
   scenario and the multi-minute rehearsal. Record the fixture, command, and
   result. [Spec and implementation gates](../long-running-mock/0001-DESIGN/PLAN.md)
3. **Callback policy names amendment.** Carry the policies that authorized the
   invocation through `functions/call` and the acp-client handler context.
   Verify mixed policy, approval, and the explicit policy-free case. The
   orchestrator owns rule lookup and application. [Amendment](../tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md)
4. **External notices.** Implement `channel/notify` over the durable inbox,
   then connect acp-client's durable worker handoff. Gate 1 verifies that the
   first supported worker backend can recover a completion after acp-client
   exits. The generic harness path can proceed once its contract passes review.
   Keep full worker-delivery acceptance open until a supported backend passes
   the crash cases. [Spec and implementation gates](../channel-messaging/0001-DESIGN-external-notices/PLAN.md)

The short stdio checkpoint establishes the native integration path. The timed
rehearsal exercises it under load. The policy amendment and external notices
then complete the harness path needed for durable worker delivery. The usable
harness milestone follows, beginning with bounded model context.

## Review process

Use one implementer and one independent reviewer. The coordinator pins the
base and records the exact revision and evidence at each gate. The implementer
grounds the gate in the current code and sends the revision for review. The
reviewer checks it against the spec and independently verifies the gate. They
can resolve findings directly, with scope decisions brought back to the
coordinator. Start each next slice from the accepted revision of its base.

For current status, see the [work index](../WORK.md).
