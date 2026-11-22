# Review — R3 step 0 grounding

This review covers `757e062` (`library/reports/11-22-REPORT-R3-grounding.md`) on `native-integration-r`, at
`928f865`. I read it through `git show` and the code at that base.

**Verdict: the grounding is accurate, and the single-coordinator design does close every path. No blocking
findings on the grounding.**

- My five points are all covered.
- (a) No harness change is needed: receipt by the host is enough, if it's stamped in the right place.
- (b) It's a behaviour change for ACP handlers, consistent with the spec's wait budget. It's the user's decision.
- (c) Acceptable.
- (d) Confirmed. The two paragraphs are named below.

I'm also raising one new point that needs a decision: **step 3 of "Decision and deadline" lets an unattended `ask`
fall back to an `allow` default.** That turns an `ask` rule into an automatic approval.

## My five points

| My point | The grounding |
| --- | --- |
| (1) Two native routes | Covered. One ticket per harness request is shared by the host responder and the channel port. It's reserved to the responder when one is configured. When the request is drained into a running conversation, `permission_requested` is emitted from that ticket whichever route answers it. If the responder already closed it, the requested event is followed by its saved resolution. There's no second RPC. Channels that never reach a conversation stay responder-only, with no events, which is acceptable: there's no conversation to emit to. |
| (2) Replay on reopen | Covered. A seen-and-closed marker per (channel, harness request id) is kept for the turn's whole delivery lifetime, beyond `#approvalSignals`. Public ids stay stable across observation replays, and the deadline isn't reset. |
| (3) Closes from the harness | Covered. `approval_closed` reasons map to an explicit resolved state, with `approval_timeout` → `timeout`. A local claim and a close race through one claim-once point, and the loser is rejected. An external denial or dispatch with no local claim maps to `consumer`. |
| (4) ACP closes | Covered. These all go to the same entry with `turn_ended`: the request-level abort from `client.ts`; a new cancel when the provider prompt returns, in its `finally`; the turn scope closing in `run-turn.ts` (needed because the supervisor's force stop can release the operation before transport teardown); and conversation stop. The handoff recap path is covered too. |
| (5) `by` values | The five values are kept. Responder → `handler`; force stop and stop → `turn_ended`. See (c). |

A useful detail cod2a found: native's `handlersOf` picks the first *handlers object*, even one with only stream
handlers. R3 should pick the first *permission* handler separately, and capture it when the turn starts, before
`turn_took`. That matches the spec's "doesn't change its permission handler".

## (a) Native `requestedAt`

**Is it a harness wire change?** Yes. The wire `ApprovalRequest` (`native-harness/src/contracts/config-permissions.ts:27–34`)
is `{ requestId, channel, turnId, toolCallId, tool, arguments }`, with no time field. Adding `requestedAt`, including
in `channel/observe`, changes the harness's protocol contract. That's haurness-l's protocol, and it's outside R3,
which doesn't list harness changes.

**Is receipt by the host enough?** **Yes, provided it's stamped at the host's ingress**, not when the controller
drains the request. The harness can only have an approval open while a consumer is connected:

- without a declared consumer, `gate.ts` refuses with `approval_unhandled` and publishes nothing;
- `disconnect()` closes every pending approval with `approval_disconnected`.

So every `approval_requested` reaches the host's ingress (`#deliver` and the responder at `host.ts:194`, whether or
not a channel is attached) within transport latency of being created. No request survives a disconnect, so a replay
after a reconnect can't bring back a request created earlier. The observation replay at attachment (`host.ts:230–253`)
re-sends requests the host has *already* stamped, provided the stamp is kept by request id.

The error is milliseconds. Our 5-minute clock runs inside the harness's 10 minutes, so ours always fires first.

**Recommendation:** don't add `requestedAt` in R3. Stamp at the host's ingress, keyed by request id, and keep the
stamp across replays. Document that a held request's `expiresAt` is counted from that receipt. If haurness-l adds the
field later, prefer it when present.

## (b) Should the deadline bound handlers too?

**It's a behaviour change for ACP handlers.** Today an ACP `onPermissionRequest` can take as long as it likes, and the
provider just waits. With the bound, a handler still unanswered after `permissionTimeoutMs` is refused
(`by: "timeout"`). Consumers that put a human dialog behind the handler, or a slow external check, would see
refusals after 5 minutes.

**For:**

