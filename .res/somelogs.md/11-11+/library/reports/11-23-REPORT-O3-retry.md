# Worker delivery state and explicit retry

`3ef4ee0` adds `deliveryState` to worker check and list, alongside the outcome of the latest staged assignment. The states are `pending`, `delivered`, `blocked_policy` and `failed_destination`. The check and list tool descriptions explain that a native result may be absent until the harness opens and stages it.

`agent.workers.retryDelivery(handle)` selects the worker's newest policy-blocked notice, even if a newer assignment already has a different outcome. It rejects when no blocked notice is available. The retry compares the stored state, moves `blocked_policy` to `pending` with `explicitRetry: true`, and schedules the destination's existing flush with the original delivery ID. If the harness is stopped, the pending notice is eligible when it next opens. The API is exposed to consumers. The delegation catalog still consists of `delegate`, `check`, `list` and `stop`.

The scripted stdio tests inspect all four states using both consumer summaries. They fix the harness policy on reopen, verify that the notice stays blocked, then exercise the public retry and verify one accepted notice and state `delivered`. Retry refuses pending, delivered and failed-destination notices. The SQLite repository tests also cover locating an older blocked notice when a newer outcome exists. The changelog records the API and summary field.

## Clean archive gate

`bun test ./test` used `TMPDIR` on `/dev/shm`. Typecheck and 1,589 tests across 149 files passed in 113.52 s. All 35 snapshots passed, and the A1 snapshot hash was unchanged. Logs are in `/tmp/acp-o1-o3-retry.4AccOz`.
