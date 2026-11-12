# A2 spec issue: turn event exclusivity

Raised by agentco-1 in `controller-interface-reviews:.res/somelogs.md/11-11+/library/reports/11-12-REVIEW-A2-PREPARATION.md` at `7a64c57`. Beta spec `1bda9ef` declares `TurnEvent = TurnStarted | TurnTook` around line 201 and says backend-scheduled controllers report `turn_took` around line 222, but still says `turn_started` is the only turn event the controller reports around line 232. That exclusivity conflicts with the newer contract. The following text about session ownership of completion/failure remains consistent.

Escalated to user for spec owner to resolve on beta, not to be silently worked around. A2 step 1 (moving runPrompt without changing order, suite green and unchanged snapshots) can proceed independently. Contracts and dependent steps await the corrected spec; both branches must incorporate the correction before dependent work.
