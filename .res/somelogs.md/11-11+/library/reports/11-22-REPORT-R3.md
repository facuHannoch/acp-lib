# R3 conversation permission events

[Grounding report](11-22-REPORT-R3-grounding.md) at `757e062`. Implementation follows the decisions after grounding. Consumer waits use acp-client's five-minute default, while handlers retain their existing lifetime. An unattended ask always uses the deny selection. The native clock begins at first host receipt, survives replay of its request ID, and adds no wire field.

| Step | Commit | Evidence |
| --- | --- | --- |
| 1. Conversation events | `c0fcf62` | Focused ACP, native checkpoint and A1 run passed 82 tests and 35 snapshots. The extraction rerun passed all 11 selected event cases. |
| 2. Consumer answer API | `fef2020` | Typecheck and 21 focused cases passed. Both ACP and native fixtures exercised event answers, timeout and duplicate or late answers. |
| R3 gate follow-up | `8776401` | The native controller stand-in now uses the shared approval ticket and tests a harness timeout close. All 20 controller tests passed. |
| R3 deadline follow-up | `ce5e3d5` | ACP receives an expired refusal while the requested-record write is held, and both records are subsequently written in order. All 12 ACP event tests passed. |
| 3. Changelog and spec | This commit | Documents the public event shapes, answer method, consumer options, clock and lifetime decisions, and provenance. |

## Event and decision cases

- ACP matched-policy and handler decisions emit one pair each with the turn ID and independent permission IDs. An invalid JavaScript `permissionRule` result refuses and closes the event. ACP natural provider return, force stop and conversation stop close a held decision as `turn_ended` even if its handler returns later.
- Native real stdio tests cover the host responder, an external harness denial, conversation force stop, stop and a lost connection. Reattachment observes the same open request twice and delivers one public pair. Host responder authority remains with the host, including while detached.
- ACP and native consumer timeout refuse via their existing response protocols. An expired ingress timestamp is honored on late delivery. The handler shortcut exposes no deadline and rejects method answers. An explicit false overrides Agent conversation defaults. The native stdio consumer-allow test verifies one tool effect and one `approval/respond` RPC even when the turn ends before the host receives its acknowledgement.
- Native approval gate semantics remain in the harness. The client reports a confirmed answer once and uses the existing close reason or turn lifecycle when the request ends otherwise. Observe/reconnect reuses the active native ticket by request ID. Agent-owned permission record formats and raw ACP responses stay compatible.

## Reuse and size

The changes reuse the R2 matcher and neutral request, existing permission records, conversation notification envelope, subscription hub, native wire responses and operation supervision. New permission state tracks open entries separately from native transport tickets, since native requests can be held or answered by the host before the conversation runs the turn.

| File | Before R3 | After R3 |
| --- | ---: | ---: |
| `src/agent-session.ts` | 4,565 | 4,564 |
| `src/client.ts` | 1,062 | 1,062 |
| `src/controller.ts` | 840 | 840 |
| `src/agent/conversation-manager.ts` | 1,085 | 1,085 |
| `src/native/host.ts` | 884 | 877 |
| `src/native/controller.ts` | 601 | 584 |

The focused stdio run initially stalled in restricted execution at the ACP connection handshake. The offline fixture processes completed with the required execution approval. No live providers were used.

## Full gates

The first clean gate on `fef2020` found three stand-in failures. On `8776401`, clean typecheck and all 1,506 tests across 137 files passed in 116.57 s. All 35 snapshots passed. [Stand-in finding](../../../../../.agents/.artifacts/common/errors/11-22-r3-native-controller-approval-ticket.md)

The deadline follow-up makes the timed-out refusal independent of completion of the requested record. [Deadline finding](../../../../../.agents/.artifacts/common/errors/11-22-r3-permission-deadline-behind-record-write.md)

The final clean archive of `ce5e3d5` passed typecheck and all **1,507 tests across 137 files** in 94.65 s. All 35 A1 snapshots passed. The snapshot hash matched the R2 grounding hash before and after the run. Logs are at `/tmp/acp-r3-gate.zqpeZM/typecheck.log` and `/tmp/acp-r3-gate.zqpeZM/full.log`.
