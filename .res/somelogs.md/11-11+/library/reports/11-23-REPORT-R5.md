# R5 native usage

## Grounding and step 1

Commit `f4d9fab` amends the brief. The in-turn gate now compares against the scripted attempt values as well as an independent ledger pull. It separates in-turn parity (2a) from durable replay, the accounted cursor and the between-turn sweep (2b). Native route identity remains unknown, so pricing is unavailable on the current wire. The strict admission gate for R5 verifies refusal. Enabling native billing, per-call usage events and native `TurnResult.usage` are deferred as described in the brief. [Amended grounding](11-23-REPORT-R5-grounding.md)

Commit `47e2750` adds the bounded ledger reader, projection and synchronous inference source. The reader accepts an accounted call ID, checks page progression, and filters by both channel and wire turn ID. Its last seen ID describes the read and does not acknowledge accounting. Independent channels can pull through the same reader. Each pull owns its elapsed and page budgets. A failed pull clears staging and surfaces its error.

The projection preserves call IDs, attempt IDs, outcomes, retries and exact token field presence, including explicit zero. A running or incomplete attempt remains visible as evidence. Only sealed attempts with all three reported token counts enter the synchronous drain keyed by `<Agent id>/<channel id>`. An empty provider or model string is the unknown sentinel in the current string-only inference type. The native evidence carries no configured route, price or certified provenance.

The source is ready for step 2a to connect to the operation close and persistence paths. Step 2b owns the durable high-water, replay and between-turn sweep. The step 1 cursor gate supplied the accounted ID at call 400 and checked that the final three calls took exactly two page reads. It also exercised duplicate and stalled cursors, a failed host read, elapsed and page budgets, reopening a running call after it sealed, missing fields, and a hung pull that did not delay another channel.

| Protected file | Before | After |
| --- | ---: | ---: |
| `src/agent-session.ts` | 4,495 | 4,495 |
| `src/client.ts` | 1,046 | 1,046 |
| `src/controller.ts` | 764 | 764 |
| `src/native/host.ts` | 916 | 916 |
| `src/native/controller.ts` | 599 | 599 |
| `src/agent/conversation-manager.ts` | 1,012 | 1,012 |
| `src/agent.ts` | 563 | 563 |
| `src/metering/engine.ts` | 1,059 | 1,059 |

New modules are 80 lines for the ledger reader, 110 for evidence projection and 56 for the source. The harness wire and OpenCode implementation were unchanged.

### Gate

The seven new tests passed together and 20/20 each in isolation from the clean archive of `47e2750`. RAM-backed typecheck passed and `bun test ./test` passed **1,624 tests in 152 files in 125.02 s**. All 35 snapshots passed. The A1 hash stayed `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. Logs are in `/tmp/acp-r5-step1.TuqPs5`.
