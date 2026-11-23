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

## Step 2a — native turn metering

Commit `f56de5e` collects usage inside the existing operation close. Preparing a native turn captures its wire turn ID directly from the native controller. The same close runs for a live turn, an already-ended backend turn held for the session, and an outcome recovered on reopen. Success, cancellation and error use the same path. The normal operation event and persistence commit carry the evidence under the stable operation ID, with the neutral metering key `<Agent id>/<channel id>`. Provider attachment identity and native `TurnResult.usage` retain their existing behavior.

The record's optional `nativeUsage` carries status, channel, wire turn ID, calls, attempts and the unmeasured count when a ledger read succeeds. The engine sums reported input, output and total independently. It keeps the provider and model unknown, uses `pricing_unavailable` for measured native usage, and publishes partial `native_ledger` provenance without a certification ID. A healthy empty read is unavailable usage for a dispatched turn. A succeeded attempt is withheld if the call is still running or lacks an end timestamp. Host loss produces an unavailable record with its original wire identity and does not start a new harness. A separate test confirms the unverified source cannot be used as a generic certified source or satisfy `billing_required`.

The reader pins one client across pages. Its 15 s total read budget aborts the underlying client request, clears the client's waiter and timer, and leaves other channels free to read. A shorter configured RPC timeout can also settle the request. This is client-side cancellation and adds no wire method. The slow-read test uses the actual native host and `HarnessClient` with a controlled in-process transport. It verifies both explicit cancellation and an elapsed read deadline against the client's default 30 s request limit. The stdio metering tests use the production host and script fixture. Same-channel reads serialize the pull and synchronous drain as one operation, so the next close cannot overwrite the current batch.

The parity gate compared the persisted record against independently paged wire records at `limit: 1` and these fixed script values.

| Alpha attempt | Input | Output | Reported total |
| --- | ---: | ---: | ---: |
| First tool | 101 | 7 | 108 |
| Failed attempt of second call | 55 | 1 | 56 |
| Retry of second call | 207 | 13 | 220 |
| Final reply | 311 | 19 | 330 |
| **Total** | **674** | **40** | **714** |

All three call IDs, four attempt IDs, outcomes and token fields matched the wire. The persisted state accrued 714 tokens in one operation. Beta's interleaved 44 tokens stayed in Beta's operation. Additional stdio tests cover the already-ended backend turn, a kill after the durable terminal commit with one reopen, cancelled and failed turns with confirmed usage, and a host that stays down at close.

| Protected file | Before | After |
| --- | ---: | ---: |
| `src/agent-session.ts` | 4,495 | 4,493 |
| `src/client.ts` | 1,046 | 1,046 |
| `src/controller.ts` | 764 | 764 |
| `src/native/host.ts` | 916 | 909 |
| `src/native/controller.ts` | 599 | 599 |
| `src/agent/conversation-manager.ts` | 1,012 | 1,012 |
| `src/agent.ts` | 563 | 563 |
| `src/metering/engine.ts` | 1,059 | 1,051 |

The host's aggregate summary and the engine's provenance selection moved into focused modules. The durable cursor, failed-save replay and between-turn allocation remain step 2b. The standard wire cannot establish completeness or the route identity needed for billing certification.

### Step 2a gate

