# Controller interface verification — flake fixes and B2 follow-ups

Six isolated test and documentation commits on `controller-interface-verify`, after the [B2 verification](11-22-REPORT-B2-verify.md). No source or snapshot files changed.

| Commit | Change and reason |
| --- | --- |
| `d3f7544` | The bridge test waits for the startup status callback and an opt-in acknowledgement from the PTY fixture before sending Ctrl-]. The startup wait has a 15 s limit. Input acknowledgement and bridge close have 10 s limits. Each timeout identifies the phase and mode. The exit chord is sent from cleanup if an earlier wait fails. |
| `6f7fddf` | The coalesced checkpoint test uses `performance.now()` for its existing 3 s polling deadline. WSL2 wall-clock changes no longer shorten or extend that deadline. The target sequence, summary and call count assertions are unchanged. |
| `49aa652` | The two continuation tests already await actual fixture requests, reloads and transcript I/O. Each now has a 30 s test bound instead of Bun's 5 s default, and the managed test registers the initially opened conversation for cleanup before its first prompt. The cancellation-record test waits on stage events for the specific turn, each with a 15 s bound. Its fixture holds the tool until cancelled or released after the steer is queued. A 1 s cancel grace gives the fixture time to acknowledge under load, and the test has a 55 s overall bound. The expected cancellation records are unchanged. |
| `a12a47d` | The fake ignores cancel during held replay. The new test leaves completed turn B held while turn C is live, cancels B, and verifies B's original status, ordered output, and isolated signals while C remains pending until released. The regression failed against the original fake. |
| `3c6dc8f` | The changelog explains that local withdrawal leaves a later backend turn runnable and only excludes the unknown message ID from settlement. It also reflects the native controller's current presence and missing reconnect method. |
| `66fa496` | The shared conformance file now names all three subjects and drops the obsolete claim that the interface carries no message payload. |

## Verification

The proof runs used an archive of `66fa496` at `/tmp/acp-flake-fixes.JEuspS`, with the main checkout's `node_modules` linked. The offline fixtures ran outside the sandbox with approval. Full run 3 used a fresh archive at `/tmp/acp-flake-fixes-final.p4DbVd`. Individual logs and the summary are under `/tmp/acp-flake-fixes-logs.wIRtSY`.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| Focused repeats | 30 clean invocations. Each file passed all five runs: characterization 35 tests, checkpoint strategy 7, operation lifecycle 25, fake-only 10, ACP/fake conformance 20, and native conformance 9. That is 530 passing tests across the isolated runs. |
| Full run 1 | 1,399 passed, 4 failed, 4 unhandled errors, 131 files, 35 snapshots, 295.50 s |
| Full run 2 | 1,403 passed, 0 failed, 131 files, 35 snapshots, 248.10 s |
| Full run 3 | 1,403 passed, 0 failed, 131 files, 35 snapshots, 240.07 s |

Full run 1 failed in unchanged tests. All cases touched by the batch passed in that invocation. The first three failures were in the committed event bus: [prompt hook timeout](../../../../../.agents/.artifacts/common/errors/11-22-flake-gate-event-bus-prompt-hook-timeout.md), [rollback timeout](../../../../../.agents/.artifacts/common/errors/11-22-flake-gate-event-bus-rollback-timeout.md), and [streaming revisions timeout](../../../../../.agents/.artifacts/common/errors/11-22-flake-gate-event-bus-streaming-timeout.md). The fourth was the [native host lost-push reopen timeout](../../../../../.agents/.artifacts/common/errors/11-22-flake-gate-native-reopen-timeout.md). All four passed on full runs 2 and 3. These two runs supply the green gates. The initial run is retained for triage.

The characterization snapshot SHA-256 is `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. The check is repeated after every command. No live provider runs were used.

## Prior failure evidence

- [Bridge status wait](../../../../../.agents/.artifacts/common/errors/11-22-a1-bridge-status-wait-flake.md) and [fixed wait](../../../../../.agents/.artifacts/common/errors/11-22-a1-bridge-fixed-wait.md)
- [Coalesced checkpoint watermark](../../../../../.agents/.artifacts/common/errors/11-22-a2-checkpoint-coalesced-watermark.md)
- [Managed continuation timeout](../../../../../.agents/.artifacts/common/errors/11-22-a2-managed-continuation-timeout.md), [owned continuation timeout](../../../../../.agents/.artifacts/common/errors/11-22-a2-owned-continuation-timeout.md), and [cancellation-record timeout](../../../../../.agents/.artifacts/common/errors/11-22-a2-cancel-record-sqlite-timeout.md)
- [Ended fake replay cancellation](../../../../../.agents/.artifacts/common/errors/11-22-b2-fake-ended-replay-cancel.md). The injected-late-output finding remains outside this batch.
