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

## Step 1 review follow-up — bounded shutdown withdrawal

Commit `212e462` applies review `4240f02`. Before stopping the active native turn, conversation stop and Agent close give all submitted, unclaimed inputs a shared one-second withdrawal grace period. This prevents a confirmed inbox item from becoming a new unobserved turn when the active turn is interrupted. Shutdown joins a pending withdrawal, preserves the original submission identity and then rejects tracked handles with the exported `NativeInputStoppedError` and their message IDs. This replaces the legacy cancelled result for these handles. Inputs can still run and incur model charges if take wins, the host is down, or the deadline expires. Interrupt with `clearQueue` continues to track submitted inputs. The default submission store is memory even when the Agent uses SQLite. A file store retains pending withdrawal intent across close.

A take observed in a turn event, push receipt, reconcile view or withdraw response clears the withdrawing flag. The original submission stays tracked until its turn settles. The real-stdio stop and close tests prove the inbox item was still received and unclaimed at shutdown, then reconcile it as withdrawn and verify the model ledger stayed at one call. Tests also cover stop joining an existing request, close with a request pending, a stopped host, a silent request, take winning, and interrupt preserving an unclaimed input. No harness code, protocol or schema changed. `agent-session.ts` is 4,490 lines, `native/host.ts` is 909 and `native/controller.ts` is 599. The other tracked files retain their Step 1 sizes.

The clean RAM archive passed typecheck and **1,664 tests in 156 files in 118.37 s**. All nine new or strengthened test cases passed **20/20** in isolation. All 35 snapshots and the A1 hash were unchanged. Logs are in `/tmp/acp-o1-acp-r6-stop.sQ20I2`.

## Step 3 — native item receipts

Commit `76cd233` forwards the native controller's live receipt advances as the exported `ItemsReceipt` variant on `TurnEvent` and `AgentSessionEvent`. Receipts use the session turn ID and can include external notices. They can arrive while output for a known turn is held. The same monotonic lookup still backs `receiptOf`. The controller suppresses duplicate IDs and older milestones, and reconciliation does not synthesize history. Prompt settlement, `message_delivered`, and transcript records keep their existing paths.

The controller test covers held output, mixed duplicate and new IDs, Seen followed by Delivered, and reconnect without synthetic replay. The real stdio test asserts conversation routing and ordered milestones for the original and steered inputs with one turn completion. The changelog and consumer guide document the event. The repository's event consumers use discriminant filters or forwarding. There were no other exhaustive switches over these unions to update, and typecheck passed.

The clean RAM-backed full suite passed **1,666 tests in 157 files in 124.15 s**. Each new test passed **20/20** in isolation. All 35 snapshots and the A1 hash were unchanged. `agent-session.ts` is 4,491 lines, `native/controller.ts` is 599 and `native/host.ts` is 909. Logs are in `/tmp/acp-o1-acp-r6-receipts.ARkGy0`.

## Step 4 — consumer text over real stdio

Commit `ee78c68` adds real-child coverage for `harness.text: "stream"` and the default final subscription. The scripted model emits a partial answer and enters a held tool. The test holds the first real `message_completed` frame and preserves event order when it releases the frame. While the completion is held, stream mode has already delivered the text to both consumer chunk callbacks. Final mode has sent no provisional deltas. The test counts wire deltas without requiring a particular chunk split because the stdio writer may coalesce adjacent chunks.

After the tool is released, both modes finish with the same full result and provider message IDs. The stored transcript contains one final committed entry per logical reply. Activity snapshots can share the same logical ID and capture a completed revision before the authoritative final commit. Both tests check that these revisions introduce no extra reply. No runtime, harness protocol or configuration change was needed.

A disposable mutation that restored interrupt clearing for already-submitted input failed the strengthened Step 1 test. The harness still had the item in Received at interrupt time, and the mutated client incorrectly resolved its prompt as cancelled. Mutation log is in `/tmp/acp-r6-interrupt-mutation.q6cxkS.log`.

### Final gate

