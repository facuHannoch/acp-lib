# Review — orchestrator brief O4 (permission forwarding)

This review covers `efb3aae..fc6a922` on `orchestrator`:

- `ea33f22`: the coordinator bridge, the one-line `agent-session.ts` change;
- `8da9dc7`: the worker routing;
- `a7f0bbd`: the persistent-grant option rules;
- `fc6a922`: the report.

I read them through `git diff`/`git show` and a clean `git archive fc6a922` (`/tmp/clad2a-o4`); I didn't check out the
branch. I wrote my own probes (`test/zz-probe/o4.test.ts` in that archive).

**Verdict: O4 meets its brief. No blocking findings.**

- **Full suite on the archive:** typecheck clean, **1,538 pass, 0 fail, 143 files**, 35 snapshots; the characterization
  hash is still `fbc6ec2c…`.
- **Zero-or-two hunt:** I tried to leave a forwarded request without a `permission_resolved`, or to give it two. Every path
  I could reach gave exactly one of each (table below).
- Four notes, none blocking.

## (1) The bridge (`ea33f22`)

- **One changed line in `agent-session.ts`, no growth.** The existing constructor line now reads
  `new ConversationPermissions(event => this.emit(event), () => this.log, this, () => this.controllerDefaults)`. The
  file is **4,564 lines before and after**. `agent.ts` has one changed line (it hands the orchestrator a finder for the
  giving conversation) and `conversation-manager.ts` gains 5 lines (1,076 → 1,081, under its 1,085 baseline).
- **The registry is a module-level `WeakMap<object, {coordinator, policy}>`** in `permissions/conversation.ts`. An entry
  lives only while its conversation does, so nothing leaks, even though the value refers back to the key.
- **A conversation that isn't registered can't be reached.** `forwardPermission` looks the conversation up and, if
  there's no entry (or `undefined`), answers with the deny selection and emits nothing: it fails closed.
- **It isn't exported from the package entry.** `index.ts` exports only the *types* (`WorkerPermissionSource`).
  `forwardPermission` is imported by `orchestrator/permissions.ts` alone, so a consumer can't inject a forwarded request
  into a conversation.
- **The event type changed compatibly.** `permission_requested` is now a union: either a required `turnId` (and no
  `source`), or an optional `turnId` plus a `source: { kind: "worker", handle, conversationId }`. A forwarded request has
  no local turn.

## (2) The level, and allow and deny at once

`workerPermissionHandler` is passed with each prompt. It computes `matchWorkerPermissionLevel(request,
actor.workerPermissions)` (the composition I reviewed at O2, on R2's matcher). Allow and deny return
`selectPermissionOutcome` at once: `allow_once`, else `allow_always`, else cancelled; deny is `reject_once`, else
cancelled. The tests show the worker receives the exact option, and the giving conversation's event list stays empty.

The worker conversations are opened with `permissions: { default: "ask" }` and a `permissionRule` that always returns
`ask`, so every request reaches that handler. Anything the handler doesn't answer is an unattended ask, which refuses.

## (3) Ask: forwarded, answered, closed exactly once

The forwarded request registers in the giver's own coordinator (the same `request()` path as R3, with the level forced to
`ask`), so it uses the giver's `answersPermissions` and `permissionTimeoutMs`:

- **Answer:** `giver.answerPermission(id, optionId)` claims it; the worker gets that option.
- **Timeout:** refused as `timeout`, from the worker's ingress timestamp (copied onto the filtered request).
- **Headless giver:** refused at once as `default`; the pair is still emitted.

**My probes** (permission fixture as the worker, an echo conversation as the giver with `answersPermissions: true`):

| Case | Giver's events |
| --- | --- |
| The worker is stopped while the ask is open | `requested`, `resolved:turn_ended` ✓ one pair |
| The giver's **own** turn starts and ends while the ask is open | stays open ✓ (`end(turnId)` skips entries without a turn); then two racing answers (`allow`, `reject`): one `accepted`, one not; `requested`, `resolved:consumer` ✓ |
| The giver is stopped before the worker asks | refused at once, no hang, the worker goes idle, no events on the giver ✓ |
| The giver is stopped while the ask is open (their test) | `requested`, `resolved:turn_ended`; the worker gets `cancelled` ✓ |
| A redirect while an ask is open | see note 1; one pair on each giver ✓ |

The paths that close a forwarded entry all go through `entry.close`, which is guarded by deleting the entry from the pending
map: the answer, the timer, the worker's abort signal, and the giver's `stop()`. The worker keeps its own records and its own
event pair, so there are two pairs, one per conversation, each complete.

I didn't probe a replay: that's a native concept (an observation replaying an approval), and workers are ACP only.

## (4) Persistent grants

`includeAllowAlways: actor.isOwner === true`. For a non-owner, `allow_always` options are removed from the request
**before** it's published, and the same filtered list validates the answer. The test shows the option isn't in the event,
`answerPermission(id, "always")` gives `accepted: false`, and a valid option still works afterwards. For the owner it's offered
and accepted. **Automatic allow is unchanged:** with the level `allow` and a provider that offers only `allow_always`, the
worker gets `always` (the auto-approve rule). The event carries no `raw` packet, so the stripped options don't leak through it.

## (5) The worker's abort signal and a turn ending

The forwarded request listens to the worker request's abort signal. The worker coordinator aborts it when the worker's turn
ends, is interrupted, or is stopped, and `AcpClient` cancels pending requests when a prompt returns. My worker-stop probe
confirms it closes once.

## (6) Boundaries

Nothing changed under `src/native`, `src/persistence` or `src/native-harness`. `orchestrator/` calls none of `stage`,
`transitionDelivery`, `reserve` or a flush. O4 touches the worker row only through O1's repository.

## Notes (none blocking)

1. **After a redirect, an already-open ask stays with the previous giver until it resolves.** I opened an ask from giver A,
   then B redirected the worker. A's ask stayed open (a steer takes effect at a boundary, and an unanswered permission isn't
   one). After A answered, the successor run's ask went to B: A had `[req, res:consumer]` and B `[req, res:consumer]`.
   There's no zero or two, and the wait is bounded by `permissionTimeoutMs`. But the previous owner holds the worker's
   progress. Worth a sentence in the spec's Flow 2 or Limitations.
2. **Consumer-opened workers refuse every ask.** For `actor.kind === "consumer"` the handler returns the deny selection
   whatever the level would be, because a consumer actor has no `workerPermissions`. The spec says the consumer API
   "bypasses policy", so a consumer might expect its own workers to be able to run tools. Decide whether consumer work
   should use a configured default for workers, or whether refusing is intended. It fails closed, so it's safe.
3. **`isOwner` is attested by the caller**, not derived from the policy names. O6's route has to set it from the harness
   names, and the spec should say which name means owner, or the `allow_always` filter depends on a flag nobody sets.
4. **No changelog entry yet.** `CHANGELOG-controller-interface.md` is untouched, but `permission_requested.turnId` is now
   optional in the public event type (consumers who read it as a string must narrow on `source`) and `WorkerPermissionSource`
   is a new export. Add a line before release.
- **Baseline:** 1,538 tests, up from 1,529.
