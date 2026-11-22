# Review — the `beforeDispatch` hook

This review covers `acc6d5d` on `native-integration-r` (parent `a902ccf`). I read it through `git diff` and a clean
`git archive` copy (`/tmp/clad2a-bd`); I didn't check out the branch. I also ran my own probe
(`/tmp/clad2a-bd/test/zz-probe/bd-probe.test.ts`, offline: the scripted native rig and the ACP steer fixture).

**Verdict: blocking for Cod1a's keying, (2).** On native, the hook's argument is a *different identifier* from the
`operationId` that `afterPrompt`/`recordFinal` receives, so a binding keyed by the hook's argument can't be found at
`afterPrompt`. Points (1), (3) and (4) hold.

## (1) The ACP path: holds

In `run-turn.ts`, phase 4, before `ctx.supervisedPrompt(…)`, which is what calls `prepareTurn` and the provider,
the hook loop runs `for (const message of item.parts ?? [item]) await message.beforeDispatch?.(turnId)`. It's
gated on `sent`, so it runs only for a turn that carries submitted messages, not a backend-only one. Phase 1, the
Agent-owned `beforePrompt` with its durable user record, has already completed by then.

`dispatchedAt` moved below the hook, so it still marks the real dispatch time.

The test "beforeDispatch awaits the durable prompt and runs before prepareTurn" pins the order.

## (2) Is `operationId` the same identifier on both paths? **No: blocking**

My probe compared what the hook receives, the handle id, and the `operationId` seen by `afterPrompt` and the result:

```
NATIVE {"hook":["mwrl005qjsqy"],"handle":"mwrl005qjsqy","resultOperationId":"native-turn-1"}
ACP    {"hooks":["first:mwrl00thajlo","a:mwrl00wi9de3","b:mwrl00wi9de3"],
        "first":"mwrl00thajlo","a":"mwrl00wi9de3","b":"mwrl00wjbmyo",
        "resultOps":["mwrl00thajlo","mwrl00wi9de3"],"afterPromptOps":["mwrl00thajlo","mwrl00wi9de3"]}
```

- **ACP: the identifiers are consistent.** Each hook gets the run's `turnId`, which is exactly `afterPrompt`'s
  `input.operationId` (`run-turn.ts:247`). In a combined run, message `b` gets `a`'s id (the shared operation), not
  its own handle id `…wjbmyo`. A consumer keyed by operation id finds its binding. A consumer keyed by handle or
  message id would miss `b`.
- **Native: the identifiers differ.** The hook gets the *message* id (`controller.ts`, "the harness assigns turn ids
  after acceptance"), but `afterPrompt` and the result see the *harness turn id* (`native-turn-1`). Nothing in
  `OwnedPromptCompleted` carries the message ids that turn took, so Cod1a's `recordFinal` can't connect the
  binding it wrote in the hook to the turn that finishes.

So the two paths currently pass different kinds of identifier, and on native neither kind lets the hook and
`afterPrompt` meet.

**The fix I recommend (small, and it works for both paths):**

1. **The hook always receives its own message's id.** ACP passes `message.id` from `item.parts ?? [item]`
   instead of `turnId`, the same as native already does. For a single-message ACP turn, `message.id === turnId`,
   so only combined runs change.
2. **`OwnedPromptCompleted` (and `promptFailed`) gain `messageIds: readonly string[]`.** These are the turn's
   cause message ids, which the session already tracks (`cause.messageIds`, including folded `turn_took` ids for
   native). Then Cod1a keys bindings by message id and resolves them at `afterPrompt` through `messageIds`. That
   holds on ACP, on native, and in combined or folded runs.

Native can't do it the other way round, keying by turn id, because the harness assigns the turn id only after the
push, and the hook has to run before it. So message-id keying is the only design both paths can share.

**Cod1a and the spec owner should confirm the keying before this merges.** If Cod1a's worker delivery is ACP-only
for now, the current ACP behaviour works on its own, but the native difference should then be documented and
kept out of the public doc comment's promise. Today that comment says "Combined ACP messages receive the shared
operation ID. Native inputs receive their own message ID."

## (3) One rejection fails the whole run, with no dispatch: holds

- **ACP.** The hooks are awaited in order. A rejection sets `hookInProgress`, goes through the shared pre-dispatch
  failure path, and then `if (hookInProgress) throw err`, so the caller gets the hook's own error and not an
  `AgentSessionOperationError` wrapper. The session's failure-before-dispatch path then calls `abandonTurn` and
  emits `turn_failed`.
  - The test "combined steer awaits hooks in message order and one rejection fails the whole run" holds the first
    hook on a gate. It checks that `prepareTurn` was called only for the earlier turn, that both steer handles
    reject with the second hook's error, that the hooks ran in order, and that there's an `abandonTurn` and a
    `turn_failed` for the run.
  - Minor, and acceptable: the shared failure path also writes a `promptFailed` record, an error assistant
    transcript entry, and an `"error"` metering record for an operation that never dispatched. That's how any
    failure before dispatch is recorded today. Cod1a should know the turn shows up as failed in history.
- **Native.** Hooks run after the media preflight and before `start()` and any push. `#stopped` is checked again
  after the hooks, since they may take a while. The test "a later native dispatch hook rejects the run before
  pushing any inputs" checks that m2's rejection leaves no pushes, no submissions and no turns, and that both hooks
  ran in order.
  - Contract difference: on native, a rejected hook rejects `send`, which is an acceptance failure. A native turn
    is started by the backend, so there's no `turn_started`, and so there's no `abandonTurn`/`turn_failed`. That's
    consistent with native's existing "acceptance rejection with no started turn" in conformance. The contract
    text ("abandonTurn and turn_failed") should say "on ACP".

## (4) Line count and snapshots: hold

- `agent-session.ts` is 4,600 lines (4,604 before). The `consumerMetadata` snapshot and `promptInputText` moved out
  to `record-helpers.ts`/`media/parts.ts` to make room.
- No `__snapshots__` file changed in `a902ccf..acc6d5d`.
- The CHANGELOG has entries for the hook.

## Not run by me

I didn't run the typecheck or the full suite. Both probe cases passed.
