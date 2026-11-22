# Review — R1 step 1: the `channels?` repository and schema 17

This review covers implementation `61ecd21` and report `e55afcf` on `native-integration-r` (diff
`44bbc25..e55afcf`). I read them through `git diff`/`git show` and `git archive`; I didn't check out the branch.

**Verdict: no blocking findings.** The repository follows the `identity?` pattern, the semantics match the brief, and
the upgrade from 16 to 17 adds tables without losing data and is safe to run twice. Step 1 doesn't touch the host or
the manager. The tests cover what the gate asks for. My own check on a database really written at schema 16 confirms
the upgrade. The offline suspend/resume error needs a code (see the last section).

## (1) It follows the `identity?` pattern

- `ChannelPersistence` is an asynchronous interface in its own module (`src/persistence/channels.ts`, 23 lines).
- `PersistenceScope.channels?` is optional.
- `PersistenceCapabilities.channels: boolean` is set to `true` by SQLite. SQLite is the only backend that declares
  capabilities (the same as `identity: true`), so nothing else needed the flag.
- `SqliteChannelPersistence` (`sqlite-channels.ts`, 65 lines) is the only code that touches the new tables. It's
  built inside `createScope`, so both the root scope and every transaction scope get one.
- `ChannelDesire`/`PendingChange` moved from `native/records.ts` to `persistence/channels.ts` and are re-exported
  from `records.ts`, so the public type names and shapes are the same. The only addition to `index.ts` is the
  `ChannelPersistence` type.
- No SQL is outside the SQLite implementation.

## (2) Semantics

- **The newest field wins when merging.** The edit keeps only the fields that were given (`undefined` means no
  edit, `null` clears). It's captured *before* the write queue, so a caller mutating its argument after the call
  can't change the write. It's then merged over the stored desire.
- **Versions always increase.** A single-row clock (`native_channel_intent_clock`) is incremented with
  `INSERT … ON CONFLICT DO UPDATE … RETURNING` in the same write as the intent row. A confirm deletes only the
  intent row, never the clock, so versions keep increasing across a clear and a reopen. The test covers merge,
  confirm, close, reopen, then merge again, and my probe below does too.
- **Only the newest version is cleared.** `DELETE … WHERE channel = ? AND version = ?` returns `changes === 1`.
- **Reads see committed state only.** Root `pendingChange(s)` run through `enqueueWrite`, so they wait behind any
  open transaction. Inside `transaction()`, the scope's runner is direct (`async (op) => op()`), so scoped
  reads and writes see the transaction's own state, and a scoped read doesn't wait on its own queue.
- **The rollback test proves the read boundary.** It starts root reads *inside* the callback, rolls back, and checks
  that they return `undefined`/`[]`.
- **One limit to keep in mind for step 3:** a *root* `channels` call made from inside a transaction callback would
  wait behind that same transaction forever. The report says callbacks must use their scoped repository; keep to
  that in the manager's delete helper.
- **Restarting versions at 1 is harmless to the harness.** `changeId` is opaque to it
  (`native-harness/src/contracts/protocol.ts:61–65`): it only echoes it back. Durable versions starting again at 1,
  after a host used higher in-memory versions, can't be mistaken for stale.

## (3) Schema 17 and the upgrade from 16

- Both tables use `CREATE TABLE IF NOT EXISTS` (additive, and safe to run again). They have `CHECK`s on the version
  range and on `desire_json` being a JSON object.
- `if (version < 17) database.exec(CHANNEL_INTENT_SCHEMA)` runs inside the existing migration transaction.
- 16 is now admitted as an upgrade source in the compatibility list. A fresh database (version 0) gets the tables
  through the same `< 17` branch.
- **My real version-16 probe** (`/tmp/clad2a-v16.*`):
  - I created a database with `44bbc25`'s `src` and wrote three conversations; `schema_migrations` max was 16.
  - I opened it twice with `61ecd21`'s `src`. Both times, all three titles were kept and a desire succeeded (open
    1 gave version 1, open 2 gave version 2, with one pending row).
  - `schema_migrations` ended as `[16, 17]`: the second open re-ran nothing and kept the clock.
- cod2a's automated test builds its v16 database by dropping the v17 tables. That's a fair stand-in, and my probe
  plus cod2a's own probe cover a real one.

## (4) Scope

`src/native/host.ts` is still 984 lines, and `src/agent/conversation-manager.ts` is unchanged at 1,098. The only
change in `native/records.ts` is moving the two types; the synchronous `NativeHostRecords` and both factories are
unchanged. There's no wiring.

## (5) Tests against the gate

| Gate item | Test |
| --- | --- |
| Merge, newest field wins | "merges pending channel fields…": overlapping fields replaced, other fields kept, `null` clears the policy, the other channel unaffected |
| Clear only the newest version | Same test: an older version returns `false` and the edit stays; the newest returns `true` once, then `false` |
| Versions across a clear and reopen | "channel versions still increase after confirmation and reopening…" |
| Committed reads / rollback | "root channel reads do not expose an intent rolled back…" |
| Opening and upgrading a v16 database | "upgrades a version 16 database and preserves existing conversation data", plus my real-v16 probe |
| Suite green | cod2a: 1,430 / 132 files (+4). I didn't rerun it. |

## The offline suspend/resume error

Today `#client()` throws `HarnessUnavailableError("the native harness is not running")` (`host.ts:686`). The same
class, with no code, is also thrown for:

- a failed host (`:286`);
- a stopped one (`:305`);
- an open timeout (`:341`);
- a start failure (`:373`);
- a failed reopen (`:624`).

Callers can only tell "offline" apart by matching the message text. **That isn't distinguishable enough for the
user's decision.** The smallest fix that keeps compatibility is a `readonly code` on `HarnessUnavailableError`, set
at each of those six throws:

- `"not_running"` at `:686`;
- `"failed"`;
- `"stopped"`;
- `"open_timeout"`;
- `"start_failed"`;
- `"reopen_failed"`.

That keeps `instanceof` and follows the `.code` convention the library already uses (`provider_session_missing`,
`channel_suspended`). A subclass (`HarnessNotRunningError extends HarnessUnavailableError`) would also work, but it
covers only one case. I'd add the code in the wiring step, as cod2a plans, with a test that offline
`suspendChannel`/`resumeChannel` reject with `code: "not_running"` and write no intent.
