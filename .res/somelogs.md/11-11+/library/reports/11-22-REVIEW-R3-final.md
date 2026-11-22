# Review — R3 step 2, the follow-ups, step 3, and the final review of R3

This review covers `c0fcf62..c5b10b0` on `native-integration-r`:

- `fef2020`: step 2;
- `8776401`: the native controller boundary and the stand-in;
- `ce5e3d5`: an expiry while a record write is held;
- `c5b10b0`: the changelog, the spec and the report.

It's also the final review of R3. I read the commits through `git diff` and a clean `git archive c5b10b0`
(`/tmp/clad2a-r3f`); I didn't check out the branch.

**Verdict: R3 is complete, and your decisions are implemented. No blocking findings.**

- **The full suite on the archive:** typecheck clean, **1,507 pass, 0 fail, 137 files**, 35 snapshots. The snapshot
  hash is still `fbc6ec2c…`.
- **Step 1 notes:** two of my four landed (`expiresAt`, the harness timeout test). Two didn't (deny on a local
  native close, and documenting the microtask). Neither blocks; see the end.

## Your decisions

| Decision | Code | Holds |
| --- | --- | --- |
| acp-client doesn't bound handlers | `runHandler` has no timer, only a race against the entry closing. The handler-owned path sets no `expiresAt` | ✓. The test is "handler-owned requests expose no deadline and bypass answerPermission" |
| `permissionTimeoutMs` only for the consumer wait | The timer is armed only when `waitForConsumer` (`level === "ask" && !handler && answersPermissions === true`) | ✓ |
| An unattended ask is refused, `by: "default"`, even with default `allow` | `level === "ask" \|\| level === undefined` → `refuse("default")`. There's no fallback to `default` | ✓. My probe: `default: "allow"` with `kind:execute: ask` and no answerer gave `default:denied`, and the agent got `reject` |
| Order: handler → consumer wait → refuse | As above. `answersPermissions` is ignored when a handler exists | ✓ |

**Validation:** `answersPermissions` must be a boolean. `permissionTimeoutMs` must be a positive safe integer
**< 600,000**, so it can't reach the harness's 10 minutes. Both are inherited like `permissions`, and an explicit
`false` overrides (tested).

## `answerPermission` and the deadline

`ConversationPermissions.answer(id, optionId)` goes to the entry's `answer`, which exists only for consumer-wait
entries, so a handler-owned request returns `false`. `claim()` clears `entry.answer` exactly once, so a second
caller loses. The deadline is checked again when an answer comes in (`remaining() <= 0` → `expire()`). The option is
checked against the offered options.

**My probe** (ACP, an `execute` request):

- the request event carries `expiresAt` (a number);
- an unknown option gives `{accepted: false}`;
- **two concurrent answers** (`allow` and `reject`): one `true`, one `false`;
- a late answer after resolution gives `false`;
- the agent received `allow`, and the events are `requested`, `resolved:consumer`.

**The deadline counts from receipt**, as recommended at grounding:

- ACP stamps when the request arrives (`stampAcpPermission` and `acpPermissionArrivals`);
- native stamps when the ticket is created on the host's first observation, keyed by request id, and replay keeps it.

The remaining time is measured with `performance.now()`. `expiresAt = wallTime + budget`. "an already-expired request
keeps its ingress deadline when delivered late" covers a held request.

