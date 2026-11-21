# Tools and host callbacks: work log

Branch: `tools-and-callbacks`.
Base: `c17d525` on `acp-client-integration`. That revision was still in review
when this work started; the owner approved proceeding on it. If review changes
the base, this branch needs a rebase and a rerun of everything below.

Baseline at the base: harness typecheck clean and 298 tests passing; acp-client
typecheck clean and 1390 tests passing.

A note that applies to every entry: the machine ran other work during these
sessions (load average about 5). Under that load one or two harness tests that
spawn a child process or use SQLite time out per full run, a different one each
time. Each passed when rerun alone. Full runs below use `--timeout 30000`.

## Step 1: contracts (Gate 1)

Commits `610b8fe`, `f95b299`.

Done:

- Decision record `0021-tools-and-host-callbacks.md`.
- Contract types in `src/contracts/tools.ts` and additions to `loop.ts`,
  `model-execution.ts`, `events.ts`, `storage.ts`, `protocol.ts`, `session.ts`
  and `context.ts`.
- The storage side of the contract, because the contract type would not
  compile without it: `setToolRevoked`, `revokedTools` in the snapshot and
  archive, and an optional typed `outcome` on tool results.
- The kernel loop passes a dispatched call's outcome to its paired result.

Tested: typecheck; two new storage conformance cases that run on memory and
SQLite (revoked set through reopen, export and import; outcome validation).

Walkthroughs the plan asks for. Each names the owner and what a consumer sees.

| Case | Owner | Observable outcome |
| --- | --- | --- |
| Reconnect with a missing handler | The session's catalog. The connection supplies handler names at `initialize`; the catalog is bound on load before `start`. | `session/tools` shows the tool with `available: false, reason: "handler_missing"`. It is not offered. A call to it is skipped with `tool_unavailable`. |
| Revocation while waiting for approval | The permission gate. `tool/revoke` commits the revocation, then closes the tool's open requests. | One paired result `tool_unavailable`, a `skipped` event, no `started` event. A later `approval/respond` for that request is refused. |
| Callback with no deadline | `runFunction`. | The call stays `started`. `session/status` shows phase `tool` with the invocation ID. Suspension waits. Interrupt ends it as `interrupted`, effect unknown. |
| Large result on a separate filesystem | The producer stores the bytes. The harness stores only the reference in the result's `outcome`. | The model sees a preview and `result_id`. `read_tool_result` is checked against recorded references for the requesting channel, then sent to the host as `results/read`. |

Drift from the design:

- The plan says to validate configured registrations in managed config. The
  catalog is supplied on `session/create` and `session/load` instead, and not
  stored. The spec says definitions are data the consumer declares at open and
  that only revocations are saved, and a stored catalog would make reconnect
  with a changed handler set ambiguous.
- No new storage table for invocations. Records are derived from the committed
  call, the dispatch evidence of decision 0018, the paired result and the
  turn's end. Storage and archive format numbers do not change.
- `waiting_for_approval` and the turn phase are process state. After a reopen
  an approval is gone (existing behavior), so nothing is lost.

Gaps: the walkthroughs were on paper at this step. Steps 2 and 3 test them.

## Step 2: catalog and lifecycle (Gate 2)

Commit `7fdd963`.

Done:

- `src/util/schema.ts`: a small JSON Schema check for arguments.
- `src/capabilities/tools/catalog.ts`: catalog validation and state.
- `src/capabilities/tools/invocations.ts`: derived invocation records.
- `src/capabilities/tools/functions.ts`: callback execution with deadlines,
  result shaping, and the scoped reader.
- `src/governance/permissions/gate.ts`: a `refuse` check after policy and
  again at the dispatch boundary, outcomes on results, `closeTool`.
- `src/index.ts`: offered list per inference, dispatch wiring, phases,
  `session.tools` controls.
- `BUSINESS_RULES.md`: adjustable defaults.

Tested: `test/tools-catalog.test.ts`, 13 tests at the session level with a
test executor. They cover each Gate 2 evidence item: fixed entries refuse
removal; revocations survive reopen; runtime selection is supplied at open;
denied and unavailable tools are omitted; a retry sees the frozen list;
invalid, unoffered and revoked calls skip without a callback (before approval,
during it, and after it was granted); recovery before and after dispatch
evidence reports `skipped`/`none` and `interrupted`/`unknown`; deadline
precedence; a late reply changes nothing; suspension waits and reports the
call; large results and reader scope. Full harness suite: 315 tests, all pass
apart from the load timeouts described above.

