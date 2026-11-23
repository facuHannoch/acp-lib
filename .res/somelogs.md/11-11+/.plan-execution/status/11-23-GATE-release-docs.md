# Gate: the release docs (guide, migration note, README, `files`) with the native ledger test guard

`release-docs` at `b8d627b` (alpha `510e2a7`): `da4e0c0`, the fixes `b8d627b` (`CONSUMER_GUIDE.md`, `MIGRATION-0.12-to-0.13.md`, `README.md`,
a note in `MIGRATION-0.10-to-0.12.md`, the `files` allowlist), merged with the test guard `8ba7662` (`integration-r456`, a bounded guard on
`test/metering-native-source.test.ts`). Alpha has since moved by two docs-only commits (the reminders and routines spec). Reviews
(clad2a): `0cac532`, `8964e86`: clean.

| Check | Result |
| --- | --- |
| Clean copy | the merge of `release-docs` and `8ba7662`, `TMPDIR` on `/dev/shm` |
| Typecheck | clean |
| Full `bun test ./test` | **1,678 pass**, 0 fail, 162 files |
| Snapshot | sha256 `fbc6ec2c…` unchanged |
| Footprint | `src/` identical to alpha; `test/` differs by the one guard (+12 −2); package.json: two `files` entries; version still 0.12.1 |
| Pack dry run | 515 files, 4.61 MB; no secrets, `.env`, `.mcp.json` or auth files; no `defaultPermission` left in any packed path except migration history |
| agents-core | with the documented edits and test doubles: types back to the 0.12.1 baseline byte for byte (cod2a 112, 125, 112; clad2a 91, 104, 91 in a layout with the sibling package); runtime: steer 9, then 1 pass and 8 fail, then 9; acceptance 11, then 9 and 2, then 11; `hub.test.ts` can't load in a scratch tree (macro import) |

**Verdict: passed.** Public surface 828 to 913 exports, all 828 kept; the only newly required members: `PersistenceCapabilities.channels`,
`PromptHandle.withdrawAsync`, `AgentEventBus.subscribeWorkers`; the only widened literal union `LaunchKind`; `turn_started` now requires
`cause`. Left to the owner: the version and tag, the pack contents (the 103 internal design docs, 708 KB of harness tests, twelve files
containing the author's absolute path), the `.mcp.json` token.
