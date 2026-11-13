# A2: contractual watcher follow-up fixes

Read reviewer `controller-interface-reviews:library/reports/11-12-REVIEW-A2.md` at `54ced2e`, final-fixes section, against implementation `26c7868`. Agentclad-1: address all three P2 watcher findings with meaningful synthetic failure-path checks, without loosening snapshots:

1. Require exactly one metering event/record after provider outcome for applicable provider-dispatched failed turns. Distinguish pre-dispatch preflight rejection and explicitly identified metering-write failure cases; escalate genuine contract ambiguity instead of silently skipping.
2. Assert the expected actual last assistant message for each completed turn, in each persistence mode; include a multi-message negative case where only an earlier message exists.
3. Observe a synchronous controller prompt throw as its outcome, rethrow the same error, and test it along with rejected-promise and forced paths; preserve production timing and no new scheduling points.

Preserve the single dedicated exception commit requirement while safely consolidating any test changes (document replacement commits and preserve prior head if rewriting). Cause-only commit remains separate. Update A2 report accurately with tests/limits and any affected study instrumentation; assess whether comparative measurements still represent the final tests, and escalate material gaps. Run typecheck, full suite, focused tests and snapshot checks; log work/testing/limits. Notify bob-b with committed report pointer for independent follow-up. Follow all prior A2 scope, owner decisions, exact-path commit and offline-only rules. B1 held.