Regressions:

- `test/channel-controls.test.ts`: two assertions compared `activeTurn` with
  exact equality and now see the new `phase` field. Changed to `toMatchObject`.
  A consumer doing exact comparison on `activeTurn` would see the same.
- Skipped results of built-in tools now carry `outcome: { status: "skipped" }`
  in storage. Their content and events are unchanged.
- Tools the turn's policy denies are no longer offered to the model, built-ins
  included. The spec asks for this. Before, a denied built-in was offered and
  the call was skipped with `policy_denied`. Existing tests still pass.

Gaps and limits:

- The schema check covers common keywords only and ignores the rest (`$ref`,
  `oneOf`, `pattern`, `format`). A schema using those is checked loosely.
- A call made by the model for a tool that was offered in an earlier inference
  of the same turn but not the latest one is refused. Only the latest offered
  set is kept.
- Expiry of a reference is checked against the harness clock.
- `read_tool_result` is offered whenever a catalog exists, even with no stored
  result yet.
- Not yet tested here: real transports, concurrent callbacks, cancel on the
  wire. That is step 3.

## Step 3: callback and result transport (Gate 3)

Commits `0bbf257` (harness) and `ea5da58` (acp-client, with step 4).

Done, harness:

- `src/interfaces/protocol/functions.ts`: the callback bridge (a
  `FunctionExecutor` that sends `functions/call` and `results/read`, matches
  answers by request ID, sends `functions/cancel` when a wait is aborted, and
  fails open waits when the connection goes) and the tool methods.
- `server.ts`: `initialize` accepts `callbacks: ["functions/call"]` and
  `functions`; `tools` on create and load; handlers bound before `start`;
  capability `functions`. The file is now 433 lines. The reason is that the
  open paths live there; everything separable went to `functions.ts`.
- Both transports carry callbacks and answers. The stdio server treats a line
  with an ID and a result or error, and no method, as an answer.
- `HarnessClient.serveFunctions(handler, reader)` runs each handler in its own
  task, plus typed methods for the tool requests. Types exported from
  `src/client.ts`.
- The scripted server passes the catalog to the session, and its request log
  now lists the tools offered.
- Fix found by the transport tests: when the executor rejects its wait on
  abort, a deadline was treated as a failure of the call and failed the turn.
  `runFunction` now tells the two apart.

Done, acp-client:

- `src/native/functions.ts`: `NativeFunctionsConfig`, routing to handlers, the
  private result store and bounded reads by ID.
- `NativeHarnessHost`: `functions` config, catalog and runtime selection sent
  on every open, `tools()`, `revokeTool`, `restoreTool`, `enableTool`,
  `removeTool`, `toolInvocation`, `toolInvocations`.
- `conversationCapabilities.supervision: "backend"` on native controllers.
  `stallLimitsFor` returns no limits for it.
- `tool_call` events with status `skipped` or `interrupted` map to a failed
  tool update for the consumer.

Tested:

- `test/tools-protocol.test.ts` (harness, 8 tests). In process and over real
  stdio children: concurrent callbacks answered in reverse order land in their
  own channels; status answers while handlers are quiet; interrupt cancels
  only its own call; deadline cancel reaches the handler; late answers change
  nothing; typed errors. Over stdio only: a 3 MB result by reference with
  reader scope; revoke during approval and persistence across processes;
  SIGKILL with a call outstanding. Plus negotiation and catalog validation.
- `test/native/function-host.test.ts` (acp-client, 4 tests): catalog shape,
  routing, the result store (multi-byte text reassembled from 7-byte parts,
  paths refused, expiry), and the supervision guard.

Regressions and behavior changes:

- **Native turns are no longer cancelled by `operationLifecycle` silence
  limits**, including configured ones and including a silent model. The spec
  asks for this. The shared conformance case "stale detection" expected a
  stall and failed for the native subject. It now has a `backendSupervised`
  branch that asserts the turn is still running past the limits and ends only
  on an explicit stop. This touches the reviewed controller conformance suite.
