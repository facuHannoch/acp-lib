# Review — `beforeDispatch` fix (`acc6d5d` + `7be9456`)

I reviewed these two commits together as the hook deliverable on `native-integration-r`. I read them through
`git diff` and a clean `git archive 7be9456` (`/tmp/clad2a-bf`); I didn't check out the branch. I also wrote my own
offline probe (`/tmp/clad2a-bf/test/zz-probe/bf-probe.test.ts`).

**Verdict: my blocking finding from `0fd1e2e` is resolved. No blocking findings.** The deliverable is exactly
Cod1a's contract (`de82940`): a per-message `beforeDispatch`, and causal `messageIds` on `afterPrompt` and
`promptFailed`. Nothing else was added.

## (1) Each hook gets its own message id: holds

- ACP: `run-turn.ts` now calls `message.beforeDispatch("id" in message ? message.id : item.turnId)`. A combined
  part passes its own `id`. A single prompt passes `item.turnId`, which is that prompt's message id.
- Native: unchanged, it passes `message.id`.
- The doc comment and the types now say `(messageId: string)`.

## (2) `messageIds` on every terminal callback: holds

- `OwnedPromptTurnMessages.messageIds` is now part of both `OwnedPromptCompleted` and `OwnedPromptFailed`. It's
  filled from `turn.cause.messageIds` at both call sites.
- Cancelled and interrupted results return normally, so they reach `afterPrompt` with their status.
- For native, `runBackendTurn` passes `cause` as a **live getter**, so the ids `turn_took` adds while the turn runs
  are there when it finalizes.
- `operationId` still identifies the turn.

## (3) My probe: the hook's id is in the terminal callback's `messageIds` in every case

| Case | Hook argument | Terminal callback |
| --- | --- | --- |
| Native, single prompt | `p1` (= handle id) | `afterPrompt` op `native-turn-1`, `completed`, `messageIds [p1]` |
| Native, steer **folded** into a running turn (`turn_took`) | `p2`, `p3` (each its own id) | `afterPrompt` op `native-turn-2`, `completed`, `messageIds [p2, p3]` |
| ACP, combined steer (a + b) | `a`, `b` (each its own id, no longer shared) | `afterPrompt` op `a`, `completed`, `messageIds [a, b]` |
| ACP, a turn ended by the steer | `first` | `afterPrompt` op `first`, **`cancelled`**, `messageIds [first]` |
| ACP, interrupt during a tool (lifecycle fixture) | own id | `afterPrompt`, **`cancelled`**, `messageIds [id]` |
| ACP, hook rejects | own id | **`promptFailed`**, `messageIds [id]`, and the prompt rejects with the hook's own `Error: nope` |

I didn't probe a native turn *failing* after dispatch. That's the same `promptFailed` call site in `runTurn`, which
native turns also go through, and cod2a's checkpoint additions cover native finalization.

## (4) Contract text: holds

The CHANGELOG now says:

- each hook receives its own message id, and hooks run in message order;
- a rejection fails the whole **ACP** run, with `abandonTurn` + `turn_failed`, and the owned failure callback plus
  an error metering record still run;
- **native** awaits every hook before the first push, so a rejection fails the send before the harness creates a
  turn;
- `afterPrompt` gets `messageIds` for every terminal status, and `promptFailed` gets them too, including folded
  native inputs.

That matches the code and my probe.

## (5) Snapshots and size: hold

- No `__snapshots__` changed in `a902ccf..7be9456`.
- `agent-session.ts` is still 4,600 lines.
- On the archive: typecheck is clean; `test/conversation-turns`, `test/native/controller.test.ts` and
  `test/native/checkpoint.test.ts` give 163 pass, 0 fail.
- I didn't run the full suite.
