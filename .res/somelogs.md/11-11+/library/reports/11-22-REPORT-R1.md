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

## Step 3. Conversation creation, deletion, and channel intents

Implementation commit `c600199` on `native-integration-r`, after the separately verified hook correction `7be9456`. The create and delete transaction helpers are in `src/agent/native-channel-lifecycle.ts`.

| File | Before | After |
| --- | ---: | ---: |
| `src/agent/conversation-manager.ts` | 1,098 | 1,092 |
| `src/native/host.ts` | 887 | 884 |

For durable native deletion, the scoped repositories write retirement, optionally delete checkpoints, and mark the conversation deleted in one transaction. The commit promise reserves a host delivery slot and participates in the startup scan barrier. Live delivery awaits the commit and uses the existing flush and acknowledgement path with the transaction's version. An RPC failure after local commit leaves the intent pending and logs the delivery failure. A stopped host leaves the committed retirement available for the next open. The existing records fallback remains available for backends without the channel repository.

New native conversations commit their initial title and default policy intent alongside their conversation row. Later declarative title, policy and lifecycle changes use the channel repository. The check for a pending retirement and a declarative suspend or reopen write share a transaction. If retirement is pending, the host returns `channel_retired` and leaves its version intact. Operator suspend and resume stay direct and return `not_running` while offline.

The tests fault the scoped retirement write, force a delete validation failure after a retirement was staged, and fault the initial channel write after the creation row was staged. Each test checks the rollback through the root repositories. The live-delivery test pauses the transaction after both writes. It verifies the wire delete sees the committed state and the original version, occurs once, and precedes a later push. The stopped test confirms that subsequent suspend and reopen desires preserve the pending retirement.

A live native conversation can be identified before its first prompt. A separate scripted probe reproduced an older identification gap after a full Agent restart. A different conversation had opened the harness and cleared the unused channel's initial intent. The restarted Agent soft-deleted the unused conversation without recording retirement. The still-open harness channel then accepted an operator push and committed an assistant message. This can run work on a deleted conversation, so it was escalated to the coordinator for the user's decision. The first-attachment path remains as before. [Shared error note](../../../../../.agents/.artifacts/common/errors/11-22-r1-native-unused-channel-identity-after-restart.md)

### Clean archive gate

Clean archive of `c600199` using a private RAM-backed checkout and fixture directory. `bun run typecheck` passed. `bun test ./test` passed **1,451 tests across 132 files** in 97.76 s. All 35 snapshot hashes matched the hook-fix baseline and the archived files before the run. Logs are at `/tmp/acp-r1-step3-gate.ALQrzm/typecheck.log` and `/tmp/acp-r1-step3-gate.ALQrzm/full.log`. The focused rollback and delivery checks also passed in the disk-backed worktree.

## Step 3b. Stored controller kind

Implementation commit `f0e589a` on `native-integration-r`. Conversation creation stores `controllerKind` from the Agent's native adapter selection. SQLite stores it in the nullable `conversations.controller_kind` column, constrained to `acp` or `native`. Schema 17 is still unreleased. New schemas include the column, and upgrading from 16 adds it with null values for existing rows. The persisted summary represents those nulls as an absent kind.

Deletion reads the stored kind through the same transaction scope that stages retirement and deletes the conversation. Legacy rows and custom backends that omit the kind fall back to the provider descriptor or live adapter. The Agent passes the kind to custom stores through the shared repository contract. This repository has no separate in-memory Agent conversation store. The spec's Limitations section records the legacy and custom fallback. Native startup and first provider attachment retain their existing behavior.

The SQLite restart tests cover an unused native conversation with an acknowledged creation intent, a still-pending creation intent, and no title or policy. Each test opens a new Agent on the same database and verifies that deletion stages retirement without launching the harness. The first case simulates acknowledgement at the repository boundary. A separate legacy test verifies native retirement using an old row's active provider descriptor. The v16 upgrade test checks SQL null, summary shape, and soft deletion of the migrated row.

Handoff and switch reject cross-kind transitions with `UnsupportedError` before recording a transition or emitting its events. The tests exercise both methods in both directions. The guard also keeps native-to-native switches unsupported. Reopening a row with a persisted kind likewise rejects a route that selects the other kind.

| File | Before | After |
| --- | ---: | ---: |
| `src/agent/conversation-manager.ts` | 1,092 | 1,089 |
| `src/agent-session.ts` | 4,600 | 4,567 |
| `src/native/host.ts` | 884 | 884 |

