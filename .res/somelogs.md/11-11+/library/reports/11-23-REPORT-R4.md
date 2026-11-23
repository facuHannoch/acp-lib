# R4 ACP connection cancellation and provider start

## Step 1. Cancellable ACP connection attempts

`83e6d3d` extracts controller startup and client-handler resolution and adds the attempt registry in `src/connection-attempt.ts`. Equivalent in-flight commands share the first promise and its progress observer. An incompatible command cancels and drains the prior ACP candidate before starting. The attempt retains shutdown ownership until the install guard. A launcher that finishes after cancellation is disposed without spawning. Existing launcher APIs remain intact.

`ConnectionCancelledError` is exported from the library with code `connection_cancelled` and extends `Error`. Explicit cancellation bypasses startup's auth-preserving catch and session/load fallback. Genuine session creation failure on a connected transport still allows authentication. Unexpected process or connection loss uses `ProcessCrashError`. The transport close signal races the handshake and initial session RPCs, and old crash callbacks check their transport identity before writing state.

Eleven offline tests cover the four controller paths, same and incompatible starts, late install and launcher disposal, unexpected child death, a stopped raw load, the auth-preserving branch, and a delayed old crash callback after a replacement connected. The test fixture confirms request receipt and reports its PID, which is dead after stop, including a SIGTERM-resistant process. The ACP leg of a PTY-to-ACP mode change is covered. A hanging PTY launch itself is outside R4, although a PTY that returns after cancellation cannot install.

The first clean run found two existing fake-transport load tests incompatible with the new method call. `2b49b7c` moved the session close race inside the transport's existing new/load methods and kept a post-await identity check in the client. The fake transport tests and cancellation tests then passed.

Clean `bun run typecheck` and `bun test ./test` with a RAM-backed `TMPDIR` passed **1,600 tests in 150 files in 114.70 s** on `2b49b7c`. All 35 snapshots passed and the A1 hash was unchanged. Logs are in `/tmp/acp-o1-r4-step1-rerun.59WHJf`. The controller fell from 840 to 762 lines, the client from 1,062 to 1,046, and the session stayed at 4,564.

## Step 2. Conversation and Agent shutdown

`0c4d12e` adds the optional factory-scoped `signal` and tracks the handoff candidate until the operation ends. Agent shutdown cancels pending creations and openings before waiting for them, including operations that have yet to expose their conversation handle. The shutdown path also drains live sessions and their canonical writes. A cancelled connection does not fall back to restoration or produce a provider-session failure record. A cancelled handoff with spent work retains its `AgentSessionHandoffError` metering records and carries the typed cancellation as its cause. A handoff with no metered work rejects directly with the typed error.

The six additional offline cases cover direct factory cancellation, same-adapter and cross-adapter handoff targets, an active prompt and queued prompt/settings during reconnect, and Agent close during eager creation or reopen. They verify dead child PIDs, no reconnect fact after cancel, no target activation, no fresh fallback and no provider failure record. The queued operations settle once with connection cancellation only when stop interrupts readiness. Ordinary queue clears retain their previous results.

Clean typecheck and `bun test ./test` passed **1,606 tests in 150 files in 123.49 s** with `TMPDIR` on `/dev/shm`. All 35 snapshots passed and the A1 hash was unchanged. Logs are in `/tmp/acp-o1-r4-step2.PoEQ9p`. Extracting session configuration and adoption persistence left the session at 4,485 lines and its manager at 1,003.