- the spec's "Nothing waits forever" table (L739) lists *a permission request*, with no exception for handlers;
- native handlers are already bounded by the harness at 10 minutes;
- one deadline gives every request a meaningful `expiresAt`.

**Against:** the brief describes the handler as a shortcut ("nothing waits on events") and only bounds the consumer
wait.

**Recommendation:** bound handlers on both kinds, because it's consistent and follows the wait budget. Record it as a
breaking or behaviour change in the changelog, and let `permissionTimeoutMs` raise it. That's the **user's decision.**

**The host responder isn't per-conversation.** It runs at the host with no conversation config, so
`permissionTimeoutMs` doesn't apply to it. Either leave it bounded by the harness's 10 minutes, or add a host-level
option. Decide that explicitly; don't borrow a conversation's value.

## (c) Mapping the responder and stops: acceptable

- **Host responder → `handler`:** acceptable. Like a prompt handler, it's a programmatic answerer the consumer
  supplied and configured ahead of time. A UI needs to know the request closed and that it wasn't the person at the
  dialog, and `handler` says that. A distinct `responder` would be more precise, but the brief fixes five values,
  and adding one is cheap later.
- **Force stop and stop → `turn_ended`:** acceptable. A dialog has to close either way, and the conversation's own
  stop and terminal events say why.
- **Wording to document:** `turn_ended` will also cover native closes where the turn *continues*: suspension,
  disconnect, tool revoked, a turn later resumed. The changelog should define it as "closed by the turn's lifecycle,
  not by an answer", not literally "the turn ended".

## (d) The harness arms its ten-minute timer while connected: confirmed

`native-harness/src/governance/permissions/gate.ts`:

- `createApprovalService(publish, timeoutMs = 600_000, …)`;
- with a declared consumer, every request does `timer = setTimeout(() => close(entry, "approval_timeout"), timeoutMs)`
  (~L48), whether or not a host is connected;
- `disconnect()` closes all pending approvals at once.

**The two spec paragraphs that contradict it**, in `11-11-SPEC-native-harness-integration.md`:

1. **"Nothing waits forever"** (the section heading is at L722), the table row "A permission request" (L739): "…
   while a host is connected the harness's gate has no limit of its own".
2. **"Permissions"** (L751), the bullet "When nobody will answer" (around L778–782): "**acp-client owns the
   timeout:** while a host is connected, the harness's gate waits for the host's answer with no limit of its own;
   its own timeout applies only standalone or after the host disconnects."

The 2026-11-21 note in the same section (L724) and Brief R3 (L167, L175) already describe the 10 minutes correctly.

**For the spec owner:**

- change both paragraphs to say the harness keeps its 10-minute backstop while connected, with acp-client's
  `permissionTimeoutMs` inside it;
- "after the host disconnects" should become "a disconnect closes pending approvals at once".

## New point, needing a decision: an unattended `ask` falls back to the default

"Decision and deadline", step 3: *"With an ask and no declared answerer, apply the setting's default immediately …
when an ask rule or callback overrode an allow or deny default."*

That follows the spec literally ("if not, the permission setting's `default` applies at once"). But with
`permissions: { default: "allow", rules: { "command:rm -rf build": "ask" } }`, a conversation with no answerer would
**auto-approve** exactly the command the user marked for asking. R2 refuses it. The step would turn a protective
`ask` rule into an `allow`, and that's a weakening.

**Recommendation:** an unattended `ask` refuses (`by: "default"`), as R2 does, whatever `default` says. The spec's
point, that a consumer that never listens doesn't stall every ask, is still met, because the refusal is immediate. If
the spec owner really intends the fallback to the default, make it an explicit option, and don't enable it by
default. That's a **user/spec-owner decision.**

## The rest

- **Validating `permissionRule` returns** (my R2 note): agreed. A typo raises a configuration error, fails closed, and
  still closes the request.
- **Configuration:** `answersPermissions` (default false) and `permissionTimeoutMs` (default 300,000) on create, open
  and defaults, validated positive and below the harness's 10 minutes. That's fine. Add a test that a value ≥ 600,000
  is rejected.
- **`answerPermission`:** the method is asynchronous for native, since it waits for the RPC acknowledgement. ACP
  acceptance means claiming the slot locally. `{ accepted: false }` covers an unknown, closed, expired or
  handler-owned id, a wrong option, and a race. All fine.
- **Size:** the baseline is recorded. The coordinator is extracted out of the large classes first. Good.
