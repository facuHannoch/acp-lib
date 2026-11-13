# Controller interface implementation status

Spec: `library/11-11-SPEC-controller-interface.md` on beta `1bda9ef` (updated since A1). Coordinator/gatekeeper: bob-b; implementer: agentclad-1; reviewer: agentco-1. Branches: `controller-interface`, `controller-interface-reviews`, `controller-interface-status`. No push or merge to beta before final review and user release.

| Brief | State | Evidence / next action |
| --- | --- | --- |
| A1 | Gate passed | `9de0ca3`; review `547b522`; `11-12-GATE-A1.md` records cl-c's independent gate. |
| A2 | Watcher boundary follow-up review | Consolidated exception `8ac866e`, report `c33f5b6`; independent review assigned. Metering failure/open questions 4–5 remain escalated in `11-13-ISSUE-A2-metering-write-failure.md`; gate pending. |
| B1 | Not started | Await A2 gate. |
| B2 | Not started | Await B1 gate; after B2 gate tell user ready for spec owner's final review. |

Latest spec adds optional backend-scheduled `TurnRun.turnId`, `turn_took`, asynchronous `send` acceptance and backend-scheduled queue release at acceptance. An ACP run still reports `turn_started` synchronously inside `send`. Preserve the existing `AgentController` error strings and A1 snapshots (only A2's isolated cause addition is allowed).

Turn event exclusivity was corrected on beta `fcd1fd4` and incorporated by both branches. The correction contains a non-contractual typo, `subscgentribe`. After A1 decisions, A1's startup/force/capability adaptations and narrowed record-order characterization are accepted in the gate file. Escalate scope exceptions, behaviour changes, token-spending or live harness runs to the user; spec problems to the spec owner through the user. Each contributor records completed steps, testing and limits in the shared artifacts log.
