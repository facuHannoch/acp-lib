# Controller interface verification — A2 turn path

Reviewed [A2](../11-11-SPEC-controller-interface.md#brief-a2-the-turn-path-through-send-prepareturn-and-abandonturn) and the current [Interface](../11-11-SPEC-controller-interface.md#the-interface) at `f020860` on `controller-interface-verify`. The source and tests are identical to `d11cd18`. Historical references are the [A2 implementation report](11-12-REPORT-A2.md) and its [beta update](11-12-REPORT-A2-beta-update.md).

## Gate

All runs used clean archives of `f020860`, with `node_modules` linked from the main checkout and Bun 1.3.14. The offline fixtures ran outside the sandbox with approval, as in A1.

| Check | Result | Saved output |
| --- | --- | --- |
| `bun run typecheck` | Clean, exit 0 | `/tmp/acp-a2-verify.LKp4Zl.typecheck.log` |
| `bun test ./test`, first run | 1,399 pass, 3 fail, 3 errors, 1,402 tests in 131 files, 35 snapshots, 274.05 s | `/tmp/acp-a2-verify.LKp4Zl.test.log` |
| `bun test ./test`, fresh archive rerun | 1,401 pass, 1 fail, 1,402 tests in 131 files, 35 snapshots, 227.55 s | `/tmp/acp-a2-rerun.8qMNQU.test.log` |
| `bun test ./test`, third clean run | 1,402 pass, 0 fail, 131 files, 35 snapshots, 200.71 s | `/tmp/acp-a2-third.IfDTBS.test.log` |

All 13 tests in `turn-path.test.ts` and all 35 characterization cases passed on the first run. The snapshot file hash was `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d` before and after each run. The third run supplies a complete green gate.

The two baseline scopes cover different files:

| Command | Baseline at `d11cd18` | Evidence |
| --- | --- | --- |
| `bun test ./test` | 1,402 tests in 131 files | A1 coordinator rerun, 1,402 pass, 0 fail, 35 snapshots, 235.39 s (`/tmp/corep-gate-a1.ReJt.test2.log`). This is the spec gate scope. |
| `bun test` from the repository root | 1,727 tests in 175 files | [A1 verification](11-22-REPORT-A1-verify.md), 1,727 pass, 0 fail, 35 snapshots, 352.06 s. Includes tests under `src/`. |

## Step 1 — Extracted turn and phase order

[AgentSession](../../../../../src/agent-session.ts) L3417 delegates to `runTurn(this.turnRunContext(), turn)`. The context exposes the existing session operations and uses live getters where references can change. [run-turn.ts](../../../../../src/conversation-turns/run-turn.ts) is 353 lines, with the awaited phases in one function and the synchronous recording handlers in `recording.ts`. The phase anchors below were checked against the original `AgentSession.runPrompt` in `0383681^`, then against later changes through the current baseline.

| Phase | Current location and order |
| --- | --- |
| Prepare | L47–74. Agent-owned `beforePrompt` handles participants, media, identity and the owned user record; then turn bookkeeping begins. |
| User writes and metering preflight | L76–123. Managed opens metering before the transcript operation, user presentations and pre-dispatch sync. Detached appends the legacy user line before opening metering. |
| Recording and dispatch | L125–156. Builds the wrapped handlers, prepares the turn and runs it under the supervisor. Forced results retain buffered output. |
| Finish records and metering | L158–229. Finalizes assistant presentation and turn activity, closes metering before local persistence, then closes the managed transcript or appends the detached assistant line. |
| Finalize and return | L230–276. Builds the session result, drains the owned record chain, awaits `afterPrompt` and drains again before returning. |
| Failure | L277–351. Preserves captured output and closes metering if needed, then throws. The queue announces failure. |

The ACP phase order is preserved. The A2 review removed the initial yield between the synchronous turn report and the start of provider readiness (`e7f2d79`). The current path starts readiness immediately, then awaits readiness and acceptance together before delivery and dispatch (`f54dc05`, `9e0f457`). A rejected acceptance fails the prompt immediately. If readiness is still pending, the queue waits for it before the next operation to avoid overlapping reconnects. Within the dispatch phase, A2 step 3 moved construction of the ACP input object out of the deferred prompt closure and into preparation, before supervisor attachment. Provider execution still begins after subscription. The later B2 path skips ACP content and user writes for a turn with no originating messages.

`agent-session.ts`: 5,022 lines before A2, 4,546 at the extraction (`0383681`), 4,594 at step 4 (`47d9931`), and **4,641 now**. This meets the hard requirement to finish below 5,022 lines. The final count is 91 lines above the spec’s rough target of 4,550.

## Steps 2–3 — Interface and harness implementation

- [contracts.ts](../../../../../src/conversation-controller/contracts.ts) L26–74 defines and documents `send`, `subscribeTurns`, `prepareTurn`, `abandonTurn`, `subscribeOutput`, `cancel`, `forceStop` and optional `prepareInternalPrompt`. It describes the controller's ownership of provider execution, subscription before prompt, and the session's ownership of completion. The core lifecycle, settings, usage and capabilities members and the optional method group are present.
- L118–187 matches the current turn shapes: optional `TurnRun.turnId`; ordered message IDs and `CombinedMessage` payloads; optional ACP input plus required handlers; `PreparedTurn` with `turnId` and `live`; and `TurnEvent = TurnStarted | TurnTook`. `TurnCause` holds message IDs, backend items, or both. `StartResult` aliases `ConnectResult`, and `ControllerStartEvent` is re-exported. The optional commands subscriber is typed with the emitted command list at L106, where the spec's Interface example shows a listener taking no arguments. Zero-argument consumers can still ignore the payload. Run IDs originating in the session are checked against the session registry. The harness independently rejects missing turn IDs, empty runs and duplicate IDs.
- [controller.ts](../../../../../src/controller.ts) L316–366 implements the five methods on `HarnessController`; L781 retains the deprecated `AgentController` alias. `send` emits `turn_started` with `sentBySession: true` synchronously and returns a resolved promise. `prepareTurn` and `prepareInternalPrompt` build a deferred wrapper around the existing `prompt` with the given input and handlers, plus controller output, cancel and force stop. Prepared ACP turns are always live. Preparing or abandoning removes the ID from the reported set. Repeated abandonment and abandonment of an unknown ID have no side effect.
- [operations/contracts.ts](../../../../../src/operations/contracts.ts) L17–23 defines `SupervisedProvider`. [supervisor.ts](../../../../../src/operations/supervisor.ts) L120–127 subscribes before calling `provider.prompt()`. The session's `supervisedPrompt` consumes that provider. Metered internal prompts use `prepareInternalPrompt` (AgentSession L3781 and L3821) and keep their own stall limits and metering.

## Step 4 — Session turn path and required tests

AgentSession L2306–2385 builds the steer run, validates it against accepted message state, and registers it before `send`. The active controller's subscriber (L745 and L764–773) stores and emits the reported `cause` in the same synchronous call. The session starts provider readiness, waits for acceptance and readiness, reports delivery, and awaits `runPrompt({ turnId, cause, messages })`. The context declares optional `messages`; ACP preparation and provider input are conditional on it. The session emits completion and resolves the messages after finalization. On failure it abandons the turn before emitting `turn_failed` and rejecting the prompt. The queue continues only when that operation finishes.

All five required cases are present in [turn-path.test.ts](../../../../../test/conversation-turns/turn-path.test.ts):

| A2 requirement | Evidence |
| --- | --- |
| Combined steer cause contains both IDs, with turn-keyed records | L92. Asserts the public cause contains both handle IDs, both handles share the same result, and the two user records use the first steer handle's turn ID. |
| Provider connection failure calls `abandonTurn`, emits `turn_failed` and rejects | L120. Forces a failed reattachment, spies on abandonment and preparation, checks the matching failure event and rejected prompt. |
| Finalization failure reports failure after the provider finishes | L142. Throws from `afterPrompt`, checks the error and matching failure, and checks that no completion was emitted. |
| Config change starts only after a slow `afterPrompt` | L161. Holds finalization on a test-controlled gate released in `finally`; asserts the config stays queued and starts after completion. |
| Duplicate or unknown run message ID throws | L387 checks both branches in `checkTurnRun`; L230 injects an unknown ID at dispatch and asserts no send; L416 verifies the harness rejects a duplicate and asserts synchronous reporting and repeated abandonment. |

## Historical commits and verification changes

- `0383681`, `b5d13a9`, `d8c1fe2` and `47d9931` implement steps 1–4. The extraction commit leaves the A1 snapshot untouched.
- `cffce98` is the separate cause-only snapshot commit. Removing its 39 added cause blocks from the blob produces the exact preceding blob. `6e46e40` records the two owner-approved non-contractual order allowances with explicit order checks. The later `8b4b4f3` removes only the 39 cause-kind discriminator lines after the mixed-cause decision.
- This verification has no source or test fixes. No missing A2 case called for a test change. The known A1 bridge status-wait flake remains for the owner to decide. See [the existing bridge error note](../../../../../.agents/.artifacts/common/errors/11-22-a1-bridge-status-wait-flake.md).

The three first-run failures were in `operation-lifecycle.test.ts`; each passed on the rerun with unchanged source and tests. The rerun had a separate failure in `checkpointing/strategy.test.ts`: the coalesced checkpoint reached sequence 2 instead of 4. That test passed in the first and third runs. All four intermittent failures passed in the third run. The root causes were not established. The existing A1 bridge case passed in all three runs.

Triage notes in `$AGENTS_COMMON_ARTIFACTS_DIR/errors/`:

- [Managed continuation timeout](../../../../../.agents/.artifacts/common/errors/11-22-a2-managed-continuation-timeout.md)
- [Owned continuation timeout and load error](../../../../../.agents/.artifacts/common/errors/11-22-a2-owned-continuation-timeout.md)
- [Cancellation-record timeout and SQLite I/O error](../../../../../.agents/.artifacts/common/errors/11-22-a2-cancel-record-sqlite-timeout.md)
- [Coalesced checkpoint watermark](../../../../../.agents/.artifacts/common/errors/11-22-a2-checkpoint-coalesced-watermark.md)
