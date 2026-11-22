# Native harness work

Updated: 2026-11-20.

The coordinator updates this index when a work item's status, dependency, or next
action changes. Implementers and reviewers record revisions, findings, and test
results in the work item's log. An accepted design keeps its own row when a later
amendment is proposed.

| Work item | Status | Dependency and next action |
| --- | --- | --- |
| [Persistence baseline](11-16-persistence/SPEC.md) | Accepted | Behavior approved at `9d9de35`, with [closure notes](11-16-persistence/LOG.md) at `3a236ac` on `aiagent/native-persistence`. |
| [Persistence 0002 · Session-file amendment](persistence/0002-AMENDMENT-session-file/SPEC.md) | Accepted | Behavior approved at `7e49bd5` on `aiagent/cod1a-session-file`. Managed reopen is part of configuration and permissions. |
| [Channel controls](11-19-channel-controls/SPEC.md) | Accepted | Behavior approved at `4d58629`, with closure and documentation at `3428258` on `aiagent/cod1a-native-channel-controls`. |
| [Configuration and permissions](11-19-config-permissions/SPEC.md) | Accepted | Behavior approved at `626783e`, with closure at `28c6faf` on `aiagent/cod1a-config-permissions`. |
| [Model execution](model-execution/0001-DESIGN/SPEC.md) | Accepted | Behavior approved at `02c96de`, with closure at `49f2974` on `aiagent/cod1a-model-execution`. |
| [acp-client integration contract](acp-client-integration/0001-DESIGN/SPEC.md) | Accepted | Behavior approved at `7133c5c`; `acp-client-integration` includes the corrected [closure log](acp-client-integration/0001-DESIGN/11-20-LOG.md) at `b9a96b8`. |
| [Tools and host callbacks](tools-and-callbacks/0001-DESIGN/SPEC.md) | Accepted | Behavior approved at `f4eff94`, with the [closure log](tools-and-callbacks/0001-DESIGN/LOG.md) at `c1c3e88` on `tools-and-callbacks`. |
| [Tools and callbacks 0002 · Callback policy names](tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md) | Design reviewed, ready for contract implementation | Define the `policyNames` wire and handler contract and update the harness and acp-client together. The orchestrator binds worker rules at session open. |
| [Operator and consumer controls](operator-controls/0001-DESIGN/SPEC.md) | Ready for Gate 1 | Start the contract gate in the [implementation plan](operator-controls/0001-DESIGN/PLAN.md) on the accepted integration and callbacks base. |
| [Long-running mock mode](long-running-mock/0001-DESIGN/SPEC.md) | Design reviewed, awaiting dependency | Start Gate 1 of the [implementation plan](long-running-mock/0001-DESIGN/PLAN.md) after operator controls are accepted. |
| [Channel messaging 0001 · External notices](channel-messaging/0001-DESIGN-external-notices/SPEC.md) | Spec and plan reviewed | Begin [Gate 1](channel-messaging/0001-DESIGN-external-notices/PLAN.md) on the reviewed operator-controls base. The generic notice path can proceed once its contract is approved. Worker delivery also needs callback policy metadata and proof that the first worker backend can recover completion after acp-client exits. |

## Priorities

First, give acp-client a harness it can develop and test against offline:

1. Begin [operator and consumer controls](operator-controls/0001-DESIGN/PLAN.md)
   at Gate 1 on the accepted callbacks base.
2. Begin [long-running mock mode](long-running-mock/0001-DESIGN/PLAN.md)
   at Gate 1 after operator controls are accepted.

The integration checkpoint is a real stdio run from acp-client with two
conversations on one session, a host tool callback, an approval, interruption
isolated to one channel, and recovery after restart. A short scripted test
can start before the long-running mock mode is complete.

The orchestrator needs the callback policy amendment and external notices.
External notices are the first channel-messaging slice.

After the checkpoint, design bounded context, broader cross-channel messaging,
image input, and the policy needed to govern shared history and messaging.
Broader shared identity for external conversations remains on the v1 list.
Skills, MCP, and the broader standalone CLI follow the integration work.
Skills are the preferred first follow-up among those three.

[Node-level resource coordination](todos/11-21-TODO-node-resource-coordination.md)
is a deferred optimization after the usable-harness milestone and profiling.

New work is organized by concern. Use the next visible number in that concern
for a `DESIGN`, `AMENDMENT`, or small `MODIFICATIONS` item. Keep dates in
document headers and timestamps in log entries. Existing dated work folders
can move at a clean handoff.

[Deferred ideas](todos/) can stay there until they become numbered work items.
[Business rules](BUSINESS_RULES.md) track adjustable defaults and behavioral
tradeoffs alongside the specs that own them.