Handoff option normalization moved to `src/handoff-options.ts`. The changelog covers the schema and transition behavior.

### Clean archive gate

Clean RAM-backed archive of `f0e589a`. Typecheck passed. `bun test ./test` passed **1,456 tests across 132 files** in 91.98 s. All 35 snapshots matched both the archive before the run and the step 3 baseline. Logs are at `/tmp/acp-r1-kind-gate.VjyYGG/typecheck.log` and `/tmp/acp-r1-kind-gate.VjyYGG/full.log`.

## Step 4. Scripted stdio restart tests

Test commit `be36dfc` adds six tests in `test/native/checkpoint.test.ts`. Each restart opens a new Agent over the same SQLite database and harness home. The stdio child runs the scripted fixture.

| Case | Verified behavior |
| --- | --- |
| Delete while stopped | The original Agent writes retirement without relaunching. The new Agent reads the same version and opens the harness with the channel retired. A push is refused with `channel_retired`. |
| Crash between apply and acknowledgement | A storage fault kills the harness child after `deleteChannel` commits and before its open response. The Agent still has the pending version. A new Agent sends that version again, receives `applied`, and clears it. A later push is refused and the channel keeps only its original assistant reply. |
| Blocked retirement | Wire tool and suspension events establish a channel with pending input. Reopen reports `channel_busy` for the same retirement version. The channel remains suspended and the queued input stays in place. Operator resume rejects with `channel_retired` before sending an RPC. |
| Unused channel already created by another conversation's open | Its initial intent is consumed and it has no provider descriptor. Deleting after an Agent restart retires it. The operator push used in the original orphan probe now rejects and there is no assistant output. |
| Delete before the first harness open | The first create batch acknowledges the retirement. The load view shows only a retired channel. A push rejects, the timeline is empty, and the wire shows no turn start. |
| Native conversation with no title or policy | It has no creation intent or channel in the initially open session. After an Agent restart, deletion still stages retirement. The following open retires the id and refuses a push. |

A channel deleted before the harness first opened may appear as a retired tombstone (created and retired in the same open batch).

The six focused stdio tests passed in 4.18 s. Tool and suspension waits subscribe to wire events with a 10 s deadline. Tests also have a 30 s outer deadline.

## Done

| Work | Commits |
| --- | --- |
| Grounding and async design | `1bac66c` |
| Scoped channel repository and schema 17 | `61ecd21`, report `e55afcf` |
| Native host wiring and ordering barriers | `56c1b3a`, report `a902ccf` |
| Dispatch hook for worker delivery | `acc6d5d`, message identity correction `7be9456` |
| Atomic native deletion and creation | `c600199`, report `49b5a1c`, operator resume guard `64060fa` |
| Stored controller kind and legacy fallback | `f0e589a`, report `e701ba0`, early-v17 repair `8b17fbd` |
| Scripted stdio restart verification | `be36dfc` |

The async channel store is the durable authority. Host scans and delivery read it directly, without a mirror. Root SQLite reads wait for commits, and native deletion writes its intent in the same scoped transaction as the deleted row. Backends without channel intent support continue using the synchronous host records. Submission storage still follows the configured host records.

SQLite schema 16 → 17 adds the channel intent table, the persistent version allocator, and nullable `conversations.controller_kind`. Startup repairs missing controller-kind columns on early schema 17 databases. Legacy rows and custom stores that omit the kind use descriptor or live-conversation fallback. Scoped writes and conditional acknowledgement preserve pending versions across restart.

| R1 point | `src/native/host.ts` | `src/agent/conversation-manager.ts` |
| --- | ---: | ---: |
| Alpha baseline and step 1 | 984 | 1,098 |
| Step 2 | 887 | 1,098 |
| Step 3 and operator resume guard | 884 | 1,092 |
| Step 3b through step 4 | 884 | 1,089 |

Final clean RAM-backed archive of `be36dfc`. Typecheck passed. `bun test ./test` passed **1,463 tests across 132 files** in 89.48 s. All 35 snapshot hashes matched before and after the run and matched the step 3b compatibility baseline. Logs are at `/tmp/acp-r1-step4-gate.VpxqlV/typecheck.log` and `/tmp/acp-r1-step4-gate.VpxqlV/full.log`.