- **Host reopen rule changed.** After a lost connection the host reopened only
  if a push was waiting or a known turn was running. A crash right after an
  input was accepted, before `turn_started` reached the host, left the prompt
  waiting forever. This is a bug in the acp-client integration base, found by
  checkpoint case 4b. The host now also reopens when any accepted input is
  unsettled. Side effect: with file-backed records, a stale unsettled input
  from an earlier acp-client run makes the host reopen after a loss.
- The scripted server's request log lines gained a `tools` field.

Gaps and limits:

- Tool changes need a running harness. A revocation made while it is stopped
  is not queued the way channel changes are.
- The runtime selection is kept in the host's memory. A new acp-client process
  starts from each function's `enabled` flag.
- Result expiry at the host uses the file's modification time. Stored results
  are plain files with mode 0600 in a 0700 directory, not encrypted.
- A handler's return value that cannot be serialized to JSON fails the call
  as `handler_failed`.
- Reads are in bytes of the serialized JSON text, not of the original value.
- No test sends a `functions/call` whose arguments exceed a frame; that path
  returns `request_too_large` by inspection only.
- No test covers two connections; the server has one connection per process.

## Step 4: public checkpoint (Gate 4)

Commit `ea5da58`.

`test/native/functions.test.ts` runs acp-client's public conversation
interface against a real `serve --stdio` child with a SQLite session. Plan
scenarios:

| Scenario | Test | Result |
| --- | --- | --- |
| 1. Approved call held at a barrier; Bob finishes; status shows Alice's tool and elapsed phase; silence does not cancel; result commits once and reaches the next inference | `1:` | Pass. Silence limits of 150 ms, handler held over 600 ms. |
| 2. Revoke while approval pending; old request authorizes nothing; skipped; next inference omits the tool; persists across reopen | `2:` | Pass. Reopen is a new acp-client and a new harness process. |
| 3. Result larger than a frame, stored on the host, read through the producing channel; other channel, path and expired ID refused | `3:` | Pass. 3 MB result, host directory outside the harness home. |
| 4. Lost outcome stays uncertain and the handler is not rerun; timeout gives one paired result and a late reply changes nothing; interrupt, then a late reply starts nothing | `4a`–`4d` | Pass. 4b is the crash between dispatch evidence and the send. |

Docs updated: harness `README.md` and `ARCHITECTURE.md`, `BUSINESS_RULES.md`,
`WORK.md`, and `CONSUMER_GUIDE.md` at the repository root.

Final verification at `ea5da58`: see the closing entry.

Gaps:

- Spec acceptance 1 asks for schema validation through real stdio. The
  invalid-argument cases run at the session level and in process, not in the
  acp-client checkpoint.
- Scenario 4a stops the harness cleanly through the host. The SIGKILL variant
  is in the harness stdio test.
- Scenario 3 waits about 4 seconds of wall clock for expiry.
- The model is scripted throughout. No test uses a provider, so how a real
  model reacts to the skip and timeout messages is untested.
- No independent review has happened. The plan requires one per gate.

## Closing entry

Implementation revision: `ea5da58` on `tools-and-callbacks`. Nothing is pushed.

Verification at that revision:

- acp-client: typecheck clean; `bun test ./test` 1401 pass, 0 fail (131
  files). Baseline was 1390. An earlier run at the same code had one failure
  in `test/conversation-turns/characterization.test.ts` (PTY bridge) that
  passed when rerun alone.
- Harness: typecheck clean; `bun test ./test --timeout 30000` 324 tests in 44
  files. One run passed 324 of 324. The final run had two timeouts under
  machine load, in `permissions-e2e.test.ts` and `portability.test.ts`, which
  passed when rerun alone (11 of 11). Baseline was 298.

For the reviewer, in order of weight:

1. The base (`acp-client-integration`) is itself unreviewed.
2. Native turns ignore host silence limits, and the shared conformance suite
   was changed to say so (step 3).
3. The host reopen rule changed to fix a hang in the base (step 3).
4. The catalog is supplied at open and not stored in managed config (step 1).
5. Invocation records are derived, with no new table and no format bump
   (step 1). A file whose tool results carry `outcome` does not open on the
   previous revision.
6. Policy-denied built-in tools are no longer offered to the model (step 2).
7. `server.ts` and `host.ts` are over the 400-line guideline.

Not done: independent review of each gate, which the plan requires before
closure, and the retrospective that follows it.