The clean RAM archive of `ee78c68` passed typecheck and the full `bun test ./test` suite with **1,668 tests in 158 files in 128.13 s**. Both new stream tests passed **20/20** in isolation. All 35 snapshots passed, and the A1 hash remained `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. Logs are in `/tmp/acp-o1-acp-r6-stream-final.7kzrWR`.

R6 covers confirmed withdrawal, the bounded shutdown path, native supervision through reopen, live receipts, and real stdio text through the public conversation. The protected files finish at or below the Step 1 baseline. `agent-session.ts` is 4,491 lines. `native/host.ts` and `native/controller.ts` are 909 and 599. The remaining line counts are unchanged from the initial table. No provider was called.

## Final review follow-up — taken inputs keep their turn result

Commit `ac33f2d` limits `NativeInputStoppedError` to submitted native inputs that remain unclaimed at shutdown. Local inputs that never reached submission keep ordinary cancellation. An input taken by the running turn stays attached to that turn and receives its normal cancelled result, including partial text. Held turns that never reach preparation keep a cancelled result without fabricated text. Take evidence can arrive through a turn event or the withdrawal response, including when the response wins the race with the event.

Stop and close deliberately withdraw before interrupting. This keeps an unclaimed input from being taken at the next turn boundary. A silent withdrawal can use the full one-second grace before the active turn is interrupted. If the host cannot confirm what happened, shutdown can reject the unclaimed handle while the harness still has work that may run.

The real-stdio standalone stop test and the mixed stop and close tests preserve the running prompt's partial text. Both mixed tests prove the unclaimed input was withdrawn, reject that handle with the typed error, and verify the harness ran only the original model call. The take-race test checks that both taken prompts receive the same cancelled operation and partial text. The pre-submission test keeps local cancellation and launches no harness. The controlled client verifies that a taken response carries the harness turn ID.

The same standalone fixture on `a9b3ae1` returned a cancelled result with empty caller text while persisting `Partial reply.`. On `2e1869f` it rejected with `NativeInputStoppedError` and persisted the same reply. The corrected code returns `Partial reply.` in the cancelled result. Comparison logs are in `/tmp/acp-r6-stop-compare.pt7DhI`.

The real-process scenario format requires concatenated chunks to equal the committed content, so that fixture cannot script a strict prefix of the eventual reply. Suffix completion remains covered by the native controller unit test.

The clean RAM archive of `ac33f2d` passed typecheck and **1,670 tests in 159 files in 118.70 s**. All six new or strengthened cases passed **20/20** in isolation. All 35 snapshots and the A1 hash were unchanged. The protected line counts remain 4,491 for `agent-session.ts`, 909 for `native/host.ts` and 599 for `native/controller.ts`. Logs are in `/tmp/acp-o1-acp-r6-taken-stop-final.UfYsnE`.

## Short review follow-up — a completion in flight

Commit `92a02d2` documents the caller-visible change from `a9b3ae1`. When a stopped turn had a completed reply, the caller now receives that reply as partial text with a cancelled metering record. The old result returned empty text and no metering record. Stopping during the first streamed message still returns a cancelled result with empty text until the completion is available to the client.

The native controller reuses its normal cancellation result for a graceful stop even if its terminal notification is still in flight. The fallback uses only completed messages already applied and fences out a late by-reference read. It does not mark an unseen provider terminal notification as observed. The real stdio test holds the completion frame and subsequent events, waits for provisional text, then stops while the frame is held. The same fixture passed on `a9b3ae1` and failed on `ac09144` with “the conversation stopped.” Those comparison logs are in `/tmp/acp-r6-stop-frame-compare.bZRzRl`.

The take-race test withholds the actual `turn_took` notification. The real withdrawal response is then the only take evidence during the shutdown grace. The prompt follows the active turn and receives its cancelled result with partial text. In a disposable archive, removing the `noteTaken` callback caused that test to fail with `NativeInputStoppedError`. The mutation log is in `/tmp/acp-r6-note-taken.ClDf9s.log`. The completed-reply test now asserts the returned message and cancelled metering outcome. The native controller remains at 599 lines, with the other protected counts unchanged.

The clean RAM archive passed typecheck and **1,671 tests in 159 files in 118.20 s**. All three new or strengthened tests passed **20/20** in isolation. All 35 snapshots passed and the A1 hash stayed `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. Gate logs are in `/tmp/acp-o1-acp-r6-stop-completion.v39S8b`.
