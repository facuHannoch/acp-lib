# Controller verification on alpha `713a76a`

Merge `4cd3ce96b843f1a9edd9bc42fbc49e379205c69d` on `controller-interface-verify` has verification tip `9016c0c` and alpha `713a76a` as its two parents. All existing verification commits remain in its history. Alpha adds the operator controls, long-running scripted mock, callback policy names and generic external notices.

| Conflict | Resolution |
| --- | --- |
| [NativeController.send](../../../../../src/native/controller.ts) | Kept both sides. Duplicate-ID and stopped checks remain first, then all messages are preflighted for unsupported parts and attachments. Only a valid run reaches alpha's new lazy attachment/start step if the controller has no attachment, and only then the host push loop. An invalid message therefore cannot trigger a push, even when it is later in a multi-message run or sent when detached. |
| [Native checkpoint tests](../../../../../test/native/checkpoint.test.ts) | The conflict was only in the import block. Kept `spyOn` in the Bun import alongside alpha's new imports for operator tests. The media and handoff regressions and all alpha test bodies merged without change. |

## Wire assumptions

The native host opens with `session/open`; attachment and recovery use `channel/observe` and `channel/reconcile`. Conversation paging uses `channel/messages`, and referenced output uses `session/message/read`. Port and item identity, not an ACP session ID, drive recovery. The alpha checkpoint tests exercise those operator paths over scripted stdio, including a trace that checks reconciliation without a history read.

- The native guard tests only use the public conversation API, a spy at `host.push`, and local event and persistence assertions. They make no direct assumptions about the removed native `session/load` or `session/messages` calls. The stand-in host has alpha's `observeAttachment` stub.
- Native conformance still runs all nine shared cases. Its source is unchanged; its shared rig now serializes scripts with the JSONL scenario helper and drives the new protocol through the host. No assertion calls either removed method.
- The fake, ACP characterization, checkpoint strategy and operation-lifecycle fixes remain byte-identical to the verification parent. The lifecycle fixtures exercise ACP load/reconnect behavior and stay separate from the native protocol.
- `src/native/host.ts` grew from **761 to 984 lines** on alpha. The merge adds no changes to that file. `src/agent-session.ts` is 4,612 lines after the merge, versus 4,604 on the verification parent.

## Verification

The checks ran on a clean `git archive 4cd3ce9` at `/tmp/acp-alpha-713a76a.cHjxi3`, with the main checkout's `node_modules` linked. Saved output and hash checks are under `/tmp/acp-alpha-713a76a-logs.Guyr7x`. No live provider was used.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| Focused native probes | 3 passed, 0 failed, 2 files, 3.47 s |
| `bun test ./test`, run 1 | 1,426 passed, 0 failed, 132 files, 292.24 s |
| `bun test ./test`, run 2 | 1,425 passed, 1 failed, 132 files, 286.26 s |
| Repository-root `bun test` | 1,786 passed, 0 failed, 179 files, 432.71 s |
| `bun test ./test`, fresh archive retry | 1,426 passed, 0 failed, 132 files, 245.15 s |
| Characterization runs 1–3 | 35 passed, 0 failed, 1 file and 35 snapshots each; 17.45 s, 14.14 s and 22.70 s |

The native probe run exercised both guard regressions and the multi-message preflight: no invalid media push in either delivery mode, no handoff events or new reset records on early refusal, a successful next prompt, and no partial submission for the invalid second message. The characterization snapshot hash matched before and after every check. Its SHA-256 is `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`.

The second scoped run failed in alpha’s shortened timed rehearsal with `Unused model records`, while all channels were idle with no pending inputs. It passed in the first scoped run, the repository-root run and the fresh archive retry. The first scoped run and retry supply two green gates. The rehearsal uses the native host directly, bypassing the conflicted controller code, and its source and scenario match alpha byte-for-byte. See [the shared error note](../../../../../.agents/.artifacts/common/errors/11-22-alpha-713a76a-timed-rehearsal-unused-records.md). The retry uses `/tmp/acp-alpha-713a76a-retry.fh4Wd0`.

## Follow-up on alpha `ac52dbc`

Merge `035b7d7db7c1503af2cdfafa5652166f21cadfaf` cleanly combines verification tip `32d30d0` and alpha `ac52dbc`. Alpha's `27c7166` adds explicit completion barriers between the shortened rehearsal bursts and reports the blocked stage and pending input sample on a deadline. The follow-up changes three rehearsal files and the harness log. The release code and characterization snapshot are unchanged.

The checks ran on `git archive 035b7d7` at `/tmp/acp-alpha-ac52dbc.wnOjX3` with the main checkout's dependencies linked. The output is under `/tmp/acp-alpha-ac52dbc-logs.8Tc0JI`.

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| Full `bun test ./test`, run 1 | 1,426 passed, 0 failed, 132 files, 254.05 s |
| Five isolated rehearsal file runs | 10 passed and 0 failed each, 50 total (22.49 s, 29.76 s, 12.63 s, 15.77 s, 14.56 s) |
| Characterization file | 35 passed, 0 failed, 35 snapshots, 14.43 s |
| Full `bun test ./test`, run 2 | 1,426 passed, 0 failed, 132 files, 235.94 s |

The characterization snapshot was byte-identical before and after every check (SHA-256 `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`).
