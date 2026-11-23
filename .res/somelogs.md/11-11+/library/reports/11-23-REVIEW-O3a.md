# Review — orchestrator brief O3a (assignments and the ACP reply path)

This review covers `0e9c79b..4163d9d` on `orchestrator` (alpha `2d7a5b9` merged):

- `ae54682`: the feature, binding worker assignments and recovering ACP replies;
- `f1937fe`: `worker_redirected` only after provider acceptance;
- `ee6026e`: `takenSender` moved under `src/native/`, and invisible participant ids rejected;
- `97d91f0`: the report;
- `4163d9d`: the merge.

I read them through `git diff`/`git show` and a clean `git archive 4163d9d` (`/tmp/clad2a-o3a`); I didn't check out the
branch. I also read the worker-delivery contract and decision 0025 first, as agreed. My probes are in
`test/orchestrator/zz-o3a.test.ts` in that archive.

**Verdict: O3a meets its brief. No blocking findings.**

- **Full suite on the archive** (`TMPDIR` on `/dev/shm`): typecheck clean, **1,576 pass, 0 fail, 147 files**, 35 snapshots; the
  characterization hash is still `fbc6ec2c…`.
- The mechanics I could test all behave as the contract and spec say.
- Five notes (below), one of which concerns real behaviour: **a steer that loses the race against the worker's natural
  completion is refused and its text is never run.**

## The change to Cod1a's file (core-p's question)

`src/persistence/worker-terminal-reason.ts` gains `REFUSED_STEER_REASONS` (`"worker refused: assignment conflict"`,
`"worker refused: dispatch hook failed"`), appended to the allowed `failed` reasons. **It's needed, and consistent with Cod1a's rule.**

- **Why it's needed.** `normalizeWorkerFailure` replaces any reason outside the allow-list with `"worker failed"`. Without the
  two entries, the steerer's staged notice would read "worker failed", and `AcpWorkerDelivery` (which recognises the cause
  by exact reason string) couldn't tell a refused steer from an ordinary failure.
- **Consistent with the public-reason rule.** My probe: both strings are fixed (35 and 36 bytes, well under 128), carry no
  provider text, and the cause comes from a class check (`WorkerAssignmentConflict` or not), never from error text. Raw provider
  text, an empty reason, and a refused reason with a secret appended all still fall back to `"worker failed"`. A refused reason
  under kind `interrupted` falls back to `"worker interrupted"`.
- **No index shifts.** The new entries are appended after the existing three, so the index-based lookups in
  `workerTerminalFailure` (stalled, interrupted-by-steering, by-request) give the same results.
- **No Cod1a test changed.** The one other Cod1a file touched is `test/fixtures/worker-delivery-peer.ts`: its new
  parameters default to the previously hard-coded values (`assignment-42`, `owner-channel`), and `blank` is a new mode. Cod1a's
  repository and process tests pass in the suite.

## Against the checklist

