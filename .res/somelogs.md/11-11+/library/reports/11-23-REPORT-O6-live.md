# O6 step 3 live smoke

**Outcome.** The authorized single run verified live delegation and delivery to the original giving conversation. The forwarded-permission and redirect gate remains open. The worker finished before a forwarded permission reached the runner. Its result went to Alice, so I stopped the run with SIGTERM. Bob's prompt was never sent. There was no retry.

At the time, `INITIAL_AGENT_MODE` was unset. The installed bridge selected its default `agent` mode (Auto review), with on-request approvals and a workspace-write sandbox. The worker wrote inside its own working directory, where the bridge can permit the write without asking. The bridge applies its own mode to the turn, so the runner's `CODEX_CONFIG` sandbox setting did not select read-only.

## Configuration and counts

Ran the hardened runner at `f73fde1` on `orchestrator` with the approved disposable Codex home. The native model was `deepseek/deepseek-v4.1-flash` through OpenRouter. The worker was configured for `gpt-6.1-terra` through the installed Codex ACP bridge. The runner used an eight-minute supervising limit and ran for 82 seconds. It recorded three OpenRouter requests and one ACP worker submission. The Codex CLI did not report a count of its internal model calls. The runner issued one native prompt. Alice's subsequent notice triggered a native turn.

## Model evidence

- Alice said `queued` after delegation.
- The Codex worker said `I’ll run the command exactly as provided.` and returned `orch live ok`.
- Alice said `Worker w1 reported: orch live ok.` on the notice-driven turn.
- Bob had no live turn. The runner did not reach the file-content check or the checks on who could answer an open permission.

The run-owned database showed a single worker assignment with a staged result marked `delivered` to its original destination. I checked that state while the runner was still waiting for the permission and then stopped it. The run ended before the runner’s final timeline-count assertion. It established delivery of the recorded result, with the permission and redirect assertions unverified.

## Cleanup

The consumer drop returned `providerDeleted: true` for `w1`. The runner verified the worker tombstone and empty worker list, and both native conversations were marked deleted. The runner and its supervisor each verified removal of their temporary work trees. The supplied Codex home was left to the user. I did not read, copy, print or remove its contents, and no OpenRouter credential was printed or saved.

## Second and final live attempt

**Outcome.** The second authorized attempt passed from runner commit `0ab13e9` on `orchestrator`. It exited 0 in 11 seconds. It used five OpenRouter requests, two explicit native prompts and two ACP worker submissions. The fifth request was the notice-triggered native turn. The run used `deepseek/deepseek-v4.1-flash` for the native harness and configured the worker for `gpt-6.1-terra`. The bridge did not report a count of Codex's internal model calls. No third attempt ran.

### Offline preflight

The installed `@agentclientprotocol/codex-acp` 2.9.0 bundle sets `read-only` to `on-request` approval with the `user` reviewer, a `readOnly` sandbox and network access disabled. Its mode lookup reads `INITIAL_AGENT_MODE`, and the selected policy and sandbox feed the turn request. The command approval goes through standard `session/request_permission`, with `toolCall.kind` set to `execute` and the command in `toolCall.rawInput.command`. Free mode printed these settings and verified that the ACP projection matches an exact command rule. It passed the scripted stdio delegation test without provider credentials. A separate offline check verified that the trace records the allowed command in redacted form and drops unrecognized command contents and raw option IDs.

### Live evidence

- Alice delegated the one-line file write and replied `queued`. The output file was inside the throwaway tree and outside the worker's working directory.
- The client recorded one ACP request of kind `execute` for `echo 'orch live ok' > [run output]`. It offered `allow_once`, `allow_always` and `reject_once`. Alice saw the forwarded request marked as coming from worker `w1`.
- With Alice's request still open, Bob queued the redirect steer and replied `redirected`. Bob's attempt to answer was rejected. Alice's one-time answer was accepted. The client recorded exactly one response, `allow_once`, and Alice received exactly one matching `permission_resolved`, approved by the consumer.
- The worker returned `orch live ok` and the file contained that line. The redirect event was emitted. The assignment settled as delivered, and the harness timeline contained exactly one external notice, from `w1` to Bob. Bob replied `Worker "w1" reports: orch live ok.`

### Cleanup

Dropping `w1` returned `providerDeleted: true`. The runner verified the worker tombstone, an empty worker list, and both native conversation deletions. The runner and supervisor each verified removal of their temporary tree. The per-run permission trace was deleted with the run tree after its redacted summary was printed. The supplied Codex home remained in place. The runner did not inspect or copy its contents, and no key was printed or saved.
