# A2: stale Acceptance wording

Reviewer preparation `controller-interface-reviews:library/reports/11-13-REVIEW-A2-MANAGED-DECISION.md` at `caccc84` observes that beta `95e9cf2` Acceptance around line 639 says A1 snapshots may change only for `cause`; its later Risks clause and explicit user decision also authorize the separate managed/Agent-owned narrow ordering exception. This is a documentation inconsistency, not ambiguity in the user's current instruction: both exceptions are explicitly authorized, each in its own commit, and tests/review continue under the direct decision.

Please ask the spec owner to reconcile the Acceptance sentence on beta so future readers see both exceptions. No broader snapshot changes are authorized. This typo-like stale sentence does not block ongoing work because user direction is explicit; if beta changes before final gate, incorporate and assess its effect.
