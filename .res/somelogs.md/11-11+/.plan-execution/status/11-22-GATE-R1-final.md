# Gate: R1 complete (durable channel intents)

`native-integration-r` at `70ba71a` (on alpha `44bbc25`): steps 0–4 and 3b, the `beforeDispatch` hook, the resume
guard, the schema-17 repair and the final docs. Final review: clad2a, `fd0485c` (complete and correct, docs
additions done in `70ba71a`, a docs-only diff).

| Check | Result |
| --- | --- |
| Clean copy | `git archive 70ba71a` into `/tmp/corep-gate-r1.Byp8`, `node_modules` linked |
| Typecheck | clean |
| Full `bun test ./test`, run 1 | **1,463 pass**, 0 fail, 132 files, 209.9 s |
| Full `bun test ./test`, run 2 | **1,463 pass**, 0 fail, 132 files, 210.0 s |
| Snapshot | sha256 `fbc6ec2c…` unchanged since spec 1 |
| Large files (start → end) | `host.ts` 984 → 884; `conversation-manager.ts` 1,098 → 1,089; `agent-session.ts` 4,604 → 4,567 |
| Schema | 17: the channels repository and `conversations.controller_kind`, with the repair for an early 17 |

**Verdict: passed.** R1 is ready for the user's merge as `pre-alpha`. For the spec owner: the R1 wording listed in
the final review. Worker delivery (`b53abf2`, Cod1a) merges after this, once it is re-verified on the final schema 17.
