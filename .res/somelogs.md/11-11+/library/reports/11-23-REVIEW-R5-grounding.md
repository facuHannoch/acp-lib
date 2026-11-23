# Review — R5 step 0 (grounding report for native usage and billing-grade metering)

I reviewed `library/reports/11-23-REPORT-R5-grounding.md` (`integration-r456` at `4e07939`) against the spec ("Usage", "Billing-grade metering", the R5 outline) and the code at `cb6f959` (a clean `git archive`, `/tmp/clad2a-r4g`). I changed no code.

**Verdict: the grounding is accurate, the baseline/certification split is the right one, and the decisions follow the spec. It is ready to implement once five gaps below are settled; none is blocking, but gaps 1, 2 and 5 change the gates.**

## What I verified in the code

| Claim | Result |
| --- | --- |
| `session/model-calls({ after?, limit? })` reads the session-wide ledger; `after` is a call id; the cursor is a position in a **fresh `session.snapshot()` per request**; unknown cursor → `not_found`; cap 100 or the frame byte cap; an oversized single summary → `transfer_limit` | Confirmed (`protocol/server.ts:393`) |
| A call carries `callId, turnId, channel, messageId, outcome, attempts[]`; an attempt carries `attemptId, ordinal, outcome, providerRequestId?, usage?` | Confirmed (`contracts/model-execution.ts:40–50`); `turnId` and `channel` are **required**, so the wire has no between-turn call today |
| `ModelUsage` is only `inputTokens?`, `outputTokens?`, `totalTokens?` | Confirmed (line 23): no cache categories, cost, currency, purpose or model identity |
| `NativeHarnessHost.modelCalls()` returns the raw pages; `usage(channel?)` is a separate aggregate scan that drops call and attempt ids and isn't wired to the operation meter | Confirmed (`native/host.ts:789, 830`) |
| `NativeController.subscribeUsageUpdate` is a no-op and completed/cancelled turns resolve with `usage: null` | Confirmed (`native/controller.ts:219, 506, 508`) |
| `NativeController.currentSessionId` is `host.sessionId`, shared by all channels | Confirmed (`:220`), so a channel-qualified key is needed |
| `InferenceSource` has `drain`, optional `drainForeign`, `outstandingReports`, `sequenceHighWater`; the engine drains foreign records before provenance and counts any as an attribution gap; a source that omits `sequence` is not classed as late | Confirmed (`metering/engine.ts:49–80, 458, 598`) |
| `certification.ts` holds one entry (`opencode-plugin@1`), keyed by adapter id | Confirmed |
| A scripted model can express the test plan: per-record `usage`, `failure` records (so a retried attempt can carry usage), `wait: "cancel"`, and **per-channel** sequences | Confirmed (`contracts/scenario.ts:11`), so `nativeRig` + `modelScenario` with distinct usage per attempt is feasible |
| Line ceilings at `cb6f959` | agent-session **4,495**, client **1,046**, controller **764**, native/host **916**, native/controller **599**, manager **1,012**, agent.ts **563**, metering/engine **1,059**: all match |

## Against the spec

- **Source and key.** The spec's `<Agent id>/<channel id>` key, one source per channel, no `InferenceSource` interface change and OpenCode untouched: the report keeps all four. A host-scoped serialized reader with a keyed per-channel view is a sensible reading of "one channel runs one turn at a time".
- **Ownership by wire turn id**, not by the engine's sequence high-water: correct, and consistent with the engine's own comment that an absent `sequence` is not late. I'd keep `sequence: null` for native records.
- **Check at open, runtime confirmation before `session/create`/`session/open`:** this *tightens* the spec's "checked statically at open, confirmed at the start handshake", because the host can admit resumed or backend work before any prompt. I agree; call it out in the spec update.
- **Between turns, via `drainForeign` into unallocated usage:** matches the spec. The report is right that the current wire has no producer for it and that "no turn and no channel" stays reserved for `agent_metering_records`.
- **Baseline gate on the existing wire:** achievable. Reported input/output/total and ids on sealed calls are on the wire, and one logical call, several attempts and per-attempt usage are all representable. The harness work (cache categories, cost, purpose, a sealed manifest, between-turn ownership) is correctly kept out of the baseline.

