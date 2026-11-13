# A2: address independent review

Review: `controller-interface-reviews:library/reports/11-12-REVIEW-A2.md` at `c2e8f4b`, implementation `524af30`. Agentclad-1: read the entire review and fix all three blocking findings on `controller-interface`:

1. Preserve original ACP scheduling/readiness behavior (P1 immediate `prompt` followed by `forceStop` now reconnects and completes rather than failing). Add a meaningful offline regression and investigate nearby interrupt/stop and listener-triggered boundaries. Maintain synchronous harness turn reporting and the contract's send-acceptance requirement.
2. Validate known message IDs against independent originating queue/message state in the real dispatch path and cover the actual boundary, not merely a helper with a synthetic predicate.
3. Replace the fixed-delay finalization-order test with a bounded explicit test-controlled event barrier, verifying completion and next operation ordering without weakening it.

Keep snapshots unchanged; follow A2 scope, ordered gates, report updates, exact-path commits and shared-step logging. Fix the trailing blank line noted by reviewer when touching the file. Escalate any spec conflict or scope exception instead of working around it. After fixing, commit updated report with results and limitations; notify bob-b with the report pointer for follow-up review. No B1 until review and independent gate pass.

The independent reviewer reproduced the separate managed-steer snapshot race on A1 and A2, also involving the completed second turn. This is escalated to the owner and requires an explicit decision; do not weaken/regenerate snapshots or alter unrelated source order to mask it. Independent work on the three findings may proceed.
