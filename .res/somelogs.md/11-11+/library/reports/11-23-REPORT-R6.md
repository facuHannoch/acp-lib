# R6 implementation — native withdrawal

## Step 1 and the reopen regression

The R5 wording corrections are in `e7d90e6`. The amended brief and confirmed wire rules are in `069efba` and `b13417c`. Commit `5602999` extracts queue settlement from AgentSession without changing behavior. Runtime and tests are in `592a2c1`.

The native handle's synchronous withdrawal is limited to local input. The additive `withdrawAsync` methods on the conversation and prompt handle use the host for submitted input. A request is registered before submission crosses the host boundary, and a local cancellation fences off a delayed dispatch hook. Once a push is issued, the host persists the withdrawal intent before requesting it. `not_found` is unresolved. Push and withdraw have no ordering guarantee, and the harness has no tombstones for unknown IDs. The host uses acceptance evidence or a bounded reconciliation read and retry under the original channel and item ID. A positive withdrawal response, withdrawal event or reconciled withdrawal can settle the prompt once. If take wins, the input stays with its turn. A still-unacknowledged push can reject with uncertainty after reconciliation is exhausted. A later reconcile can still check its saved intent.

The built-in memory store carries the withdrawing flag across harness reconnects. A file-backed store also carries it across a new Agent. The default submission store for a SQLite-backed Agent is still memory. Custom host records need `markWithdrawing` for withdrawal of submitted input. Pending withdrawal suppresses push replay. No harness wire or SQLite schema changes were needed.

Native interrupt with `clearQueue` clears local input and leaves submitted prompts following the harness. Stop and Agent close reject the outstanding handles they stop observing and leave accepted items with the harness. The tests reconcile those exact IDs after stop and after reopening a closed Agent. A controlled client checks lookup before commit, late acceptance, finite retry, a file-backed host reopen and suppression of replay. The stdio tests cover confirmed withdrawal, a take winning an in-flight withdrawal, dispatch fencing and the lifecycle decisions. The native supervision regression holds a replacement launch beyond the configured client stall limits, then checks one reconciled settlement. The existing host test covers reopen exhaustion.

| File | Before | After |
| --- | ---: | ---: |
| `src/agent-session.ts` | 4,492 | 4,489 |
| `src/native/host.ts` | 909 | 908 |
| `src/native/controller.ts` | 599 | 599 |
| `src/client.ts` | 1,046 | 1,046 |
| `src/controller.ts` | 764 | 764 |
| `src/agent/conversation-manager.ts` | 1,012 | 1,012 |
| `src/agent.ts` | 563 | 563 |
| `src/metering/engine.ts` | 1,034 | 1,034 |

The host reuses the existing submission store, bounded harness client, and recovery view. Its open-or-create and message-read code moved to the recovery module. Queue settlement reuses the existing cancellation result. The new submission withdrawal module owns the intent and request retry logic. No live provider was used.

### Gate

On a clean RAM-backed archive of `592a2c1`, typecheck and the full `bun test ./test` passed. The suite ran **1,659 tests in 156 files in 113.78 s**. Each of the ten new tests passed **20/20** in isolated processes, for 200 passing invocations. All 35 snapshots passed. The A1 hash remained `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. Gate logs are in `/tmp/acp-o1-acp-r6-withdraw.hIx7mI`.