## Gaps and risks missed

1. **The parity gate as written compares the library to the same ledger it reads.** "Query `session/model-calls` with `limit: 1` independently and compare" proves the pagination and projection are right, but not that every call is in the ledger. Add a second, independent ground truth: the scripted scenario's own per-attempt usage values (known before the run). The test should assert the persisted record against **the script**, not only against a second read of the ledger. It also catches the harness dropping a retried attempt.
2. **The record shape the engine accepts is narrower than the native evidence.** `ProviderInference` requires `providerID`, `modelID`, a `summary` flag, `messageID`/`sessionID` and a `TokenUsage` with cache categories; the wire has none of the model fields and only three token counts. The report says to preserve call/attempt ids in "optional native metering evidence" but doesn't say what the source puts in `providerID`/`modelID`. Decide it explicitly: leave them **unknown** (never the conversation's *currently configured* model, which can change mid-session), and let pricing resolve to `pricing_unavailable` with the reason, until the harness reports route identity.
3. **A ledger scan per turn close is O(session length).** Reading from the start on every close grows with the session, and a long conversation has thousands of calls (100 per page). The report mentions an "optimized cursor" but only as a risk. Plan it: derive a high-water **call id** from the persisted metering evidence (only advanced past calls that are sealed and accounted), and reread from there plus any still-running call. Put a bound and a test (a session with several hundred calls, close time not proportional to history).
4. **Consumers' per-call usage events and `TurnResult.usage` are not in the plan.** The spec says a consumer enforces limits "from the records and the per-call usage events", and today `subscribeUsageUpdate` is a no-op and results carry `usage: null`. The report's four steps stop at the metering record. Either add the event/result wiring to step 2 or write down that R5 ships records only and the events are deferred (and add the line to the spec's status note).
5. **Step 2 is too large for one gate, and step 3's gate can't pass inside R5.** Step 2 bundles in-turn close and persistence, retry, cancelled/error turns, held backend turns, interleaved channels, reopen replay, failed save, and between-turn allocation. Split it: **2a** in-turn close + persist + parity (the baseline gate), **2b** replay/failed-save safety and the between-turn sweep (with a source fixture). Step 3 depends on harness fields that don't exist (`billing_required` known prices, cache counts "once the wire supports them"); define R5's Done as steps 1, 2a, 2b, 4 plus a **refusal** half of step 3 (static certification entry, runtime handshake check, refusal reasons, no work started in refused cases), and move the pricing half behind the harness release. Say so in the brief so "billing-grade native" isn't claimed.

## Smaller points

- **Terminal event is not "all sealed".** For a cancelled or errored turn a call can still be `running` when the turn is terminal, and decision 0019 fences late attempts after timeout: the pull must treat `running` rows as partial evidence (never zero) and mark the record so a later reopen can resolve them. The report says this; make it a named test.
- **Refusal text.** `billingRefusalReason` currently talks about a certified *adapter id*; with a kind-based entry, a native adapter whose harness can't confirm needs its own reason (kind, missing capability), tested.
- **Serialized reader across channels.** One slow pull delays every other channel's turn close. Bound each pull and test that a hung pull on channel A doesn't hold channel B's close past its bound.
- **Host not running at close** (the harness died mid-turn): the evidence is unavailable, not empty; the record is partial and the pull is retried on reopen with the stable operation id. Name it in the gate.
- **Custom commands/launchers:** the report leaves "can a custom command qualify" to the spec owner. Recommend refusing strict mode for them in R5 (the safe default) and recording that as the decision.
- **Size gate:** the extractions the report asks for are the right ones. `metering/engine.ts` (1,059) and `agent/conversation-manager.ts` (1,012) are the tight files: put the native foreign-allocation logic and the kind-based source selection in new modules and keep each file at or below its ceiling. Add the A1 hash and "no snapshot regeneration" as explicit gates (the report has the latter).

## Process

For R5 reviews I will run every new test of each step about 20 times in isolation, plus the touched test files repeatedly, as well as the full suite (see my R4 follow-up).
