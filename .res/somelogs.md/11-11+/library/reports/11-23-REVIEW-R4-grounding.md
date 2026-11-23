# Review — R4 step 0 (grounding report for cancellable connect and lazy ACP start)

I reviewed `library/reports/11-23-REPORT-R4-grounding.md` (`integration-r456` at `ba36596`) against the spec sections "Cancellable connect (ACP and native)", "Lazy start for ACP conversations too" and the R4 outline, and against the code at alpha `fe7d28c` (clean `git archive`, `/tmp/clad2a-r4`). I changed no code.

**Verdict: the grounding is accurate and the brief is ready to implement, with the additions below. No blocking findings.**

## What I verified in the code

| Claim in the report | Result |
| --- | --- |
| `stop()` reaches only the installed client (`this.current`); candidate clients in `bringUp` are local | Confirmed (`controller.ts` `stop` :409, `bringUp` :628) |
| `reconnect` installs the client before validating the session id | Confirmed (:180). The mismatch path calls `stop()` after install, so it is cancellable only after the handshake |
| `setMode` publishes the replacement, then stops the source | Confirmed (:437) |
| `startFresh` on an existing ACP connection calls `newSession()` (no client creation) | Confirmed (:279) |
| Handoff target `startFresh()` (`agent-session.ts` :2624) is unreachable by `stop()` while target startup hangs; the failure-path target stop is :2897 | Confirmed; the report says :2896 (nit) |
| **Agent-close ordering gap** | **Real.** `stopAll` awaits `openings`, then stops `live`. The initial `create` is registered in neither map, and an `open` in `openings` is awaited, so a hung connect blocks close indefinitely |
| `AcpClient.connect()` awaits launcher prepare, `transport.start()` and `initialize` with no cancel path | Confirmed (`client.ts` :348). `raceExit` only races process exit |
| `loadSession`/`newSession` RPCs have no close race | Confirmed: both await the transport call directly (:487, :682); only `initialize` uses `raceExit` |
| `AcpTransport.stop` is SIGTERM, 500 ms, SIGKILL | Confirmed (:144–164) |
| Fixture hooks `LIFECYCLE_HANG_CONTROL` / `LIFECYCLE_HOLD_CONTROL` | Present in `test/fixtures/lifecycle-agent.ts` (:13, :58–63); the hang control never answers one named method |
| Reopen status type | `providerSession: "already_open" \| "loaded" \| "new" \| "recovered"` at `agent/config.ts` :180 |
| No `ConnectionCancelledError` exists yet | Confirmed |

## Against the spec

- **Typed error and its place.** `ConnectionCancelledError` (code `connection_cancelled`) in `src/errors.ts`, exported from `src/index.ts`, matches the spec's single typed error and the other error classes' location. Good. Make sure it is **not** a subclass of `ProcessCrashError`/auth errors, so existing `instanceof` handling doesn't swallow it.
- **No automatic deadline** is respected (decided 2026-11-13); the plan adds only explicit cancellation.
- **`providerStart`.** "on_open" default, "on_first_use" for Agent conversations only, managed path unchanged, adoption unaffected, capabilities getter throwing until first op, settings change counting as first use all match the spec. The `deferred` reopen status is a **public type addition**: add it to the changelog and check exhaustive `switch`es over `providerSession` in `src` and tests.

## Risks and missing items

1. **`bringUp`'s auth-preserving catch must be bypassed on cancel.** The catch keeps the client and logs `session_start_failed` when the session start fails (`loadFailure !== "error"`). A cancel during `startSession` would be swallowed and the client installed. Test it: cancel during `session/new` must throw `ConnectionCancelledError`, install nothing, and leave no process.
2. **`onCrash` stale identity (`client.ts` :391).** The handler nulls `transport`/`session` unconditionally. A cancelled attempt's transport dying late could clear a newer attempt's state. Guard with `if (this.transport === transport)`.
3. **Launcher `prepare` has no signal.** If `prepare` resolves after cancel, the result must be disposed (no process started, temp material removed). Add a test where cancel lands during a slow `prepare`.
4. **PTY (degraded) start has the same unreachable local client** in `bringUp`. The report limits R4 to ACP. That is acceptable only if it's stated in the brief as out of scope; otherwise the attempt registry should cover the PTY leaf too, because `stop()` during a PTY start leaks the same way.
5. **No late install: check every install site, not just `bringUp`.** `reconnect` (:180), `setMode` (replacement published before the source stops) and handoff targets each need the post-await cancelled check *before* assigning `current`/`acp`. A test per path.
6. **One attempt at a time.** The brief should say whether a second `start`/`reconnect` while an attempt is in flight waits, cancels the first, or throws. Today `stopping` is awaited but a concurrent `start` isn't. Pick one and test it.
7. **Standalone/direct callers.** The optional caller signal on factory-created eager opens is requested as an approval; I agree it's needed, since without it a direct caller cannot cancel an eager open. Keep it optional and out of the default path.
8. **Bounded teardown on cancel.** The cancelled client's process must be gone (SIGTERM → 500 ms → SIGKILL) before `stop()` resolves; assert the pid is dead and no stderr pump/timer remains.

## Cancellation gates and test plan

The planned fixtures cover it: one that never answers `initialize`, one that never answers `session/new`, one that never answers `session/load`. Required assertions: `stop()` returns while the connect is in flight; the connect rejects with `ConnectionCancelledError`; the child pid is dead; `current`/`acp` stay unset; a later `start` works; Agent `close()` during an eager create completes. Add the cases for risks 1–3 and 6.

## Extraction limits

Current sizes: `agent-session.ts` 4,564, `client.ts` 1,062, `controller.ts` 840, `conversation-manager.ts` 1,013. The no-growth rule is workable only if the attempt registry and cancellation logic go into **new modules** (for example `src/connect-attempt.ts`), and `controller.ts` and `client.ts` call them with a few lines. State the rule as an acceptance gate: each of the three files must be ≤ today's line count in the final diff, and the A1 characterization hash `fbc6ec2c…` must be unchanged. `agent-session.ts` may take only the one-line handoff cancellation cause.

## Not blocking, but worth fixing in the brief

- :2896 should read :2897.
- Say explicitly that `deferred` is returned only when nothing was started and no session was loaded.
