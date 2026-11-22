# Controller interface verification — native guards

The fixes follow the later native integration findings from [B1](11-22-REPORT-B1-verify.md) and were made on `controller-interface-verify` after the [test flake fixes](11-22-REPORT-flake-fixes.md).

| Commit | Behavior |
| --- | --- |
| `6f4c6c6` | [NativeController.send](../../../../../src/native/controller.ts) checks every run message against the controller's current media flags before the first host push. The check covers structured media and compatibility attachments. It uses the media kind for a structured part and the existing MIME classifier for an attachment. As elsewhere, SVG is handled as file input. Text and pasted text are supported. Both queued and immediately steered file prompts now reject with `UnsupportedError` while valid text work continues. The run-level check also prevents partial submission when the invalid attachment is in a later message. |
| `9bfaf27` | [AgentSession.runHandoff](../../../../../src/agent-session.ts) uses the existing `requireFreshContext` guard before provider readiness or any handoff events or records if the target keeps the current adapter. An unsupported native handoff now returns `UnsupportedError` directly. The test checks both implicit and explicit same-adapter targets, no handoff events, no new action records and a working next prompt on the same context. |

The media guard uses `conversationCapabilities.backend.media`, whose flags are all false today. When M2 adds image input, enabling the image flag and implementing image transport are part of that change. Both guards have entries in [the controller changelog](../../../../../CHANGELOG-controller-interface.md).

A repo search found no production consumer that catches `AgentSessionHandoffError`; the package exports it, and several ACP tests expect it for failures that arise after the handoff has started. That wrapping remains in place. An external caller matching the wrapper for this specific early refusal now receives `UnsupportedError` directly.

The existing option capture moved unchanged into [handoff-options.ts](../../../../../src/handoff-options.ts) to keep the session file from growing. `agent-session.ts` went from 4,641 to 4,604 lines and `native/host.ts` stayed at 761. The extracted file is 41 lines. No snapshot files were modified.

## Verification

Focused native media checks passed (2 tests across 2 files). The native checkpoint and ACP handoff/metering checks passed (22 tests across 3 files), including the existing wrapper assertions. These use offline fixtures. The targeted logs are `/tmp/acp-native-draft.GYX8eA.media.log` and `/tmp/acp-native-draft.GYX8eA.handoff.log`.

Full gates used separate clean archives of `9bfaf27` with linked main-checkout dependencies. Logs and the snapshot check are in `/tmp/acp-native-fixes-logs.l3Klbl`.

| Check | Result | Archive / log |
| --- | --- | --- |
| `bun run typecheck` | Passed | `typecheck.log` |
| `bun test ./test`, run 1 | 1,406 passed, 0 failed, 131 files, 35 snapshots, 198.85 s | `/tmp/acp-native-fixes-1.3WSju5`, `full-1.log` |
| `bun test ./test`, run 2 | 1,406 passed, 0 failed, 131 files, 35 snapshots, 201.12 s | `/tmp/acp-native-fixes-2.jHaLYF`, `full-2.log` |

Both full runs passed on the first attempt. Before and after both runs the characterization snapshot SHA-256 was `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`.
