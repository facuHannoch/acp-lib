# Review — the O5a follow-up and orchestrator brief O6 step 1 (the delegation route)

This review covers `c092af6..3117847` on `orchestrator`:

- `20af857`: the O5a follow-up;
- `d0a927b`: O6 step 1;
- `3117847`: the report.

I read them through `git diff`/`git show` and a clean `git archive 3117847` (`/tmp/clad2a-o6a`); I didn't check out the
branch. The spec is the latest `orchestrator-status`. I wrote my own probes (`test/zz-probe/o6a.test.ts`,
`zombie.test.ts` in that archive).

**Verdict: both meet their briefs. No blocking findings.**

- **Full suite on the archive:** typecheck clean, **1,549 pass, 0 fail, 144 files**, 35 snapshots; the characterization
  hash is still `fbc6ec2c…`.
- **The route's authority comes only from the call's frozen policy names**, and every case I probed matched the spec.
- Three small notes (below).

## (1) The O5a follow-up (`20af857`): done

- **A drop of a zombie not yet noticed succeeds.** `drop` reads the row without reconciling, then reconciles: if the
  conversation is gone it tombstones the row, releases the slot, emits one `worker_dropped`, and returns
  `{ providerDeleted: false, checkpointsDeleted: 0 }`. **My probe:** delete a live worker's conversation directly, then
  `workers.delete("w1")` as the first call: it returned that result; a second `delete` said "unknown active worker"; `list`
  showed only `w2`; exactly one `worker_dropped`.
- **The O5a changelog** has a "Worker shutdown" section: `workers.delete` returns a `DeleteConversationResult`,
  `workers.idleStopMs` (default 10 minutes, `false` off), and the `idle` stop reason. It's accurate.
- **My two O4 lines are in:** "`turnId` is optional only on a request with a worker source; ordinary requests require it", and
  "forwarded asks shown to a non-owner hide `allow_always` and reject it as an answer".

## (2) O6 step 1 against the brief

### The tools and the catalog

`withDelegationTools` adds `delegate`, `check`, `list` and `stop` as `group: "fixed"` to the native functions config, only
when both the harness and the orchestrator are configured (`agent.ts`). The existing function host already declares handler
names in `initialize` and supplies the catalog on `session/create` and `session/open`, so nothing else was needed.
`delegate` opens a worker when `worker` is omitted and sends to it when given; `assignment` or `redirect` without a worker is
`invalid_arguments`.

**Collisions:** a consumer tool using any of the four names makes `Agent` construction fail with "native delegation tool name is
already registered: stop"; the consumer's other tools are kept (probe: `mine,delegate,check,list,stop`).

### The actor built from the call, probed

I built synthetic callback contexts against a **real** orchestrator and the production route:

| Case | Result |
| --- | --- |
| An unknown policy name, alone or beside a known one | declined, `delegation_policy_unknown` |
| A two-policy turn, `owner` + `guest` where guest has `use: false` | declined, `delegation_policy_denied`: the most restrictive wins |
| The same turn with two allowing policies | `sent` |
| A callback with no `policyNames` field | declined, `delegation_policy_unknown` |
| An explicit empty list, defaults unconfigured | `delegation_policy_denied` (unconfigured defaults refuse use) |
| An explicit empty list, defaults configured | proceeds as a non-owner with the configured defaults |
| No giving conversation, or a channel that isn't a conversation id | `delegation_conversation_unavailable` |
| No `takenSender` lookup (production today) | `delegation_sender_unavailable`, an explicit decline |

- **Owner needs every name.** `["owner"]` → `isOwner: true`; `["owner", "trusted"]` → `false`; `[]` → `false`. With
  `ownerPolicies: ["trusted"]`, `trusted` is the owner and `owner` isn't.
