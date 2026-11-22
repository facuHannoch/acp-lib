# Review — R3 step 1: permission events

This review covers `c0fcf62` (diff `757e062..c0fcf62`) on `native-integration-r`. I read it through `git diff` and a
clean `git archive c0fcf62` (`/tmp/clad2a-r3s1.*`); I didn't check out the branch. I wrote my own ACP and native
probes (`test/zz-probe/r3-probe.test.ts`, `r3-native.test.ts` in that archive).

**Verdict: no blocking findings.** I tried to produce zero or two `permission_resolved` for one
`permission_requested` on every path I could reach. **Every case gave exactly one of each.** The A1 snapshots don't
capture the new events (the hash is unchanged), and no large file grew.

## Design, checked

**`ConversationPermissions`** (`src/permissions/conversation.ts`) is the single coordinator per conversation:

- `request()` registers the entry *before* emitting `permission_requested`, then starts the decision with an
  `await`, so a decision can't come before the requested event.
- Every route goes through `entry.close`, which is guarded by `pending.delete(entry)`, so the second close is a
  no-op. These routes are the abort signal, `end(turnId)`, `stop()`, the native ticket's `resolution`, and the
  decision's `nominate`.
- The resolved event is queued in a microtask, so all request listeners finish before a re-entrant stop publishes
  it.
- A request on a stopped conversation, or with an already-aborted signal, returns cancelled *without* emitting a
  requested event. That's still consistent: zero of each.

**Where the closing hooks are:**

- `endTurn` → `permissions.end(turnId)`;
- internal prompts → `end(operationId)` in `finally` (the handoff recap now goes through `internalHandler`);
- `stop()` → `permissions.stop()` before `cancelRunning`;
- `AcpClient.prompt`'s `finally` → `cancelPendingPermissions()`, so a provider return also aborts open requests.

**Native: `NativeApprovals`/`Approval`** (`src/native/approvals.ts`):

- There's one ticket per harness `requestId` (`active`), shared by the live event and any observed copy (the
  `events` WeakMap), and by the host-responder and conversation routes.
- `finish` is guarded by its abort signal. `answer` finishes once, including in its `finally`.
- An `approval_closed` reason maps to:
  - `approval_denied`/`dispatched` → `consumer`, recorded as observed, so it can't race an in-flight answer;
  - `approval_timeout` → `timeout`;
  - anything else → `turn_ended`.
- Turn end, disconnect and stop finish the ticket.
- The controller removes duplicate copies *per turn* through `turn.approvals` (a set of request ids that's never
  cleared while the turn lives). So a held or replayed copy of a request can't call `runNativeApproval` a second
  time, and can't create a second conversation entry or public id.

**Permission handler choice for backend turns:** it's captured when the turn is reported (`permissionHandlerOf`,
the first message that has an `onPermissionRequest`), separately from the stream handlers, as I recommended at
grounding.

## Trying to produce zero or two

**ACP** (`permission-agent` fixture, `permissions: { default: "ask" }`):

| Case | Events |
| --- | --- |
| Handler that never settles, then `interrupt()` | `requested`, `resolved:turn_ended` ✓ |
| Handler that never settles, then `connection.forceStop()` | `requested`, `resolved:turn_ended` ✓ |
| Handler that never settles, then `stop()` | `requested`, `resolved:turn_ended` ✓ |
| `stop()` called *inside* the `permission_requested` listener | `requested`, `resolved:turn_ended` ✓ (no double; the decision run sees the entry is gone) |
| A listener that **throws** on `permission_requested` | `requested`, `resolved:handler` ✓, and the prompt completes. The emitter isolates listener errors, so the entry isn't left orphaned |
| Ask with no handler | `requested`, `resolved:default` ✓ (the R2 refusal) |

**Native** (scripted stdio rig, harness policy `record: ask`):

| Case | Events |
| --- | --- |
| Handler that never settles, then `interrupt()` | `requested`, `resolved:turn_ended` ✓ |
| Handler that never settles, then `nativeHarness.stop()` (disconnect), then `ensureStarted()` (reopen) | `requested`, `resolved:turn_ended` ✓, and **no second `requested` after the reopen**. The harness closed the approval on disconnect, so the observation has nothing to replay |

**cod2a's own native cases** (responder, external denial, force stop, stop, disconnect) pass on the archive.
`permission-events.test.ts`, `native/checkpoint.test.ts` and characterization: 82 pass, 0 fail.

**Not reachable offline:** the harness's own `approval_timeout` (10 minutes, not configurable from the rig). The
mapping is in `Approval.closed`, and it goes through the same guarded `finish`. Step 2's tests should cover it if
the rig can shorten the harness timeout.

## Snapshots and sizes

- The characterization snapshot hash is still `fbc6ec2c…`. A1 captures a fixed set of event kinds, so the new events
  don't appear.
- File sizes, `757e062` → `c0fcf62`:
  - `agent-session.ts`: 4,565 → **4,565**;
  - `native/host.ts`: 884 → **877**;
  - `native/controller.ts`: 601 → **583**;
  - `client.ts`: 1,062 → **1,062**.
- New modules: `permissions/conversation.ts` (138 lines) and `native/approvals.ts` (152 lines).

## Notes (none blocking)

1. **A locally cancelled native approval leaves the harness gate open.** On detach or stop, `#attachmentApprovals`
   aborts, and the conversation resolves `turn_ended` without calling `native.answer`. The harness turn then waits
   for its own 10-minute timeout, or an interrupt. **This was already the behaviour before R3:** the old `#approve`
   also skipped `respondApproval` when cancelled. So it isn't new. But now that tickets exist, sending `deny` on a
   local close would release the harness at once. That fits "nothing waits forever", and is worth considering in
   step 2.
2. **`expiresAt` isn't set yet.** It's optional in the event type, and step 2 brings the timeout. The native ticket's
   `requestedAt` is stamped when the `Approval` is constructed, which is the host's first `observe`, keyed by
   request id. That's the right place, as recommended at grounding.
3. **Every resolution is a microtask after `close`.** A consumer that reads conversation state synchronously right
   after `answerPermission` resolves may not see the resolved event yet. That's fine, but say so in step 2's docs.

## Not run by me

I didn't run the typecheck or the full suite. core-p is running the full suite.
