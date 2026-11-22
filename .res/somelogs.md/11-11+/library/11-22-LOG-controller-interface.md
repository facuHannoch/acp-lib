# Log: controller interface, verification pass

Spec: `11-11-SPEC-controller-interface.md`. The code is already implemented and merged (`9668cf7`, base `004cc7f`).
This pass takes it through the pipeline brief by brief (A1, A2, B1, B2): check the code against each brief, test
it, review it, and fix what the triage rule allows (`../.plan-execution/plan.md`). Written only by the
coordinator; reports and reviews are linked, not copied.

| Role | Agent | Branch |
| --- | --- | --- |
| Coordinator and gatekeeper | core-p | `controller-interface-verify-status` |
| Implementer | cod2a | `controller-interface-verify` |
| Independent reviewer | clad2a | `controller-interface-verify-reviews` |

All three branches start from alpha at `d11cd18`. The user merges into alpha after the final check. Fixes go back
into alpha before integration brief R1 starts (decided by the user, 2026-11-22).

## Entries

### 2026-11-22: setup

- Branches created at `d11cd18`; roles confirmed by the user.
- A1 assigned to cod2a (verification of the characterization tests).
- A1 report in from cod2a, `f020860` (report only; [report](reports/11-22-REPORT-A1-verify.md)): clean baseline at
  `d11cd18`, typecheck clean, 1,727 tests in 175 files (352 s); characterization file 35/35 three times, snapshot
  hash unchanged. Every case exercised; six marked "different" (other fixture or observation point). No fixes.
  Open: fixture names in the spec, the observation points for reattach and capabilities, explicit force stop, and
  a fixed 50 ms wait in the bridge test. Error notes: ID numbering order, the fixed PTY wait, sandboxed fixture
  connections.
- A1 sent to clad2a for review.
