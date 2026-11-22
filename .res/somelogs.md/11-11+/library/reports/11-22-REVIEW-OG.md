# Review — orchestrator brief G (grounding)

This review covers `0640c38` (`library/reports/11-22-REPORT-OG.md`) on `orchestrator`, against the spec at
`orchestrator-status` `87e8329`. I read it through `git show` and a clean `git archive 0640c38`
(`/tmp/clad2a-og`); I didn't check out the branch.

**Verdict: the grounding is accurate and thorough. Nothing blocks O1.** Four of its open points belong to O3a or
later and need a decision *before that brief*. One of them, the steer boundary, is a real correctness gap in
acp-client's worker-delivery code, and I confirmed it against the code.

## Checklist

### (a) The Gate 3 interface against the real signatures: accurate

I checked each row of the report against `worker-delivery-contract.ts`, `sqlite-worker-delivery.ts` and
`persisted-lifecycle.ts`:

- **`reserve`** returns `reserved | existing | conflict`, as described. `existing` doesn't prove dispatch happened, so
  it must not grant a second dispatch. That's the right reading.
- **`recordFinal` and `recordFailure`** are called by the lifecycle inside the terminal transaction
  (`persisted-lifecycle.ts:187–196`, and `271–275` for the failure path). The orchestrator must not repeat them.
- **`redirect` and `addContributingPolicies`** change pre-stage fields only (`staged_json IS NULL`) and return `false`
  afterwards.
- **`stage(id)`** is idempotent, and returns `undefined` for a live operation of the current owner.
- **Who calls `stage()`, and when:** the report says Gate 3's handoff worker does it, after the terminal commit and
  again at startup for recoverable rows. That matches the contract's comment, and it's right, with a wake-up
  `assignmentCommitted(id)` as a latency optimisation and the startup scan as the backstop.

**What's missing from the report's interface table** (for the Gate 3 owner, none of it for O1):

1. **Read-only discovery.** The contract only reads by id (`readBinding`, `readStaged`). Restart (O5b) and worker
   status (`check`, `list`) need "list unstaged or pending assignments" and "the latest outcome per worker". The
   report names the need. It should be an explicit Gate 3 deliverable with a signature.
2. **Who owns `delivered` for an ACP destination.** See "O3a durability" below.

### (b) O4's forwarding entry: an edit to `agent-session.ts` is needed

I confirmed why. `ConversationPermissions` is a `private readonly` field of `AgentConversation`
(`agent-session.ts:561`), and `answerPermission` is a one-line delegate to it (`:1911`). Nothing outside the class
can reach the coordinator. The giving conversation's `permission_requested` events must come out of *its*
`subscribe()` stream, and an answer arrives through *its* `answerPermission`. So the entry **can't live only in
`permissions/conversation.ts`**: the module has no handle on any conversation's coordinator.

**The smallest edit.** Don't add a delegate method. Change the one existing constructor line to give the coordinator
a registry key, for example `new ConversationPermissions(event => this.emit(event), () => this.log, this)` with a
`WeakMap<object, ConversationPermissions>` and a `forwardPermission(conversation, …)` function in
`permissions/conversation.ts`. That edits **one line and adds none**, so the file stays at its baseline size. The
orchestrator then calls `forwardPermission(givingConversation, …)` and the module does the rest.

**Keep the exception reviewed on its own**, as the spec says, in its own commit. The report's description of the
behaviour is right:

- the forwarded request registers in the receiving coordinator's pending map;
- the answer goes through the same claim-once path;
- the giver's own turn ending must not close it;
- a giver that doesn't answer permissions refuses at once;
- the `allow_always` filter applies to the options shown, and the same filtered list validates the answer.

**One thing to add to the spec:** `permission_requested.turnId` is required today. For a forwarded request there's no
local turn. The report suggests making it optional with the worker's turn in the source mark. Do that with a
`source` field on the event, and keep the type change backwards compatible.

### (c) O1–O5a call none of `stage`, `transitionDelivery` or the flush: holds, with one caveat

From the briefs: O1 (repository, role marker, pool, consumer API), O2 (busy rules, policy), O4 (forwarding) and O5a
(stop, drop, idle stop) touch none of them. O3a calls `reserve`, `addContributingPolicies` and `redirect` and reads
`readBinding`. None needs Gate 3's host side. **The caveat is in O3a**, below.

### (d) `workers?` holds only worker rows, schema 19, both capabilities: holds

The spec (`87e8329`) lists the worker columns and nothing about assignments. SQLite is at 18, so `workers?` is 19 with
a 18→19 upgrade and the chain from 16. The orchestrator is refused without `capabilities.workers` and without
`capabilities.workerDelivery`. **`last_conversation` is fixed:** it's now only the default destination for the next
assignment, and delivery reads the assignment's own destination. The Flow 3 table was updated too.

## The three points cod2a flagged, and the extra gap I found

| Point | What it is | Blocks O1? |
| --- | --- | --- |
| **Steering successor correlation** | **A real gap, confirmed. It's an acp-client item (worker delivery), not the harness.** See below. | **No.** It blocks **O3a** |
| **Explicit-stop and redirect notice gaps** | A **spec/worker-delivery gap**. See below | **No.** It blocks O3a (redirect) and O5a's "a stop asked by the conversation itself produces none" gate |
| **Per-invocation sender attribution** | A **note for O6** and Gate 3 | **No** |
| **O3a durability for an ACP destination** (mine) | A **spec gap** | **No.** It blocks O3a |