- **The actor's `invocationId` is the call's id**, and the composed delegation policy and the per-policy worker
  permissions come from the O2 helpers (most restrictive; each policy's own default).
- **Model arguments play no role.** I passed `{ text, sender: "mallory" }` to `delegate`: the actor's sender was still `alice`
  (from the lookup), because the handler never reads a sender argument, and the harness schema has
  `additionalProperties: false` anyway.
- **Errors are mapped.** A `WorkerPolicyError` becomes `FunctionError("delegation_policy_denied")`. Other errors (for example
  an unknown worker) pass through with their message.

### The sender: sound

`takenSender` reconciles the call's own channel and turn, requires the turn to be `running`, takes the **first item in
the turn's recorded order**, reads that item, and requires its channel and turn to match and a stored `sender`. My probe:

| Situation | Result |
| --- | --- |
| Alice's input first, Bob's second | `alice` |
| A turn taken only from a notice | the notice's stored source (`w1`) |
| The turn isn't running | declined |
| No items | declined |
| The item belongs to another turn, or the channel differs | declined |
| The item has no sender | declined |

**Why I think it's sound.** The first taken item of a turn never changes once taken, so the answer is stable even if more
inputs arrive during the turn. Every case that can't be established from the harness's own records declines, so it fails
closed. And **authority never depends on the sender**: it comes from the call's frozen `policyNames`, which are the union of
all contributors for the turn, composed most restrictively. So in a turn that took Alice's then Bob's input, the worker task is
*attributed* to Alice (its participant), but Bob's policy still limits what the call may do. For a notice-only turn the
attribution is the notice's source label, which is fine for display; just make sure a source label can't collide with a real
participant id (see notes).

### Production without the hook

`takenSender` is an optional third argument of the function host's `call` and an optional field of the context; other tools
ignore it. **Nothing breaks without it:** every native delegation call declines with `delegation_sender_unavailable`, as
cod2a says. `host.ts`, `channel-changes.ts` and the persistence files are untouched; `src/native/functions.ts` is the only
native file (a small change); `agent-session.ts` is untouched.

### The end-to-end test

cod2a's in-process-harness test, which is in the suite, runs a two-policy turn (an owner message plus a guest notice) through
the real harness, with a stand-in callback supplying `takenSender`. It checks the catalog, all four tools, the combined
policy names, and attribution to Alice.

## Notes (none blocking)

1. **The tool descriptions are thin.** `delegate` explains the open/send split, "a busy send continues the running
   assignment", `assignment: "new"` and `redirect`. It doesn't say what the results mean (`sent`, `steered`, **`busy`: nothing
   was sent and nothing is queued**, `no_worker_free` with its listing), what `about` is for, or that the call returns at
   once and the reply arrives later. The spec says the guidance lives in the descriptions, and a model decides how to use
   `busy` from them. Add a sentence on results. `check`, `list` and `stop` are one line each.
2. **`stop` always answers `{ status: "stopped" }`**, even if the worker was idle. The orchestrator's `stop` returns nothing, so
   the tool can't say whether it interrupted anything. Make it return a real outcome (`stopped` or `idle`).
3. **A notice's source label is used as a participant id.** For a notice-only turn the sender is the notice's source (for
   example a worker handle such as `w1`), and `promptFrom` uses it as the worker prompt's participant. If a real
   participant could have the same id, the two would merge in the worker's records. Namespace it (for example a
   `notice:` prefix), or confirm the harness's source labels can't clash.
- **Baseline:** 1,549 tests, up from 1,546.

## Follow-up: `7087637` (tool results, stop outcome, sender labels)

(a) and (b) are resolved. **(c) is mostly resolved, but I produced one collision**, which needs a small fix.

I merged alpha (`0003f20`, worker delivery) into `orchestrator-reviews`, then ran a clean `git archive 7087637`
(`/tmp/clad2a-o6b`): typecheck clean, **1,550 pass, 0 fail, 144 files**, 35 snapshots, hash `fbc6ec2c…` unchanged.

**(a) Tool descriptions: done.** `delegate`'s text now says what `about` is for ("a short label for check and list"), that the call
"returns immediately without waiting for the worker's reply", and what each outcome means: `sent` (accepted for a new run, with a
handle when opening), `steered` (a busy worker accepted the input), `busy` ("nothing was sent or queued") and `no_worker_free`
("no slot is available and nothing was sent or queued"). The `stop` description says what it returns.

**(b) `stop`: done.** `Orchestrator.stop` returns `"stopped"` after an interruption and `"idle"` if there was nothing to stop, and the
tool returns that as `{ status }`. **My probe** (the production tool handler on a real worker): a stop on an idle worker gave
`idle`, on a busy worker `stopped`, and the **consumer API still returns `undefined`**.

**(c) Sender labels: one collision.**

- **The change.** A native item that isn't a `participant_message` (a channel or external notice) is labelled `notice:<source>`.
  A participant whose id begins with `notice:` or `participant:` is escaped to `participant:<id>`. I confirmed the
  `ItemKind` literals match the harness types.
- **For exact prefixes it's collision-free.** The mapping is one-to-one: participant ids never come out starting with
  `notice:`, and escaped ones always start with `participant:`. My probe: a participant `notice:w1` becomes
  `participant:notice:w1` (not `notice:w1`), `participant:w1` becomes `participant:participant:w1`, and channel and external
  notices both give `notice:w1`.
- **The collision I produced.** The prefix test runs on the **untrimmed** sender, but the worker prompt's participant is
  trimmed downstream (`promptFrom` uses `participantId.trim()`, and a leading non-breaking space is trimmed too). A participant
  sender `" notice:w1"` (a leading space) passes through unescaped, then becomes `notice:w1`, **identical to a real notice
  label**. End to end, the worker conversation recorded participant `notice:w1` for *both* the real notice and the
  space-prefixed participant. The same works with ` notice:w1` and, symmetrically, `\tparticipant:w1`.
