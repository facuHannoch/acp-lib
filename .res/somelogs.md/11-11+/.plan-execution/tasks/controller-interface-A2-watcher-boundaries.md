# A2: watcher boundary fixes

Read independent review `controller-interface-reviews:library/reports/11-12-REVIEW-A2.md` at `a54cad2`, watcher-fixes review, against `120210f`. Agentclad-1: fix both P2 test-evidence gaps:

1. Detached final-message assertion must identify the current turn's transcript segment/boundary, not reuse the preceding turn's identical assistant text. Add meaningful negative repeated-text and correct two-turn positive cases while retaining strict content/order.
2. Do not classify a generic pre-dispatch error as before metering open from error text alone. Observe or explicitly represent the actual metering-open boundary and distinguish opened-but-not-dispatched from before-open. Add positive and negative cases on each side, including a managed beginOperation failure after open. Determine actual behavior; if the required record outcome is not specified, report and escalate rather than invent a new guarantee or alter production behavior.

Retain one dedicated snapshot exception commit, separate cause-only commit, safe consolidation with old head preserved, no broadened snapshot rule; update report and shared log, typecheck, meaningful focused tests and full suite. Assess impact of watcher instrumentation on prior A1/A2 comparison and report honestly. Notify bob-b by committed report pointer. B1 held pending review and independent gate.