**`ce5e3d5`:** an expiry uses `send` and not `sendAfterRecord`, so a timed-out refusal reaches the provider even while
the requested record write is held ("a consumer expiry reaches the ACP agent while requested-record persistence is
held"). A consumer *answer* still waits for the record, which is correct: the record comes first. A record failure
refuses (`by: "default"`) and closes the request, so it can't be left open.

## The `8776401` source change

- `finish(act, providerEnded)` aborts the turn's approval signal with the reason `nativeProviderTurnEnded` when the
  *harness* ended the turn.
- The coordinator's `abort` then skips closing the entry if the native ticket already has a wire outcome
  (`hasWireOutcome`, settled or answer observed). So `native.resolution` closes it with the real outcome
  (`consumer`/`handler`/`timeout`) and not `turn_ended`.
- `act` (the turn completing, then `endTurn` → `permissions.end`) already waits for `approvalWork`, so the real
  resolution arrives before the turn-end sweep. That's correct, and it prevents a race that would otherwise report
  an approved and dispatched tool as `cancelled`.
- **The standalone path** (handlers without a recording wrapper): the handler now gets
  `AbortSignal.any([cancelled, ticket.signal])`. A harness `approval_closed` aborts the standalone handler, which it
  didn't before, and no answer is sent once either signal has aborted. That's correct, and the stand-in test covers
  a harness-timeout close.

## The brief's step 2 gate list

| Gate | Test |
| --- | --- |
| An answer through the method | "an ACP event listener can claim one offered answer while the turn is waiting"; native: "answerPermission admits exactly one native call over stdio" |
| The timeout | "an ACP consumer timeout refuses and rejects later answers"; native: "native consumer timeout denies before the harness backstop" |
| No answerer | "an unattended ACP ask is refused even when default is allow" |
| A turn ending with a request open | Step 1's native force stop/stop/disconnect cases, and the ACP natural-return, force-stop and stop cases. My probes (interrupt, force stop, stop, stop inside a listener, a throwing listener) still give one pair each |
| The handler shortcut, with a later `answerPermission` not accepted | "handler-owned requests expose no deadline and bypass answerPermission" |
| Native over real stdio | The two native stdio tests above, plus step 1's five |
| The harness `approval_timeout` mapping (my note) | The controller stand-in test of a harness-timeout close (`8776401`) |

## Tests I ran

| Run | Result |
| --- | --- |
| Full `bun test ./test` on the `c5b10b0` archive, with `TMPDIR` on `/dev/shm` | 1,507 pass, 0 fail, 137 files, 150.5 s; typecheck clean; 35 snapshots; hash `fbc6ec2c…` |
| My step 1 probes, rerun | ACP 6/6 and native 2/2: exactly one pair each, with no replay after a reopen |
| The new answer and unattended probes | As above |

## R3 as a whole

- **Brief Done:** commits and the case for each gate are in the report, with full gates (1,506 on `8776401`, 1,507 on
  `ce5e3d5`). ✓
- **Risk** ("a request left open forever"): every entry is closed by a claim-once `close`, through the decision, the
  ticket, the abort signal, `end(turnId)` or `stop()`. Native tickets are closed by `approval_closed`, turn end,
  disconnect or stop. Neither my probes nor the suite produced an orphan.
- **Changelog:** the two events and the five sources, with `turn_ended` defined as the lifecycle close (including
  force stop and stop) and the host responder as `handler`; `answersPermissions`, `answerPermission` and its false
  cases; `permissionTimeoutMs` (default, range, consumer waits only, `expiresAt`, counted from receipt, replay
  keeping the timestamp, the harness's 10 minutes); the precedence; unbounded handlers. ✓
- **Spec:** the two paragraphs I named at grounding are corrected. The "Nothing waits forever" row (now L743) has
  the consumer wait with the harness's ten-minute backstop. "Permissions" (~L788) says the harness has its own
  ten-minute timeout, including for the host responder. ✓
- **Sizes:** `agent-session.ts` 4,565 → 4,564, `host.ts` 884 → 877, `client.ts`/`controller.ts`/manager unchanged.
  The new state lives in `permissions/conversation.ts`, `arrival.ts`, `consumer-config.ts` and `native/approvals.ts`.

## Step 1 notes that didn't land (not blocking)

1. **A local native close still doesn't send `deny`.** On detach or conversation stop, the entry resolves
   `turn_ended`, but the harness gate stays open until its 10-minute timeout or an interrupt. It isn't new (it was
   already so before R3), and it's bounded, so under triage it's accepted. It isn't documented, though. Add one
   Limitations line ("a native approval closed locally by detach or stop is not answered; the harness turn waits
   for its own timeout or interrupt"), or send `deny` from the ticket on a local close, which is a small follow-up.
2. **`permission_resolved` is emitted a microtask after the close.** It isn't in the changelog. `answerPermission`
   resolves after `result` (so after `close`), but the event itself comes a microtask later. A consumer that awaits
   `answerPermission` and then checks its own event log synchronously may not see the resolved event yet. One
   changelog sentence would cover it.
