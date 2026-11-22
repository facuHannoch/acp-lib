# R1 durable channel intents

## Step 1. Persistence repository

Implementation commit `61ecd21` on `native-integration-r`. The design follows the async path approved in the [grounding report](11-22-REPORT-R1-grounding.md).

SQLite exposes the optional `channels` repository on both the backend and transaction scopes and advertises it through `capabilities.channels`. The repository keeps one pending edit per channel. Each merge applies only supplied fields and returns the merged intent and its new version. An explicit `null` clears the name or policy. Confirmation deletes the row only when the channel and version match. A separate database-wide counter remains after the last intent is confirmed and survives reopening. SQLite schema 17 creates the tables inside the existing migration transaction and accepts schema 16 as an upgrade source.

Scoped operations participate in the caller's transaction. Root channel reads use the SQLite write queue, so they wait for a transaction to finish before reading its result. The rollback test stages a retirement, observes it through the scoped repository, and starts both root reads before rolling back. The root reads see no retirement. The test also checks that a subsequent committed retirement is visible. Transaction callbacks use their scoped repository for reads and writes.

| Check | Result |
| --- | --- |
| Merge and acknowledgement | The newest value wins on overlapping fields. Other fields persist across a merge, including fields on a different channel. An older acknowledgement leaves the newer edit pending. A matching acknowledgement clears it once. |
| Durable allocator | Merge, confirm, close, reopen the empty repository, and merge on the same channel. The second version is strictly greater and an acknowledgement for the first version leaves the second pending. |
| Schema 16 to 17 | The automated fixture strips the two v17 tables and marks the database as v16. Reopening retains the existing conversation and enables intent writes. The test checks that `schema_migrations` records 17. An independent probe created a true v16 database with `1bac66c` and opened it with `61ecd21`, verifying the same upgrade and retained conversation. |
| Focused tests | 48 passed across the SQLite backend and media persistence test files. |

### Clean archive gate

On a clean archive of `61ecd21`, `bun run typecheck` passed and `bun test ./test` passed **1,430 tests across 132 files** in 265.47 s, with zero failures and 35 snapshots. All snapshot hashes matched before and after the run. Logs are at `/tmp/acp-r1-step1.y29YUv.typecheck.log` and `/tmp/acp-r1-step1.y29YUv.test.log`.

The harness, wire protocol, and native submissions behavior were outside step 1. `src/native/host.ts` remained at 984 lines and `src/agent/conversation-manager.ts` remained at 1,098 lines. The existing synchronous `NativeHostRecords` contract and its memory and file factories still provide the current host path.

### Step 2 and 3 design notes

The approved plan keeps the synchronous records API and both factories for the fallback. Durable mode will select a single internal async channel store and expose reads through `host.pendingChannelChanges()`. Channel reads through `host.records` will throw in durable mode. The startup scan and live enqueue must preserve their place relative to pushes across repository awaits. Callers will propagate `changeChannel` rejections.

Step 3 will enqueue the committed retirement using the existing `#flushChange` delivery loop. The transaction allocates the version with its scoped repository, and post-commit delivery reuses that version. The user settled both wiring decisions:

- A durable backend takes over channel intent storage. Ignore the configured file store's channel half, warn once, and record the limitation. This affects pending channel changes that had yet to be delivered when upgrading. Keep the file store available for submissions.
- Operator suspend/resume stays on the live path and fails while stopped. It cannot overwrite a pending retirement. Today both methods call `#client()`, which throws `HarnessUnavailableError` with the message `the native harness is not running` when there is no client. The same error class covers startup failures and the failed host state, so callers currently have only the text to distinguish offline. The wiring step will give offline a distinct error code through the existing error modules and test it.

## Step 2. Native host channel storage

Implementation commit `56c1b3a` on `native-integration-r`. Scheduling and delivery moved to `src/native/channel-changes.ts`. The host still uses the same create, edit, suspend, resume and delete requests. The module now reads pending intents and acknowledges versions through the async channel store.

| File | Before | After |
| --- | ---: | ---: |
| `src/native/host.ts` | 984 | 887 |
| `src/agent/conversation-manager.ts` | 1,098 | 1,098 |

An Agent with `capabilities.channels` supplies the persistence repository. The old synchronous records and both factories remain available for hosts using the fallback. `host.pendingChannelChanges()` reads the active store. With SQLite, `host.records` delegates submissions to the configured records and guards its synchronous channel methods. A configured file store with pending channel intents produces one warning per host. Its pending intents stay in the file and are ignored by the host. The [spec limitations](../11-11-SPEC-native-harness-integration.md#limitations) record the behavior at upgrade.

When running, the host starts the write and reserves the edit's place ahead of later pushes in the same call. The write may commit during an earlier RPC. Confirming that RPC clears only the version it sent. During startup, the post-open scan checks for writes that raced its snapshot. After a stable scan, it queues live edits before replaying submissions and publishing the running state. The startup deadline covers this scan. Tests held a SQLite write and a stale post-open read behind explicit barriers. Both verified that the later push arrived after suspension. The startup acknowledgement test runs on memory and SQLite, and a separate test covers a stale live RPC acknowledgement on SQLite.

Each host-created `HarnessUnavailableError` carries a readonly lifecycle code. Operator suspend/resume stays on the live path, rejects with `not_running` while stopped and leaves the existing retirement intent untouched. Durable write failures reject `changeChannel`. Tests verified that a failed live edit releases the next push, and that the conversation delete caller propagates the write failure and leaves the conversation available for reopening. The delete and retirement transaction is step 3.

### Clean archive gate

On a clean archive of `56c1b3a`, `bun run typecheck` passed and `bun test ./test/native` passed **102 tests across 7 files** in 77.24 s. Logs are at `/tmp/acp-r1-step2.YpwOIy.typecheck.log` and `/tmp/acp-r1-step2.YpwOIy.native.log`.

The first `bun test ./test` run finished with 1,441 passed and one test timed out across 132 files in 314.80 s. The managed ACP error-record test was still creating its seed conversation when the five-second deadline expired. It passed in isolation on a fresh archive. The [shared timeout report](../../../../../.agents/.artifacts/common/errors/11-22-r1-step2-acp-error-record-timeout.md) links the first run and isolated probe.

The second full run passed the ACP case. It finished with 1,441 passed and one failure across 132 files in 308.31 s. Scripted native checkpoint 6a reached its five-second `session/create` RPC deadline before sending the input. It passed in the native-only suite, the first full run, and in isolation. The [shared checkpoint timeout report](../../../../../.agents/.artifacts/common/errors/11-22-r1-step2-native-create-timeout.md) has the reproduction.

The third full run passed both earlier failures and finished with 1,439 passed and three audit-runtime deadlines across 132 files in 302.89 s. The system reported elevated disk I/O pressure during the failures. The first two runs passed all three cases. [Acknowledgement backoff timeout](../../../../../.agents/.artifacts/common/errors/11-22-r1-step2-audit-ack-timeout.md), [size rotation timeout](../../../../../.agents/.artifacts/common/errors/11-22-r1-step2-audit-rotation-timeout.md), [bounded-tail timeout](../../../../../.agents/.artifacts/common/errors/11-22-r1-step2-audit-tail-timeout.md)

The fourth full run used a private RAM-backed clean archive and set `TMPDIR` to a private fixture directory on the same filesystem. It used the same commit, command and deadlines. `bun test ./test` passed **1,442 tests across 132 files** in 94.45 s, with zero failures and 35 snapshots. Snapshot hashes matched before and after and matched the original disk-backed archive. The run log is `/tmp/acp-r1-step2-ram-gate.CgVTVM/full.log`.