| # | Requirement | Result |
| --- | --- | --- |
| 1 | **Reserve before dispatch, from `beforeDispatch`; `existing` never licenses a second dispatch** | `DurableWorkerAssignments.beforeDispatch` runs in one transaction with the typed destination, `workerHandle`, originating and contributing names, and assignment id = invocation id. **My probe:** a repeated identical reservation (`existing`), the same id with another message, and another id with the same message are **all refused** (`WorkerAssignmentConflict`), so the hook rejects and nothing dispatches. cod2a's fixture also reads the binding from a second connection at provider receipt |
| 2 | **Continue in message order; redirect; policies** | `continueAssignment(old, activeMessage, successor)` after `readBinding` of the *active* message, then `addContributingPolicies`, then `redirect` if the destination changed, all in the same transaction. **My two-steer chain** (old turn's end held): both steers folded into one run, dispatched once as `steer one / steer two`; the active message moved off `m0`; contributing policies became the union `guest, owner, trusted`; **no extra assignments** for the steers; the result was staged once and delivered once; **exactly one notice** on the giver |
| 3 | **`assignment: "new"`: `replaceAssignment` before dispatch** | Proceeds only on a fresh `reserved` binding; `conflict` or `existing` throws (no dispatch). `replaced` triggers `flushNative()` after the commit; a replace also triggers the ACP flush. cod2a's replace case shows the old notice going to the **old** destination as `interrupted` / "worker interrupted by steering", and the new result to the new one |
| 4 | **A successor that won't run: `closeContinuation`, the steerer told, no dispatch** | On a rejected hook (`conflict` or `hook_error`) the old continuation is closed (`interrupted`, "worker interrupted by steering", the **old destination**) and a separate `refused-steer:<invocation>` notice is staged for the steerer in the same transaction; a `worker_failed` event (reason `refused`, safe cause, destination) is emitted, and the successor is never dispatched. The raw hook error never reaches a notice or event (the test asserts it). The folded-steer conflict case is covered too |
| 5 | **`worker_redirected` only after acceptance** | The row update and the event are deferred behind `beforeDispatch` and announced on the first provider update or a successful completion; the tests show no redirect or failure event before the tool gate is released, and one redirect after |
| 6 | **A fresh assignment after a restart** | A new `send` after reopen finds no running assignment, so it plans a `start` and reserves fresh; a direct `continueAssignment` on the abandoned binding conflicts. cod2a's restart test checks both |
| 7 | **ACP half through the same store steps** | `AcpWorkerDelivery.drain` scans `discoverAssignments({destinationKind: "acp"})` for `unstaged` then `pending`: it stages committed finals (`binding.finalRecordId`), then appends and calls `transitionDelivery(pending → delivered)` **only after the append returned**. An unconfirmed append (any error but "destination unavailable") leaves it pending. Missing or deleted destination → `failed_destination` |
| 8 | **Kill points** | Real subprocess tests: SIGKILL **after the final record and before staging**, and **after the append and before the delivered mark**. Each reads the database at the crash point, reopens **twice**, and finds one record, `delivered`, and the result exactly once in the target's next provider prompt |
| 9 | **Blank result → `worker_failed` "worker produced no saved result"** | The `blank` mode test produces that reason and a `worker_failed` message with `errorKind` and `reason`; a failing worker gives "worker failed"; the staged text doesn't contain a planted secret |
| 10 | **The host scan skips ACP destinations** | `src/native/worker-delivery.ts` calls `discoverAssignments({destinationKind: "native", …})` only |
| 11 | **No redispatch on recovery** | Every recovery path only stages or appends; a reservation that exists refuses dispatch (row 1); the flush runs at `Agent.open`, after replace, after each conversation completion, and at close |
| 12 | **A gone target** | Deleted destination → `failed_destination` with no record, the result kept, and `check` and `list` show it as `latestOutcome` |

## The append extraction: a move

`appendAssistantMessage` moved to `src/agent/append-assistant-message.ts`; the manager shrank **1,081 → 1,013** lines. **My comparison
of the old and new archives through the public API** (two appends, a blank text, an unknown conversation):

- the record id and logical id patterns, metadata keys, consumer metadata and status are identical;
- the two ids are distinct, and **2 events** are published, as before;
- the blank-text error is unchanged;
- the only difference: an unknown conversation now throws `AppendDestinationUnavailableError`, a subclass of `Error` with the **same
  message**.

The stable-id path adds an in-transaction check: a record already saved under that id is returned without a new record or
event, and a record that belongs to another write is refused. `agent-session.ts` is untouched (4,564); `host.ts` is 916; no
delivery-repository file changed.

## Notes

1. **A steer that loses the race against natural completion is refused, and its text never runs.** My chain probe without
   holding the old turn's end: I released the tool gate with two steers queued. The turn finished by itself first, and both
   steers hit `continueAssignment` on a terminal predecessor. Result: the result notice was delivered, then **two
   `worker_failed: refused (conflict)` notices**, and the worker never received either steer text. The tool had already answered
   `steered` for both. That follows the contract (a terminal predecessor is a conflict) and the spec (the steerer is told),
   and nothing is lost silently. But the worker is then idle, so treating this conflict like the restart case, by reserving a fresh
   assignment and dispatching the text, would run the work instead of dropping it. **Spec-owner decision** (not blocking).
2. **A refused first dispatch on an idle worker has no notice.** If `beforeDispatch` fails for a `start` plan, the tool has already
   returned `sent`, and only a generic `worker_failed` event is emitted (my probe: a reused invocation id gave `sent`, then
   `worker_busy, worker_failed: worker failed, worker_idle`, and **no new notice**). Invocation ids are unique per call, so a
   duplicate is unlikely, but a transient persistence error would be just as silent. Consider staging a refusal notice for `start`
   plans too.
3. **A folded steer emits one `worker_replied` per handle.** Two steers folded into one run gave two `worker_replied` events for one
   result (the same happens from O2). A consumer counting replies will double-count.
4. **The invisible-id guard covers U+200B only.** `ee6026e` rejects ids made only of whitespace and U+200B (my probe: declined).
   Ids made only of ZWNJ (U+200C), ZWJ (U+200D), word joiner (U+2060), soft hyphen (U+00AD) or tag characters (U+E0020) still
   pass as non-blank. A check on `\p{Default_Ignorable_Code_Point}` plus whitespace would cover the class.
5. **A refusal appears as the worker's latest outcome.** The synthetic `refused-steer:` binding is the newest by reservation
   sequence, so `check` and `list` show `latestOutcome: failed (worker refused: …)` even when the worker's last real work succeeded
   (my chain probe's final state). Probably acceptable, but the agent reading `check` may take it as a worker failure.
- **Baseline:** 1,576 tests, up from 1,565.