The clean RAM-backed archive of `f56de5e` passed the two focused files together (17 tests), and all ten new tests passed 20/20 each in isolated processes. Forcing the call-level seal check to pass unconditionally in a disposable archive made the new regression fail. The normal typecheck and strict typecheck of the new test files passed. The full `bun test ./test` passed **1,635 tests in 153 files in 118.16 s**, including the ACP busy-worker restart case merged from alpha since the step 1 gate. The offline harness protocol, stdio and model suites also passed **24 tests in 3 files in 2.48 s**. All 35 snapshots passed. The A1 hash stayed `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. Logs are in `/tmp/acp-r5-2a.CbsAQ3`.

## HarnessClient review follow-up

Commit `2aff51c` adds seven fake-transport tests for the pre-aborted request, a reply after abort, abort after a reply or timeout, transport closure, a throwing send, and a single signal shared by 64 concurrent requests. They check that the pending map is empty, each registered listener is removed exactly once, and no cancel frame is sent. The client doc explains that `cancelled` ends the caller's wait and the harness may have applied the request.

All seven tests passed 20/20 in isolation. Typecheck and the RAM-backed clean archive gates passed on the first run, with **367 harness tests in 48 files in 21.12 s** and **1,635 application tests in 153 files in 123.61 s**. The A1 snapshot hash was unchanged. Logs are in `/tmp/acp-c1.POwt58`.

## Step 2b — durable native cursor and write replay

Commit `0fdb886` stores the native cursor in the existing metering state. Only wire-confirmed terminal turns with sealed, measured calls can advance it. The reader uses the last call of that turn's accounted channel prefix. It ignores other channels for this proof and retains the old cursor if it sees earlier calls from another turn on this channel. A later known subtotal can be recorded while an earlier gap remains visible. The high-water is persisted with the operation record and restored before the next scan. There is no schema migration.

A native close stages one exact write-ahead record in the existing SQLite metering state, then commits through the normal operation, state and timeline transaction. A failed final save leaves the staged operation and its candidate state intact while the committed cursor and totals stay at their previous values. Open or the next close can finish the same save without starting a provider or rereading its ledger. The SQLite operation index survives pruning and prevents replay from accruing or emitting a new metering operation. A pruned replay supplies the saved completion identity and a detail-unavailable result. Custom backends can expose the optional operation identity lookup for the same pruned-record behavior.

The long-history test seeds 320 other-channel calls in a stopped scripted harness fixture, then reads them through the real stdio server. After accounting for the next own turn, a second Agent restart uses one request with `after: "322"`. Detailed retention stays off throughout. The failed-save test uses a SQLite trigger to reject both commit attempts, checks that the staged record survives with operation count zero and no new cursor, reopens with the trigger removed, and observes exactly 110 tokens followed by 330 after the next paid turn. Recovery adds one operation each time and the old pruned operation ID is still recognized.

Mixed measured and unmeasured attempts keep their known subtotal and carry an explicit reason. The persisted aggregate coverage remains partial, and the cursor stays before the gap. Unknown or undispatched operations with a metering record are unavailable. Queued cancellation can return no record. Neither is evidence of zero spend. Replay preserves an already committed partial or unavailable record as recorded. This step does not perform retroactive replacements of committed evidence, and a same-channel gap can keep the cursor behind the unresolved tail. The supported restart path uses the same durable harness ledger.

Native `billing_required` now reports the missing `native-harness@1` sealed per-turn accounting capability before a conversation is created or a harness is admitted. The static refusal also covers custom launchers. Between-turn accounting waits for the harness producer and bounded idle contract. There are no channel-close sweeps or native certification claims.

| Protected file | Before | After |
| --- | ---: | ---: |
| `src/agent-session.ts` | 4,493 | 4,495 |
| `src/client.ts` | 1,046 | 1,046 |
| `src/controller.ts` | 764 | 764 |
| `src/native/host.ts` | 909 | 909 |
| `src/native/controller.ts` | 599 | 599 |
| `src/agent/conversation-manager.ts` | 1,012 | 1,012 |
| `src/agent.ts` | 563 | 563 |
| `src/metering/engine.ts` | 1,051 | 1,059 |

### Step 2b gate

The clean RAM-backed archive of `0fdb886` passed the three focused files together (21 tests), and all four new tests passed 20/20 each in isolated processes. Typecheck passed. The full `bun test ./test` passed **1,639 tests in 154 files in 125.66 s**. All 35 snapshots passed, with the A1 hash unchanged at `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`. Step 2b did not change the harness client or harness tests. Logs are in `/tmp/acp-r5-2b.kgHHkz`.
