# O1 worker registry and pool

Implemented on `orchestrator` after [Brief G](11-22-REPORT-OG.md). Each implementation commit was gated on a clean archive with `bun run typecheck`, the full offline `bun test ./test`, and comparison of the A1 snapshot hash before and after the run. The baseline was 1,509 tests in 137 files.

| Step | Commit | Full gate |
| --- | --- | --- |
| 1. Worker registry and configuration | `6a9ab88`, `8199b9a` | 1,514 tests in 138 files in 96.60 s. Logs in `/tmp/acp-o1-step1-rerun.ovUvKC`. |
| 2. Worker role and identity | `6582fb1` | 1,517 tests in 139 files in 107.18 s. Logs in `/tmp/acp-o1-step2.zWNdZQ`. |
| 3. Pool and idle dispatch | `4373fe7` | 1,519 tests in 140 files in 116.04 s. Logs in `/tmp/acp-o1-step3.Hi59tV`. |
| 4. Consumer API and events | `6e0a72d` | See final gate below. |

The first step 1 gate found one exact SQLite capability assertion that needed the new flag. The follow-up preserved the existing capability assertions. [Triage note](../../../../../.agents/.artifacts/common/errors/11-22-o1-sqlite-capability-assertion.md)

## Persistence and worker identity

Schema 19 adds `workers` and the optional conversation role. Existing rows retain their original conversation role behavior. The worker table contains the handle, linked conversation, opener, description, default destination for future assignments, and creation/drop times. A dropped handle remains allocated. The worker row has no assignment or notice state. The migration tests cover databases shaped as version 18 and version 16, rollback on a scoped worker write, persistence after reopen, update and drop, and the surviving worker delivery capability.

The Agent requires both `capabilities.workers` and `capabilities.workerDelivery` and their repositories when configuring the pool. It requires message capture at `content`, and per-worker capture overrides must preserve that level. Worker conversations use ACP adapters and expose `role: "worker"` on their persisted summary. The role skips identity load and update, including out-of-band updates and reopen. Checkpoint-backed identity filters worker histories at source enumeration. The runtime has no separate member registration interface. Tests cover a custom identity preamble, built-in identity source filtering, and rejected capture before worker creation.

## Pool and consumer cases

| Operation | Verified behavior |
| --- | --- |
| Open | Two racing opens for one slot admit one prompt. The refusal includes the busy worker's handle, state and description. |
| Send | An idle worker accepts work in its existing conversation and updates its description. Busy send returns the worker's status. Sending to an evicted handle reloads the same conversation. |
| Check and list | Return the durable worker row with current offline, idle or busy status, plus operation and sender details when present. Reads do not reorder eviction priority. |
| Eviction | Least recently used idle worker's process stops before the next slot starts. Reacquisition waits for any already-stopping worker to finish teardown. Busy workers remain in their slots. |
| Consumer stop and delete | The consumer lists both busy workers, interrupts both and observes them idle. Delete uses existing conversation/provider cleanup and marks the worker row dropped. |
| Observation | `agent.events.subscribeWorkers` delivers typed worker lifecycle events in the existing observation envelope. Existing record subscribers receive only committed records. Tests cover open, busy, idle, reply, failure with a fixed reason, explicit stop, eviction, reload and drop. |

The consumer API returns worker summaries and controls. Dispatch uses the Agent's public conversation APIs and does not hand the conversation object to the worker consumer. The existing low-level conversation management APIs remain available to trusted Agent code, so O1's slot invariant is for pool-mediated dispatch. Assignment correlation, busy steering and policy, redirect, idle timers and delivery recovery remain subsequent work. Nothing in O1 calls `stage`, `transitionDelivery` or the native flush.

`src/agent-session.ts` is unchanged (4,564 lines). `src/agent/conversation-manager.ts` stays at 1,085 lines. The largest new orchestrator module is 174 lines. No live providers were used.

## Final gate

A clean archive of `6e0a72d` passed typecheck and **1,521 tests across 140 files** in 104.60 s. All 35 snapshots passed. The A1 snapshot hash matched the baseline. Logs are in `/tmp/acp-o1-step4.ZYAO87`.
