# O2 busy worker dispatch and policy

Implemented on `orchestrator` using the revised busy-send contract from `orchestrator-status`. O1 follow-up `9fa7745` restored the manager's three rationale comments, extracted its persistence-context mapper, and documented the expanded `AgentEvent` union and direct-open slot limitation. Its clean gate passed 1,521 tests across 140 files in 113.24 s, with typecheck and all 35 snapshots green.

## Step 1. Busy sends

Commit `8c76be9` reuses ACP's existing `delivery: "steer"` and `beforeDispatch(messageId)` seams. The pool plans start, continue, or replace for the current worker. A continuation carries the previous assignment ID and the chosen destination. A replacement carries both assignment identities and preserves the original destination on the previous assignment. A pending successor keeps the worker busy after its predecessor settles. Stop waits for all tracked prompt completions.

| Case | Offline coverage |
| --- | --- |
| Idle worker | Ordinary queued prompt starts a new assignment plan. |
| Busy worker, same giver | Steer reaches the provider after an actual tool boundary and continues the assignment ID. |
| Busy worker, different giver, no redirect | Returns `busy` with worker status, including when the caller requests a new assignment. The fake observes no additional dispatch. |
| Busy redirect | A takeover steers with the same assignment ID and a new destination, updates `lastConversation`, and emits a redirect event. |
| Busy send with `assignment: "new"` | Steers the old turn and prepares the new invocation ID. The fake receives the preserved prior destination and the new plan. |
| Busy redirect with a new assignment | Both assignment IDs and their respective destinations are distinct. The old turn is stopped at the same ACP tool boundary. |
| Send to a deleted, evicted worker | Refused before making room. Existing idle workers stay live. |

The send tool description says to set `assignment` to `"new"` to interrupt the running assignment and start separate tracking. It is ready for O6's per-open tool catalog.

## Step 2. Policy

Commit `d72a8e2` checks `use` and `scope` on open and send. Check/list apply scope before looking up a worker. A busy redirect, stopping another giver's running work, and drop require redirect authority. A giver can stop its own running work even when it lacks redirect authority. `maxOpen` counts non-dropped workers originally opened by the acting conversation, including offline workers, and runs before slot eviction. Denials return a typed `WorkerPolicyError` carrying the rule. Tests exercise each refusal, allow the giver to stop its work, and allow another actor with redirect permission to drop it and free the opener's quota. The consumer API supplies the existing unrestricted consumer actor.

## Boundaries

The assignment port is optional and only used by fakes in O2. The real ACP worker queue runs the steering path; the fake observes the intended assignment operation after the existing durable prompt boundary and before provider dispatch. O2 writes existing worker-row metadata and emits worker facts. Durable continuation, close, reservation, destination retargeting and notices belong to O3a and later Gate 3 work. No production worker-delivery calls or draft schema-20 contracts were added.

`agent-session.ts` remains unchanged at 4,564 lines. The manager is 1,076 lines after the rationale extraction, and the largest orchestrator module is 209 lines. No live providers were used.

## Clean gates

| Commit | Full suite | Logs |
| --- | --- | --- |
| `9fa7745` | 1,521 tests in 140 files, 113.24 s | `/tmp/acp-o1-o1-followup.NOWXby` |
| `8c76be9` | 1,526 tests in 141 files, 113.08 s | `/tmp/acp-o1-o2-step1.YIcKVD` |
| `d72a8e2` | 1,527 tests in 141 files, 133.82 s | `/tmp/acp-o1-o2-step2.3ikL8M` |

Typecheck passed for every archive. All 35 snapshots passed and the A1 snapshot hash matched the baseline.
