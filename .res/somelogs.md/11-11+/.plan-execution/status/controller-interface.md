# Controller interface implementation status

Spec: `library/11-11-SPEC-controller-interface.md` on beta `5e01135` (updated since A1). Coordinator/gatekeeper: bob-b; implementer: agentclad-1; reviewer: agentco-1. Branches: `controller-interface`, `controller-interface-reviews`, `controller-interface-status`. No push or merge to beta before final review and user release.

| Brief | State | Evidence / next action |
| --- | --- | --- |
| A1 | Gate passed | `9de0ca3`; review `547b522`; `11-12-GATE-A1.md` records cl-c's independent gate. |
| A2 | Usage-shape follow-up review and checkpoint triage | Fix `6e46e40`, report `6619cfa`; independent review assigned. Three comparison runs failed checkpoint timestamp validation: `11-15-ISSUE-A2-checkpoint-timestamps.md` awaits owner triage. Coordinator gate pending. |
| B1 | Not started | Await A2 gate. |
| B2 | Not started | Await B1 gate; after B2 gate tell user ready for spec owner's final review. |

Latest spec adds optional backend-scheduled `TurnRun.turnId`, `turn_took`, asynchronous `send` acceptance and backend-scheduled queue release at acceptance. An ACP run still reports `turn_started` synchronously inside `send`. Preserve the existing `AgentController` error strings and A1 snapshots (A2 permits the isolated cause addition and a separate dedicated narrowly scoped ordering exception).

Turn event exclusivity was corrected on beta `fcd1fd4` and incorporated by both branches. After A1 decisions, A1's startup/force/capability adaptations and narrowed record-order characterization are accepted in the gate file. Escalate scope exceptions, behaviour changes, token-spending or live harness runs to the user; spec problems to the spec owner through the user. Each contributor records completed steps, testing and limits in the shared artifacts log.
