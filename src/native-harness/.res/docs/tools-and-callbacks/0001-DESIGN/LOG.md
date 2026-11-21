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
