# Review — R6 step 0 (grounding report for native withdrawal, reopen, receipts and streaming)

I reviewed `library/reports/11-23-REPORT-R6-grounding.md` (`integration-r456` at `dd67d45`) against the spec's "Brief R6 (outline)", the integration log it cites (`11-20-LOG.md`, "Gaps") and the code. Alpha `b77c3d7` carries R5 only through step 2a, but R6's four paths are untouched by R5, so I read a clean `git archive dd67d45` (`/tmp/clad2a-r6`), which also holds R4 and all of R5. I changed no code.

**Verdict: three of the four items are real gaps and the brief addresses them well; the stall item is no longer a gap and should not be a step. Withdrawal is the important one, and it is worse than the report says. No harness wire change is required, but there is one ordering question for haurness-l.**

## Each outline item against the code

| Item | Still a gap? | What I found |
| --- | --- | --- |
| **Withdraw through the harness once a push was sent** | **Yes, and it is a defect, not just a missing feature.** | `PromptHandle.withdraw()` is `steering.withdraw(id) \|\| withdrawWaiting(backendTurns, id, …)`. `withdrawWaiting` takes an accepted, unclaimed item out of `BackendTurns`, settles the prompt as cancelled and says in its own comment that **"the backend is not told"**. The input is already saved in the harness's inbox (`received`), so the harness **still runs it and makes the model calls**; the consumer was told the prompt was withdrawn. The wire has what is needed: `channel/withdraw` returns `withdrawn` (with `repeated`) or `taken` (naming the turn) and is idempotent; the client has `withdrawItem`, and the host's `withdraw(channel, item)` already calls it and settles the submission. Only the session never calls it |
| **Stall clock paused while the host reopens** | **No.** | `stallLimitsFor` returns `{ firstOutputMs: false, nextOutputMs: false, toolMs: false }` whenever `conversationCapabilities.supervision === "backend"`, **even if the consumer configured limits**, and the session passes every turn through it (`agent-session.ts:3681`). The log's gap predates that guard. The report is right about this |
| **`items_receipt` forwarded beyond `receiptOf`** | **Yes** | The controller handles `items_receipt` (`controller.ts:327`) into a monotonic `#receipts` map read by `receiptOf`; there is no conversation or session event for it, and the controller test only checks the lookup |
| **A real-process test with `stream` text** | **Partly** | The host's `harness.text` option (`"final"` default, `"stream"`) and the controller's delta/`message_completed` handling exist and are unit-tested. `test/native/rehearsal.ts` already runs a real stdio child with `text: "stream"`, but through the host directly; no test drives a consumer `AgentSession`/Agent over it. The report says exactly this |

The report's other corrections to the old log (the host now uses `session/open`, `session/create` and observation/reconciliation, not `session/load`; R1–R5 already cover durable channel intents, permissions, cancellable startup and metering) match the code.

## The proposed brief

**Step 1 (withdraw) is right in shape and the priority should be raised.** Keep the synchronous local withdrawal, add `withdrawAsync`, share one implementation, confirm through the host, and make "taken" and "unknown outcome" explicit. Three things to add:

1. **The ordering guarantee is an assumption.** The brief says to use "the ordered live connection even if the push response is pending". The stdio server **dispatches requests concurrently** ("Dispatch concurrently: one slow request must not block other channels", `stdio-server.ts:52`), and `withdrawItem` on an item the harness has not stored yet fails with `not_found`. So a withdraw issued right after a push can overtake it and come back `not_found`, which is ambiguous (never arrived vs not arrived yet). The client must treat `not_found` for an item whose submission is `unknown` as "unresolved", never as "withdrawn" or "nothing to do", and either wait for the push outcome or reconcile (the brief's reconciliation fallback covers it; say it in the gate). **Ask haurness-l** whether per-channel arrival order is guaranteed for a push followed by a withdraw, or whether a withdraw-before-push should leave a tombstone so the late push is refused. If neither, the host must sequence them itself. This is the only point that might need a wire change, and it may not.
2. **A durable withdraw intent.** The host replays `saved`/`unknown` submissions on reopen. Between the user's withdraw and its confirmation, a reconnect or reopen would replay an input the consumer cancelled unless the withdraw is recorded in the host's submission records (a `withdrawing` state next to `saved`/`unknown`). The brief's "must not cause a cancelled submission to be replayed" needs this named, and a test that closes and reopens between the two.
3. **The other paths that drop accepted-unclaimed items share the defect.** The report says to "audit" `interrupt({ clearQueue })`. It clears backend-held items without telling the harness too (`backendTurns.clear(...)`), as does stopping or closing a conversation with items waiting. They should be in the audit's output as a list with a decision for each (withdraw best-effort, or document that the harness will still run them), not left as a note.

**Step 2 (stall clock) should be dropped as a step.** The behaviour is already correct by construction. Keep only a regression test (tiny configured limits, a held reopen, the turn stays pending past the limits, then reconciles once) and fold it into step 1 or 3's gate; update the spec outline so it no longer lists the stall clock as open. The log's other open item, the 30 s request timeout with `channel/suspend` waiting on a long tool, is not in the outline and stays out.

**Step 3 (publish receipts) is fine, with two cautions.** It adds a public event variant to the conversation event union, so it needs the changelog and consumer-guide entries and a check of exhaustive switches over the union. Keep it live-only as the report says, and state that a subscriber that attaches late sees no replay.

**Step 4 (real-process `stream`) is right, with a test-design caution.** The scripted chunks are timed (`afterMs`), so "a controllable boundary after a partial reply" built from delays would be timing-dependent. Use a partial text followed by the `hold` tool: the deltas arrive before the held tool, `onChunk` observes them while the turn is running, then release the hold and check the completed message and the persisted reply exactly once. That also proves the deltas were live and not the final text split afterwards (the report's own risk).

## Gates, tests, size

- **Gates:** typecheck and the full suite on a clean RAM-backed archive, each new test 20 times in isolation, snapshots and A1 unchanged, no provider calls. The stated baseline (1,649 tests in 155 files at `910b7fd`) is the number I reproduced.
- **Size rules:** the eight ceilings in the report are exactly what I measured (4,492 / 1,046 / 764 / 1,012 / 909 / 599 / 563 / 1,034). **`agent-session.ts` is at its ceiling and steps 1 and 3 both add session API and events**, so the extraction has to come first, not "if a touched file needs room": move the prompt-handle construction (`withdraw`, the handle's `Object.assign`) and the new receipt forwarding into new modules, and make the first commit a pure extraction.
- **The tests the brief lists are the right ones** (an accepted steer waiting in the inbox, a take winning the race, push written with the acknowledgement held, a withdrawal committed with the response lost, a late push response). Add: `not_found` on an unknown submission; a withdraw during `markSent` (bytes written, no response); and close/reopen with a pending withdraw.

## Harness wire changes

None are required for the four items. One question for haurness-l (ordering or a tombstone for a withdraw that precedes its push), and a note that `channel/withdraw`'s `repeated` flag and `taken` turn id are already enough for the consumer-side result.

## Drop or defer

- **Drop** the stall-clock step (keep a regression test).
- **Defer** nothing else; the receipts event is the one item with no consumer need stated, so if scope is tight it can follow the withdrawal and the stream test.
- The outline's unscheduled items (persistence of submissions across an acp-client restart, turns that ended with no client, bounded recovery pages, import/export, more host controls) correctly stay out.
