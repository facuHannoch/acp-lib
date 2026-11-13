# A2: address follow-up review

Read independent follow-up review `controller-interface-reviews:library/reports/11-12-REVIEW-A2.md` at `8b4baf6` in full. Agentclad-1: fix these findings on `controller-interface` and add appropriate meaningful offline regressions:

1. A rejected `send` after synchronous `turn_started` currently only logs and can settle as a completed turn. Preserve original ACP readiness timing while ensuring dispatch and settlement honor acceptance rejection, abandon/cleanup and never emit false completion. Do not reinstate the pre-readiness yield.
2. The accepted-ID set does not prove run ownership/order: a known queued message can be included in two runs. Validate actual messages selected and ordering/exclusivity; cover known-but-still-queued injection through dispatch and preserve existing tests.
3. Ensure the bounded finalization-gate test releases its gate and observes queued promises even if assertions fail; regressions should fail cleanly, without unhandled rejection or cleanup timeout.

Update `library/reports/11-12-REPORT-A2.md` with commits, gates, test counts/times, limitations and unanswered questions; exact-path commits and common step log required. Keep snapshots unchanged. Escalate spec conflicts or scope exceptions. Ask bob-b for follow-up review when ready. B1 held.

Reviewer saw an additional full-suite intermittent Agent-owned internal-command snapshot order mismatch (assistant record versus metering, 1,141/1 red followed by 1,142/0 green). Targeted A1 and follow-up probes were 30/30 each. It is unclear if related to the managed race and whether it predates A2; do not assume a cause or mask it. Owner decision pending; independent bug fixes can proceed.
