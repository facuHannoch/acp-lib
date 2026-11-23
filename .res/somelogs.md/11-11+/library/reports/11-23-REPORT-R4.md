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

## Step 3. Deferred provider start

`504eaf1` keeps `on_open` as the default. Normal ACP conversations can opt into `on_first_use` in Agent conversation defaults or override it through the creation or reopen runtime options. A live handle is reused regardless of a new runtime option. The option is evaluated at each creation or reopen and does not add a persistence field. Native channels and degraded PTY mode keep their existing startup behavior. Managed and standalone session startup and the adoption path stay eager where they were eager before.

A newly opened deferred handle returns `providerSession: "deferred"`. It can hold a previously recorded provider ID while its provider remains disconnected. Inspecting the handle exposes empty model/configuration and command views, and ACP-only capability reads still raise the not-connected error. First prompt or settings change uses the existing readiness path, sharing the queue's startup attempt. Recorded sessions load by their original ID, and first-use recovery still applies checkpoint continuation and reports its progress. A new session that fails to start surfaces the provider error at first use. A stop before first use spawns nothing, and stop during initialize reaps the child.

The changelog documents `deferred` and the configuration. A search of the repository's `providerSession` consumers found no exhaustive switches over `OpenOwnedAgentConversationResult.providerSession`. Remaining `loaded`, `new` and `recovered` assertions are scoped to eager callers. Tests cover concurrent first use, default and override precedence, first settings write, recorded reload, missing-session checkpoint recovery, launch and session errors, a native detached open, and eager adoption with lazy defaults.

`d6c3fa9` merged alpha `3d96dbd`, including the worker retry follow-up, before the final gate. Clean typecheck and `bun test ./test` with a RAM-backed `TMPDIR` passed **1,614 tests across 151 files in 123.69 s**. All 35 snapshots passed and the A1 snapshot hash was unchanged. Logs are in `/tmp/acp-o1-r4-step3.Yq0ksm`.

| File | Before R4 | After R4 |
| --- | ---: | ---: |
| `src/agent-session.ts` | 4,564 | 4,495 |
| `src/client.ts` | 1,062 | 1,046 |
| `src/controller.ts` | 840 | 764 |
| `src/agent/conversation-manager.ts` | 1,013 | 1,012 |
