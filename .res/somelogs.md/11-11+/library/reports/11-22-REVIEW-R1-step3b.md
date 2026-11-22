# Review — R1 step 3b: persisted controller kind

This review covers implementation `f0e589a` and report `e701ba0` on `native-integration-r` (diff
`64060fa..e701ba0`). I read them through `git diff` and clean `git archive` copies; I didn't check out the branch.

**Verdict: no blocking findings for the design.**

- The persisted kind closes all three orphan cases, and the new tests fail on `64060fa`.
- The kind matches the factory's binding decision.
- The refusal covers every entry point and both directions.
- **One should-fix (cheap):** a database already at the *pre-amendment* schema 17 breaks with a hard error the
  first time a conversation is created. I reproduced it. The migration's column check should run on every open,
  not only when upgrading from below 17.

## The orphan cases: covered, and the tests fail on `64060fa`

I took the `f0e589a` tests with `64060fa`'s `src`, and ran `checkpoint.test.ts` and
`persistence-sqlite-backend.test.ts`: 57 pass, **5 fail**. The failures:

- "a native row with **an acknowledged intent** survives restart with enough identity to retire". That's cod2a's
  case.
- "… with **a pending intent** …". That's my case (i).
- "… with **no initial settings** …". That's my case (ii).
- "switch and handoff across controller kinds refuse before records or transition events".
- the v16 upgrade test, which now also checks the column.

"a legacy row with an active native descriptor still retires after restart" passes on both commits. That's
expected, because it pins the fallback.

**How delete decides now.** `deleteConversationWithChannel`'s `classify` reads `scope.conversations.get(id)?.controllerKind`
**inside the delete transaction**:

- `native` → it writes the retirement;
- `acp` → it skips the descriptor lookup unless the provider session is `best-effort`;
- absent (a row from before the change, or a backend that doesn't store the kind) → the old descriptor/live
  fallback.

`deliverCommitted` now takes `deliver(result)`, so the host flushes only when `retired` is true. An ACP delete under
a running harness no longer touches the channel queue's delivery. The no-capability path classifies through the
root repository and keeps the old order.

## Amending 17 in place: should fix

- `CREATE TABLE conversations` includes `controller_kind`, so a fresh database is fine.
- The upgrade from 16 adds the column inside `if (version < 17)`, using a `PRAGMA table_info` check.
- **A database already at the pre-amendment 17** (created by `61ecd21`–`64060fa`) records version 17, so that
  branch is skipped. It ends up without the column, and every `INSERT INTO conversations (…, controller_kind)` then
  fails.

My probe: I created a database with `64060fa`'s `src`, then opened it with `f0e589a` and called
`conversations.create`:

```
ERROR SQLiteError: table conversations has no column named controller_kind
```

**Can it occur?** R1 isn't merged into alpha, so no released database has the pre-amendment 17. But any database
opened by this branch between step 1 and step 3b has it. That includes test temp directories, my own probes and
cod2a's, and any smoke test or local app the user may have run on `native-integration-r`. "None exist outside test
temp directories" is likely but can't be checked from here, and the failure is a hard error on the first create.

**Fix (two lines, safe to run on every open):** move the `PRAGMA table_info(conversations)` /
`ALTER TABLE … ADD COLUMN controller_kind …` check out of `if (version < 17)` so it runs on every open after the
migrations. Or run it also when `existing === 17`. Add one test: build a database at 17 without the column, the
same way the v16 test strips its tables, open it, and create a conversation.

## The kind decision matches the factory's binding

The kind is `native` exactly when `agent.adapters.native(adapterId) !== null`:

- in `createConversationWithChannel` (through the `adapter` argument);
- in the adoption path;
- in the open check.

The factory binds a `NativeController` exactly when `nativeAdapter && agent.nativeHarness` (`conversation-manager`
`start`), and throws when there's a native adapter without a harness. So a stored `native` always corresponds to a
native binding, and `acp` to the harness controller.

**Open with a different kind:** `open()` now refuses with `UnsupportedError` when the stored kind doesn't match the
adapter it resolved. That's an entry point the brief didn't list, and it's good that it's covered.

## The cross-kind refusal: every entry point, both directions

- **Where:** the guard is the first statement of `runHandoff`, before `requireFreshContext`, `ensureProvider`,
  `handoff_started` and any record.
- **Entry points:**
  - `handoff()` queues into `runHandoff`;
  - `switch(targetAdapterId)` calls `handoff({ target })` (`agent-session.ts:2094–2105`);
  - recovery's `start_new_internal_session` calls `runHandoff` without a target, so it's the same adapter and never
    triggers the guard.
  - `setMode` changes ACP/PTY inside the harness controller, which is the same kind. The native controller has no
    `setMode`, so the existing member guard applies.
- **Directions:**
  - native → anything else (`native ? targetAdapterId !== fromAdapterId`), including native → another native
    adapter, which is stricter and fine;
  - ACP → native (`isNativeAdapter(target)`).
- **ACP → ACP switches are unchanged.**
- **Test:** the test checks the refusal comes before records or transition events.
- `isNativeAdapter` is internal: it's owner-controlled in `agent/config.ts`, so consumers can't pass it.

## Line counts and moves

- `agent-session.ts`: **4,567** (from 4,600).
- `conversation-manager.ts`: **1,089** (from 1,092).
- `normalizeHandoffContinuation` moved, unchanged, into `handoff-options.ts`.

## Not run by me

I didn't run the typecheck or the full suite. My evidence is the old-source test run (5 expected failures) and the
pre-amendment-17 probe.
