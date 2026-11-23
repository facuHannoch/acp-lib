# R6 grounding — native withdrawal, reopen, receipts and streaming

Grounded against alpha `b77c3d7` and its merge into `integration-r456` at `9a0e0fd`. R5 adds metering at native turn close but does not change these four paths. This is the step 0 proposal for review.

## What is built

| R6 item | Current code and coverage | Remaining work |
| --- | --- | --- |
| Withdraw once a push has been sent | `AgentSession.withdraw(id)` removes a local queue item only. `PromptHandle.withdraw()` also uses `withdrawWaiting`, which removes an accepted, unclaimed `BackendTurns` item without telling its backend. It refuses an in-flight send. The native host already calls `channel/withdraw` from `withdraw(channel, item)`. Harness storage arbitrates the race with taking the input and makes a successful withdrawal idempotent. The controller handles the withdrawal event and reconciled withdrawal by clearing the host submission only. | Wire native prompt withdrawal to the host and converge the response, event and reconciliation paths on one consumer settlement. Preserve a synchronous local path and agree the async API. |
| Stall clock during reopen | Native advertises `supervision: "backend"`. `stallLimitsFor` disables first-output, next-output and tool deadlines before the supervisor starts, even if the consumer configured them. Disconnect reports attachment state. The host reopens for outstanding work under its existing budget, then the controller reconciles the turns and inputs. `test/native/checkpoint.test.ts` exercises real-child recovery, and `test/native/host.test.ts` exercises exhaustion. | The logged client stall gap no longer applies. Add a regression that holds reopening behind a barrier and uses short configured client limits. Document that native has no client stall clock to pause or restart. |
| Forward `items_receipt` | The harness emits ordered, committed Delivered/Seen advances. `NativeController.#accept` updates the monotonic `receiptOf` lookup. Prepared-turn output does not forward receipts, and `TurnEvent` and `AgentSessionEvent` have no receipt variant. The controller test checks the lookup. | Publish an explicit conversation event using the same milestone bookkeeping. Keep `message_delivered` and prompt ownership separate from the receipt. |
| Real-process `stream` text | `NativeHarnessHost` subscribes with `harness.text`, defaulting to `final`. `NativeController` sends provisional deltas to `onChunk` and uses `message_completed` or its reference for authoritative text. Unit tests cover this controller path. `test/native/rehearsal.test.ts` already asks a real stdio child for `stream` and counts its text deltas. It uses the host directly. | Verify live chunks, final text and the persisted reply through a consumer `AgentSession` over the same real transport. No new protocol or per-conversation streaming setting is needed. |

