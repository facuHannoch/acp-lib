# O6 step 3 live smoke

**Outcome.** The authorized single run verified live delegation and delivery to the original giving conversation. The forwarded-permission and redirect gate remains open. The worker finished before a forwarded permission reached the runner. Its result went to Alice, so I stopped the run with SIGTERM. Bob's prompt was never sent. There was no retry.

## Configuration and counts

Ran the hardened runner at `f73fde1` on `orchestrator` with the approved disposable Codex home. The native model was `deepseek/deepseek-v4.1-flash` through OpenRouter. The worker was configured for `gpt-6.1-terra` through the installed Codex ACP bridge. The runner used an eight-minute supervising limit and ran for 82 seconds. It recorded three OpenRouter requests and one ACP worker submission. The Codex CLI did not report a count of its internal model calls. The runner issued one native prompt. Alice's subsequent notice triggered a native turn.

## Model evidence

- Alice said `queued` after delegation.
- The Codex worker said `I’ll run the command exactly as provided.` and returned `orch live ok`.
- Alice said `Worker w1 reported: orch live ok.` on the notice-driven turn.
- Bob had no live turn. The runner did not reach the file-content check or the checks on who could answer an open permission.

The run-owned database showed a single worker assignment with a staged result marked `delivered` to its original destination. I checked that state while the runner was still waiting for the permission and then stopped it. The run ended before the runner’s final timeline-count assertion. It established delivery of the recorded result, with the permission and redirect assertions unverified.

## Cleanup

The consumer drop returned `providerDeleted: true` for `w1`. The runner verified the worker tombstone and empty worker list, and both native conversations were marked deleted. The runner and its supervisor each verified removal of their temporary work trees. The supplied Codex home was left to the user. I did not read, copy, print or remove its contents, and no OpenRouter credential was printed or saved.
