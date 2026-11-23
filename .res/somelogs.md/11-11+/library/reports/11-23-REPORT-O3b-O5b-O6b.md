# Native worker delivery, restart recovery and the stdio delegation route

## O3a follow-up

`d030961` treats a naturally completed predecessor as settled when a previously queued steer reaches the dispatch hook. It reserves the successor using the steer's invocation ID and keeps the predecessor's final record, destination and policies. The offline ACP fixture holds a tool open while the caller gets `steered`, then completes the original prompt naturally. The test verifies both results and their independent bindings.

An idle start that fails at the dispatch hook now emits a directed `worker_failed` event and uses the durable refusal notice. The test injects a reservation error and confirms that the sender receives one refusal after the immediate `sent` response. When that notice is the latest outcome, check and list also return the latest successful staged result as `latestResult`. The production sender lookup rejects IDs made only of whitespace and Unicode default-ignorable code points. Its callback tests cover zero-width space, joiners, word joiner, soft hyphen and tags, plus an ID with visible text and an embedded joiner.

## O3b native delivery

`8db2c67` schedules the existing native host flush when the worker settles. The worker keeps using the committed assignment's destination and policy names through the repository. The host module retains responsibility for `channel/notify`, the stable receipt ID, earlier channel changes and retries.

The real stdio cases verify a redirect that commits before staging and a redirect attempt after staging while delivery is still pending. The latter keeps the frozen payload and original destination. A suspended channel leaves the notice pending and gets one notice on resume. An unknown policy sets `blocked_policy`. Reopening with that policy configured leaves the notice blocked until an explicit retry moves it to pending. Missing and retired channels set `failed_destination` and get no notice. Check and list retain the staged result for every destination outcome.

## O5b restart

The ACP startup scan now stages inherited unfinished assignments as well as committed finals. Native recovery runs when the host opens, after its earlier channel changes. The Agent reads worker rows from persistence without starting worker providers. The provider loads only when new work is sent.

The native crash probes use the production orchestrator to submit ACP worker work, then kill the Agent writer with SIGKILL. A direct SQLite read verifies each crash boundary before opening a replacement Agent and starting the real stdio harness.

| Crash boundary | Recovery |
| --- | --- |
| Final worker record committed, no stage | Lookup by assignment ID recovers the exact final text |
| Forwarded permission pending, no final record | The old permission ID is refused and one uncertainty notice is delivered |
| Notice staged, receipt absent | The same notice ID and payload are delivered once |

The replacement uses a worker command that cannot dispatch. Worker rows remain offline, and every recovery test sees one timeline notice and a native turn responding to it. Repeated flushes preserve the committed delivery result.

## O6 step 2

The native script calls `delegate` on Alice's channel. Bob's next native turn calls `delegate` with the worker handle and `redirect: true` while the ACP worker is held at its tool boundary. The successor's permission appears on Bob's conversation with the worker source, and Bob answers through `answerPermission`. Exactly one result notice wakes Bob's channel. The harness's reconciliation view confirms the worker sender and both the owner and guest policies inherited on that accepted item.

The model is scripted and the ACP worker uses an offline fixture. O6 step 3 remains pending authorization for a live provider run.

## Clean archive gates

| Commit | Full `bun test ./test` with `TMPDIR` on `/dev/shm` | Logs |
| --- | --- | --- |
| `d030961` | 1,581 tests across 147 files in 107.16 s | `/tmp/acp-o1-o3a-followup.4AVS0r` |
| `8db2c67` | 1,589 tests across 149 files in 108.91 s | `/tmp/acp-o1-o3b-o5b-o6b.pBiwO9` |

Both archives passed typecheck and all 35 snapshots. The A1 snapshot hash was unchanged.