### Steering successor correlation (blocks O3a)

I confirmed this with the code and my own R3 probes:

- A steered ACP turn ends with status **`cancelled`**, and its terminal records carry only the original run's message
  ids. The successor run carries the steer's ids. (My R3 probe showed `afterPrompt` with status `cancelled` and `[first]`,
  then `completed` with `[a, b]`.)
- `workerTerminalFailure` already has a distinct "steered" reason (`endedBy === "steer"`,
  `worker-terminal-reason.ts:20`), but `recordFailure` **stages it as an interrupted notice anyway**
  (`sqlite-worker-delivery.ts:117–126`). Once staged, `redirect` and `addContributingPolicies` return `false`.
- The spec says a same-conversation steer *joins the running assignment*, which ends when the worker's turn ends. But
  nothing in the repository carries the assignment's causal binding to the successor run. So:
  - the **original assignment is staged as interrupted ("steered")**, and a spurious `worker_failed`-style notice is
    sent;
  - the successor's final result stages **nothing**, unless the steer message reserved its own assignment, and then
    the delegator sees two assignments for one piece of work.

**It needs a decision before O3a.** Options, simplest first:

1. **`recordFailure` skips a steer end** (`endedBy === "steer"`) so the original stays open, and each steer message
   reserves its own binding that *links to* the original assignment id. The final result then stages once, on the
   original. That needs a small `link`/`supersede` call on the repository.
2. **A transfer call** that moves the causal message binding from the original to the successor.

Either way it's a change in `persisted-lifecycle.ts` and the repository contract. That's acp-client's worker-delivery
code (the same owner as Gate 3), not the harness. The spec owner should state the intended semantic: *one assignment
spans a steer chain, with one final notice*.

### Explicit-stop and redirect notices (blocks O3a and O5a's stop gate)

- **Explicit stop.** `recordFailure` stages `interrupted` for an interrupt without distinguishing who asked. The
  lifecycle has `endedBy === "interrupt"` but no "asked by the giving conversation itself". The spec says that case
  produces no notice. To satisfy it, the orchestrator needs to mark the assignment before interrupting (a
  `suppressNotice` call), or the repository must accept a "stopped by giver" flag. **Needs an API.**
- **Redirect notice to the previous destination.** `redirect()` replaces the destination, and the old one is lost.
  `worker_redirected` must go to the previous destination, and the orchestrator can read it with `readBinding`
  *before* calling `redirect()`. A note says it does ("captured before the redirect"). That's workable, but
  the two steps aren't atomic. A crash between them loses the notice. Acceptable in v1 if documented. Otherwise
  `redirect` should return the previous destination.

### O3a durability for an ACP destination (my addition)

The report says O1–O5a never call `stage()` or `transitionDelivery`, and that O3a "delivers the independent ACP
port". So for an **ACP** destination:

- nothing marks the delivery `delivered`, so its row stays `pending` forever;
- Gate 3's native scan must **skip ACP destinations**, or it would send them to `channel/notify`. The report flags
  this too;
- a crash between the final record and the out-of-band append loses the reply, with no recovery path. O5b's restart
  gate is then undefined for ACP workers.

**Decision needed before O3a:** either (a) the ACP half is best-effort in v1 and the report says so (the reply is
also kept on the worker for `check`), with the pending row filtered by destination kind; or (b) the ACP half calls
`stage()` and `transitionDelivery(delivered)` itself, so recovery works the same way for both kinds. I'd choose
(b) if Gate 3's contract allows it, because it makes the restart story uniform.

### Per-invocation sender attribution (note for O6/Gate 3)

The callback carries no sender. The report's answer (take it from authoritative taken-item evidence, never model
arguments, and bind it to the invocation's authorization snapshot) is right. It's an **O6 concern and a Gate 3
(harness-side) design item**, with no effect on O1–O5a.

## Other points from the report, assessed

- **Worker isolation (O1 step 2).** The guard list is right. The `agent.identity.load`/`update` guards and the built-in
  `checkpoint-backed.ts` enumeration are the places to filter. **Prove it twice**, with a spy runtime *and* with the
  built-in identity from a non-worker conversation, as the report says.
- **Events.** Don't synthesize a conversation record for a worker event. Add an explicit worker-event arm to the
  observation surface. Agreed.
- **Record kinds.** The report found that `AgentActionRecord` already exists (`backend.ts`), so the spec's "no
  `agent_action` kind" is stale. The v1 decision (emit none) stands, and the spec text should be corrected.
- **Capture setting.** Requiring message capture for worker conversations is worth deciding in O1, because a completed
  prompt can otherwise omit its text, and `recordFinal` binds the latest captured assistant record.
- **Source label.** The staged source is the worker conversation id, while the design wants the handle. Persist the
  label before staging so retries use an identical payload. A Gate 3 item.
- **Baseline.** 1,509 tests in 137 files, as in R3.

## What I did not run

I didn't run the typecheck or the suite: brief G changes no code. My evidence is the code reading above.
