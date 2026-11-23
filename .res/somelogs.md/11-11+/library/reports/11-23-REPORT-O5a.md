# O5a stop, drop and idle shutdown

Implemented on `orchestrator` following the updated O5a brief. The brief uses the existing conversation interrupt, stop, provider cleanup and reload paths. Assignment delivery was outside this brief. Explicit stop may later yield an interrupted notice.

## O4 follow-up

`71b63d8` gives consumer-opened work the configured `orchestrator.defaults.workerPermissions`. An unattended ask is refused, and the existing matcher and option selector handle automatic levels. The offline ACP fixture verifies configured allow and an unattended ask. The changelog also covers the optional forwarded `permission_requested.turnId`, the worker `source`, and the public `WorkerPermissionSource` type.

A clean archive passed typecheck and **1,540 tests across 143 files** in 112.58 s. Logs are in `/tmp/acp-o1-o4-followup.quQB9Y`.

## Step 1. Stop, drop and directly deleted workers

`a6ec0af` preserves stop's `interrupt({ clearQueue: true })` and the giver or redirect-authority rule. It waits for the tracked prompt completions. Drop requires redirect authority for a conversation actor and uses the existing manager's `delete(id, { providerSession: "best-effort" })`. It marks the worker row dropped and reports the manager's cleanup outcome. `agent.workers.delete` returns that result. `providerDeleted: true` confirms a provider deletion, `"unsupported"` means the adapter could not delete the provider session, and `false` includes an unavailable recorded session or a cleanup failure. The worker and conversation still become unavailable locally after successful local deletion.

Check, list and send reconcile deleted or missing conversations into a durable dropped worker row. Reconciliation removes any cached slot and emits one dropped fact. A send fails before eviction. New opens also reconcile before quota calculation.

The offline tests exercise same-giver stop, refusal for another giver, active stop through the consumer API, supported provider deletion with the provider fixture's saved thread removed, and unsupported provider deletion with local tombstones preserved. Check covers a real direct delete, list covers a missing summary, and send covers deletion of an evicted worker while two other workers remain live.

## Step 2. Idle shutdown

`731f939` arms a timer after the pool's last tracked prompt settles and the conversation is idle. The default is 600,000 ms. `false` disables it. A new send, eviction, drop or Agent shutdown cancels the timer. A queued callback rechecks the slot and its timer identity before stopping the provider. Idle stops and slot acquisition share the pool's serialized queue. The stopped event has reason `idle`, and the handle and durable conversation remain available for reload.

The offline integration test holds a tool until release, then waits for the idle stop event, verifies the provider is disconnected, and verifies the next send reloads the same provider session in a new conversation object. A timer test covers disabled mode, cancellation on a new send and shutdown.

The change does not edit `agent-session.ts`, native code, or the worker-delivery repository. No provider run used credentials. All waits in test cases follow events or the fixture's barriers.

## Clean gates

| Commit | Full offline suite | Logs |
| --- | --- | --- |
| `a6ec0af` | 1,544 tests across 143 files in 136.25 s | `/tmp/acp-o1-o5a-step1.2lXxRp` |
| `731f939` | 1,546 tests across 143 files in 107.40 s | `/tmp/acp-o1-o5a-step2.b2k5RT` |

Typecheck and all 35 snapshots passed on every clean archive. The A1 snapshot hash matched the baseline.