- **How realistic.** acp-client trims participant ids when it pushes them itself, so this needs an item that reached the
  harness with an untrimmed sender (a direct `nativeHarness.push`, or another host). Low likelihood, but it defeats the guarantee the
  change set out to give.
- **Fix (one line).** Trim before testing the prefix, and return what the downstream will see:
  `const id = item.sender.trim();` then `if (!id) throw …` and the same `startsWith` checks on `id`. Add a test with a
  leading-space and a leading-NBSP sender.

## Follow-up: `0e9c79b` (the sender-trim fix) and `41a225d` (the production host hook)

Both resolved. No blocking findings. The branch tip is `0e9c79b`, which sits on top of `41a225d` (alpha `0003f20` merged at
`1c5829a`). A first run on a `41a225d` archive still showed my old collision, because the trim fix is the later commit, so I
reran everything on the tip. Clean `git archive 0e9c79b` with `TMPDIR` on `/dev/shm`: typecheck clean, **1,565 pass, 0 fail,
146 files**, 35 snapshots, characterization hash `fbc6ec2c…` unchanged.

### (1) The trim fix: collision gone

`takenSender` now trims the sender first, declines if it's blank, and runs the notice-prefix escaping on the **trimmed** id.
**My collision cases, on the tip** (a real notice from source `w1` is labelled `notice:w1`):

| Sender | Kind | Label | Distinct from `notice:w1`? |
| --- | --- | --- | --- |
| `notice:w1` | participant | `participant:notice:w1` | yes |
| leading space, NBSP, tab, newline+space, BOM or U+2028 `+ notice:w1` | participant | `participant:notice:w1` | yes (all trimmed, then escaped) |
| `  participant:w1  ` | participant | `participant:participant:w1` | yes |
| only whitespace (`"   "`, `"\t\n"`, NBSP) | participant | **declined** (`delegation_sender_unavailable`) | n/a |
| Cyrillic `о` in `notice`, fullwidth `ｎ`, capital `N` | participant | left as is, a different string | yes |
| `w1`, or `  w1` | channel or external notice | `notice:w1` | the label itself |

**End to end:** the worker conversation recorded participant `notice:w1` for the real notice and `participant:notice:w1` for
both the leading-space and the leading-NBSP participants. The tests in the commit cover plain, space, NBSP and tab senders
through the production host path.

Two harmless equivalences remain: notices from sources differing only by surrounding whitespace share a label, and a
participant id with and without surrounding whitespace is one participant, which is how the downstream trim already treats it.
One quirk: **a zero-width space (U+200B) isn't trimmed by JavaScript**, so an id made only of U+200B passes as a non-blank id.
It can't collide with `notice:`, but it's an invisible participant id; treating U+200B-only ids as blank would be tidy.

### (2) The production host hook

**The change is the only `host.ts` change, in one region.** `git diff 0003f20 0e9c79b -- src/native/host.ts` is one import and the
`serveFunctions` call (916 lines, up from alpha's 914). It leaves Cod1a's worker-delivery flush hooks, `channel-changes.ts` and
the persistence files alone. The hook is
`() => takenSender(client, call.channel, call.turnId, signal)`, where `client` is the one `#open` received for this connection.

**Probed on the real in-process harness** (two connections to one harness home, a scripted model that delegates on each turn):

| Case | Result |
| --- | --- |
| **A callback arriving before `#connection` is installed** | covered by cod2a's test, which forces the harness to finish the callback during open |
| **Reconnect:** stop the host, restart, a second input from another sender | 2 connections; the delegations arrived with senders `alice` then `bob`; reconcile calls per client `[2, 2]`, and **client 0's count stayed at 2** after the restart, so each connection uses its **own** client |
| **A callback in flight when the host stops** (the sender lookup held, then `stop()`) | nothing reached the orchestrator, **0 worker rows**, 0 unhandled rejections: it fails closed |
| **No leak:** hold only a weak reference to the first connection's client, stop, restart, force GC | the **first client was collected**, the second alive |

A call delivered over an old connection after a reconnect would try its own (closed) client and its aborted signal, and decline.

### Notes (none blocking)

1. **Layering.** `src/native/host.ts` now imports `takenSender` from `src/orchestrator/`. It's a harness query (reconcile a
   channel), so it fits better under `src/native/`, with the orchestrator importing it. There's no import cycle, and the thunk
   is lazy, so tools that don't use it pay nothing.
2. **A U+200B-only sender** (above).
