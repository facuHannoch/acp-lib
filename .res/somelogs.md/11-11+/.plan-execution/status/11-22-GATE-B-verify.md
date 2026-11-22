# Gate: B1 and B2 verification, with the fixes (controller interface)

Commit `9016c0c` on `controller-interface-verify`: B1 and B2 reports (`79627f6`, `7c00cb7`), the test/doc batch
(`d3f7544`…`66fa496`, report `f30f3e3`) and the two native fixes (`6f4c6c6`, `9bfaf27`, report `9016c0c`).
Reviews (clad2a, no blocking findings): B1 `b93fbad`, B2 `e370f4f`, flake fixes `189eea6`, native fixes `b3519fb`.

| Check | Result |
| --- | --- |
| Clean copy | `git archive 9016c0c` into `/tmp/corep-gate-b.TXu1`, `node_modules` linked |
| Snapshots | no `__snapshots__` changes since `d11cd18`; sha256 `fbc6ec2c…` |
| `src/` changes | only the two authorized native fixes (`src/native/controller.ts`, `src/agent-session.ts`, new `src/handoff-options.ts`) |
| Typecheck | clean |
| Full `bun test ./test`, run 1 | **1,406 pass**, 0 fail, 131 files, 235.9 s |
| Full `bun test ./test`, run 2 | **1,406 pass**, 0 fail, 131 files, 211.1 s |
| Test count | 1,402 baseline + 1 (fake ended-turn case) + 3 (native fixes) |
| Large files | `agent-session.ts` 4,641 → 4,604; `host.ts` 761, `conversation-manager.ts` 1,098, `client.ts` 1,092, `controller.ts` 840: none grew |
| Reviewer verdicts | hold for `9016c0c` |

**Verdict: passed.** Spec 1 verification is complete.

For the spec owner (wording): dropping late output is the controller's contract (the session has no guard);
the conformance suite runs on the lifecycle fixture, not echo; steer is covered by dedicated tests, not the shared
nine; the REPL takes the concrete controller; the session doesn't read the load and fork flags (AcpClient enforces
them); plus the A1 and A2 items in their gate files.

For M2: native send pushes only `message.text`. Turning on `media.image` without forwarding parts in the same change
would drop images silently again (clad2a, `b3519fb`).
