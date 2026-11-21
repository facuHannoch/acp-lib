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
| [acp-client integration contract](acp-client-integration/0001-DESIGN/SPEC.md) | Implemented, awaiting review | First scripted stdio checkpoint implemented on `acp-client-integration`; gates, evidence, gaps and drift are in the [log](acp-client-integration/0001-DESIGN/11-20-LOG.md). Next: independent review of each gate. |
| [Operator and consumer controls](operator-controls/0001-DESIGN/SPEC.md) | Spec and plan drafted | Review the [implementation plan](operator-controls/0001-DESIGN/PLAN.md) before handoff. |
| [Long-running mock mode](long-running-mock/0001-DESIGN/SPEC.md) | Spec and plan drafted | Review the [implementation plan](long-running-mock/0001-DESIGN/PLAN.md), including the final driven rehearsal. |

## Priorities

First, give acp-client a harness it can develop and test against offline:

1. Define the acp-client integration contract.
2. Define [configurable tools and host callbacks](tools-and-callbacks/0001-DESIGN/SPEC.md),
   starting with consumer-registered tools. Review the
   [implementation plan](tools-and-callbacks/0001-DESIGN/PLAN.md).
3. Review the [operator and consumer controls spec](operator-controls/0001-DESIGN/SPEC.md)
   and [implementation plan](operator-controls/0001-DESIGN/PLAN.md).
4. Review the [long-running mock mode spec](long-running-mock/0001-DESIGN/SPEC.md)
   and [implementation plan](long-running-mock/0001-DESIGN/PLAN.md).

The integration checkpoint is a real stdio run from acp-client with two
conversations on one session, a host tool callback, an approval, interruption
isolated to one channel, and recovery after restart. A short scripted test
can start before the long-running mock mode is complete.

After that checkpoint, design bounded context, cross-channel messaging,
image input, and the policy needed to govern shared history and messaging.
Broader shared identity for external conversations remains on the v1 list.
Skills, MCP, and the broader standalone CLI follow the integration work.
Skills are the preferred first follow-up among those three.

New work is organized by concern. Use the next visible number in that concern
for a `DESIGN`, `AMENDMENT`, or small `MODIFICATIONS` item. Keep dates in
document headers and timestamps in log entries. Existing dated work folders
can move at a clean handoff.

[Deferred ideas](todos/) can stay there until they become numbered work items.
[Business rules](BUSINESS_RULES.md) track adjustable defaults and behavioral
tradeoffs alongside the specs that own them.