The older log's withdrawal and receipt findings still match the consumer path. Its stall finding and blanket statement about real-child tests using `final` need the qualifications above. The old recovery description names `session/load`. The host now uses `session/open` for existing sessions, `session/create` on first creation, and channel observation and reconciliation for recovery. R1–R5 already address the log's durable channel intents, conversation permissions, cancellable ACP startup and best-effort native turn metering. [R6 outline and native design](../11-11-SPEC-native-harness-integration.md) · [Original integration log](../../../../../src/native-harness/.res/docs/acp-client-integration/0001-DESIGN/11-20-LOG.md#L219)

## Proposed brief

### Step 1 — Withdraw a native prompt

Keep `conversation.withdraw(id)` and `handle.withdraw()` synchronous for local cancellation. Recommend additive `conversation.withdrawAsync(id)` and `handle.withdrawAsync()` for a native input beyond the local queue. Both entry points share one implementation. The async answer is true on confirmed withdrawal, false if the turn took the input or there is no outstanding message, and rejects with the existing request error when the outcome is unknown. Keep a pending prompt eligible for its real outcome after a request failure. Overlapping calls for the same ID can share an answer. Once the settled prompt is gone, a later call returns false. Review the API name and repeated-call result before implementation.

Identify the send boundary in the host, which records `saved` before start and `unknown` via `markSent` before calling `client.push`. The session's `sending` state alone cannot tell whether bytes left. Cancel locally before the write, including while the dispatch hook or launch is held. Fence the continuation so it cannot push a locally cancelled item. Once the push is issued, use the ordered live connection even if the push response is pending. Avoid queuing withdrawal behind the entire acceptance RPC. A late push response must not undo a confirmed withdrawal. On loss, use the existing bounded request response and the authoritative reconciliation view. A pending withdrawal must not cause a cancelled or confirmed-withdrawn submission to be replayed. If neither the response nor the view proves withdrawal, leave the prompt eligible for its real outcome. Use the existing cancellation result, with one `message_withdrawn` for an explicitly withdrawn prompt. Audit the separate `interrupt({ clearQueue })` path, which also drops accepted-unclaimed entries today. Keep its interrupt and queue semantics outside this change unless the shared settlement path requires an adjustment.

Gate with an offline real harness for an accepted steer waiting in the inbox and for a take winning the race. A held running tool provides an admission boundary. Use protocol barriers for a push written but its acknowledgment held, a withdrawal committed but its response lost, and a late push response. Verify no run for a cancelled input, the original turn settling a taken input, one prompt settlement and withdrawal event, and no orphan waiter or retry. Cover pre-write cancellation at the local queue and during dispatch/start, plus timeout and reconnect without false confirmation. Preserve the ACP and generic controller contract, including the tests of synchronous local withdrawal.

### Step 2 — Verify native supervision across reopen

Keep the backend-supervision guard. Exercise the normal session supervisor with tiny configured first-output, next-output and tool limits and a tracked native turn. Hold the replacement connection at an explicit launch or reconcile barrier after the first connection dies. Confirm the turn remains pending past the client limits. Release the barrier and check that reconciliation settles it exactly once from harness evidence. Exercise the bounded exhaustion path and check that it fails with `HarnessUnavailableError` and `reopen_failed`. Existing ACP tests remain the gate for client-side stall detection. The elapsed-time assertion is part of the behaviour under test. Use events for launch, loss and reconciliation synchronisation and keep all deadlines bounded.

### Step 3 — Expose item milestones to conversation subscribers

Extend the existing controller event path and emit an additive `items_receipt { turnId, itemIds, milestone }` on the conversation subscription. Use the session turn ID form used by `turn_started` and `turn_completed`. The IDs are harness item IDs and may include external notices. Advance each item only once per milestone using the controller's existing lookup, so repeats cannot cause a second event or regress Seen to Delivered. Forward while the controller knows the turn, including held turns before preparation. Keep membership and settlement on `turn_started` and `turn_took`. Keep `receiptOf` for lookups and keep `message_delivered` semantics and serialization intact. The receipt is a live event. Reconciliation and item-status reads remain the sources for history. The proposal adds no synthetic transcript record or Agent-wide record event.

Gate with controller tests for repeat, mixed new and known IDs, and out-of-order milestones, and through a real harness with a queued or steered input taken into a turn. Assert conversation routing, turn and item IDs, milestone order, one completed result and consistent `receiptOf`. Test a held turn and reconnect without promising replay of a receipt absent from the live subscription.

### Step 4 — Verify the consumer text path over stdio

Extend `nativeRig` coverage using the existing scripted step schema and `harness.text: "stream"`. Use a stream with a controllable boundary after a partial reply so the consumer's `onChunk` proves live delivery before that reply completes, rather than a complete reply split by the test. Check the completed message ID and full committed text in the result and local transcript exactly once. Compare against the default `final` subscription, which receives completed content rather than provisional wire deltas. Preserve the existing controller coverage for suffix completion and by-reference replies. If exercising gap repair in stdio requires a packet filter, use a deterministic test transport and keep the real-child gate focused on the ordinary stream.

## Gates, size and done

Before each implementation report, run typecheck and the full `bun test ./test` on a clean RAM-backed archive. Run the new race and stdio tests in isolated processes as well. If harness code needs a change, coordinate it and run its own suite. Keep the 35 snapshots unchanged, including the A1 hash `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. The clean R5 close-out archive at `910b7fd` provides the implementation-branch baseline of 1,649 tests in 155 files, including the unchanged snapshots. No provider calls. Reuse the existing harness client, session event unions, prompt result and record path. Keep waits event-driven with a bounded failure path.

| File | Current ceiling |
| --- | ---: |
| `src/agent-session.ts` | 4,492 |
| `src/client.ts` | 1,046 |
| `src/controller.ts` | 764 |
| `src/agent/conversation-manager.ts` | 1,012 |
| `src/native/host.ts` | 909 |
| `src/native/controller.ts` | 599 |
| `src/agent.ts` | 563 |
| `src/metering/engine.ts` | 1,034 |

Extract concentrated native submission or event handling first if a touched file needs room. Keep each new module to one concern and explain any file over about 400 lines. Report line counts before and after. The highest risks are settling before a durable withdrawal, resending a withdrawn item after a lost acknowledgment, treating a receipt as a turn outcome, and counting final text returned by the harness as evidence that it streamed live.

Done means confirmed native withdrawal through the consumer API, a regression proving no client false stall during reopen, one conversation event per observed item milestone, and a real stdio consumer stream with one final stored reply. Document the APIs and the live-only receipt boundary. The outline's unscheduled work stays separate, including persistence of submissions across an acp-client restart, turns that ended with no client, bounded turn and input recovery pages, import/export and further host controls.
