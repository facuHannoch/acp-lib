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
| [Model execution 0002 · Accounting](model-execution/0002-AMENDMENT-accounting/SPEC.md) | Draft for review | Report-only. Ground against final R5 before contract approval. Missing accounting evidence never blocks channel work. |
| [Model execution 0003 · Model catalog and live selection](model-execution/0003-DESIGN-model-selection/SPEC.md) | Proposed for v1 | Start with the catalog and turn binding contract, then provider execution, live storage and SDK acceptance. [Plan](model-execution/0003-DESIGN-model-selection/PLAN.md). |
| [Model execution 0004 · OpenCode Go](model-execution/0004-AMENDMENT-opencode-go/SPEC.md) | Implemented | Live native stdio turn passed with a local MCP fixture. Upstream template and gateway acceptance pending. [Plan](model-execution/0004-AMENDMENT-opencode-go/PLAN.md). |
| [Model execution 0005 · Trusted inference relay](model-execution/0005-AMENDMENT-trusted-http-inference/SPEC.md) | Implemented on relay branch | Executable-open grants protect an exact endpoint. Local fixtures cover dispatch, denial, expiry and restore. |
| [acp-client integration contract](acp-client-integration/0001-DESIGN/SPEC.md) | Accepted | Behavior approved at `7133c5c`; `acp-client-integration` includes the corrected [closure log](acp-client-integration/0001-DESIGN/11-20-LOG.md) at `b9a96b8`. |
| [Tools and host callbacks](tools-and-callbacks/0001-DESIGN/SPEC.md) | Accepted | Behavior approved at `f4eff94`, with the [closure log](tools-and-callbacks/0001-DESIGN/LOG.md) at `c1c3e88` on `tools-and-callbacks`. |
| [Tools and callbacks 0002 · Callback policy names](tools-and-callbacks/0002-AMENDMENT-callback-policy/SPEC.md) | Accepted | Behavior approved at `aca1fe5`, closure at `4056d79`, integrated into `aiagent/haurness-l`. Orchestrator worker-rule acceptance remains separate. |
| [Operator and consumer controls](operator-controls/0001-DESIGN/SPEC.md) | Accepted | Behavior approved at `95670a2`, closure at `8f2a139`, merged into `aiagent/haurness-l` at `da59a6c`. |
| [Long-running mock mode](long-running-mock/0001-DESIGN/SPEC.md) | Accepted | Behavior approved at `e13b405`, closure at `448521f`, integrated into `aiagent/haurness-l`. |
| [Channel messaging 0001 · External notices](channel-messaging/0001-DESIGN-external-notices/SPEC.md) | Generic Gate 2 accepted | Generic behavior approved at `f522072`, closure at `713a76a`. Worker delivery must prove recovery from a committed final ACP worker record and the uncertainty fallback. |
| [Web tools 0001 · Search and page fetching](web-tools/0001-DESIGN/SPEC.md) | Proposed for M2 | Define the rest of the initial tool set before starting implementation. |
| [Shell execution 0001 · Shell tool](shell-execution/0001-DESIGN/SPEC.md) | Proposed for M2 | Define the rest of the initial tool set first. Foreground execution precedes runner-managed background jobs. |
| [Timeline retrieval 0001 · Search and read](timeline-retrieval/0001-DESIGN/SPEC.md) | Gate 1 accepted | Runtime approved at `67072c5`, closure at `6be4a76`, integrated into `alpha` at `f0eb7d8`. |
| [Bounded context 0001 · Inference context](bounded-context/0001-DESIGN/SPEC.md) | Gate 1 drafted | Review [decision 0026](../decisions/0026-bounded-context.md) before bounded storage reads in Gate 2. |
| [Bounded context 0002 · Model-aware budget amendment](bounded-context/0002-AMENDMENT-model-budget/SPEC.md) | Implemented | Managed budget goes through acp-client. The offline Hub definition snapshot exercises sizing through the host catalog. [Decision 0037](../decisions/0037-managed-context-budget.md). |
| [Attachments 0001 · Files and image input](attachments/0001-DESIGN/SPEC.md) | Proposed for v1 | Parallel candidate while routines are in flight. Review the attachment contract first. [Plan](attachments/0001-DESIGN/PLAN.md). |
| [Tools and callbacks 0003 · Attachment tools](tools-and-callbacks/0003-DESIGN-attachment-tools/SPEC.md) | Proposed for v1 | `copy_attachment` and `share_attachment` build on the attachment store, tool lifecycle, and shell runner. |
| [Tools and callbacks 0004 · Reminder and routine tools](tools-and-callbacks/0004-DESIGN-reminder-tools/SPEC.md) | R-H1 assigned | Cod1a drafts the one-off wire contract from `723d438` and Clad1a reviews. Approval unlocks acp-client R8 wire work. [Plan](tools-and-callbacks/0004-DESIGN-reminder-tools/PLAN.md). |
| [MCP client 0001 · Server tools](mcp-client/0001-DESIGN/SPEC.md) | Proposed for v1 | Start with the SDK probe and contract, then stdio, HTTPS and launcher acceptance. [Plan](mcp-client/0001-DESIGN/PLAN.md). |

## Priorities

The [tool implementation plan](tools-and-callbacks/PLAN.md) tracks the order,
dependencies and acceptance gates for the initial tool set.

First, give acp-client a harness it can develop and test against offline:

The [M1 implementation sequence](todos/11-22-TODO-harness-m1-sequence.md) records
the serial handoff order, including the orchestrator-facing amendments.

1. Prove final-record recovery and the uncertainty fallback for [external notices](channel-messaging/0001-DESIGN-external-notices/PLAN.md) Gates 3/4.

The integration checkpoint is a real stdio run from acp-client with two
conversations on one session, a host tool callback, an approval, interruption
isolated to one channel, and recovery after restart. A short scripted test
can start before the long-running mock mode is complete.

The orchestrator needs the callback policy amendment and external notices.
External notices are the first channel-messaging slice.

After the checkpoint, build bounded context and image input, and test whether
the existing cross-channel notice path meets v1 needs. V1 offers no
cross-channel privacy guarantee. Shared identity for external conversations
is deferred.
The MCP client is planned for v1. Skills and broader standalone CLI work remain follow-ups.

[Node-level resource coordination](todos/11-21-TODO-node-resource-coordination.md)
is a deferred optimization after the usable-harness milestone and profiling.

New work is organized by concern. Use the next visible number in that concern
for a `DESIGN`, `AMENDMENT`, or small `MODIFICATIONS` item. Keep dates in
document headers and timestamps in log entries. Existing dated work folders
can move at a clean handoff.

[Deferred ideas](todos/) can stay there until they become numbered work items.
[Business rules](BUSINESS_RULES.md) track adjustable defaults and behavioral
tradeoffs alongside the specs that own them.
