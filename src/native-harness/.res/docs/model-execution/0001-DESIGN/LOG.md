# Model execution work log

Implementation branch `aiagent/cod1a-model-execution` starts from accepted
configuration/permissions closure `28c6faf7faf3d4d48333498a61ea74f92273cc25`.
Scope commit `0590af9` was cherry-picked as `aeac966`. Stage 1 defines the
contract and decision before runner, adapter, storage, or protocol behavior.
Each stage requires its own gate and Gro's review of the named revision before
continuing. The final gate includes scripted SQLite over real stdio, in-process
parity, full typecheck and the complete offline harness suite.

Stage 1 contract gate: `bun run typecheck --pretty false` passed. Decision
0019 traces retry in both subscriptions, interruption, slow delivery, and the
crash boundaries, including durable receipts, usage and script reservation.
Independent contract review is pending; no dependent implementation is included.

Gro did not approve `741cdff`; the requested contract locks include the existing
wire event, turn outcomes, deadline start, scripted counter, dispatch fence,
receipt/usage validation, transactional migration and bounded delivery. The
revised contract includes those locks and wires the new types into the actual
protocol, events and storage contracts. Standalone contract `tsc` passes. Full
`bun run typecheck --pretty false` is expected to fail until implementations
handle reference messages, storage format 5/archive 4 and model-call methods;
no implementation changes are included in this revision. Gro's re-review is
required before Stage 2.

Gro approved Stage 1 at `a9b5f84f4d165409bc7d9e81ecf15009b484714c`.
Standalone contract typecheck passed independently; the full typecheck's 27
errors were accepted as pending storage and reference-consumer implementation.

## Stage 2: call execution

The logical-call runner, scripted reservation adapter, OpenRouter streaming
translation and turn's commit-before-dispatch path are implemented. The gate
uses a call-store double: `bun test test/model-channel-double.test.ts
 test/model-runner.test.ts test/model-stream-adapter.test.ts test/loop.test.ts`
passed 21 tests, 0 failures and 66 assertions. It covers the same-channel
scheduler after interruption, stop and late response, the permission gate after
commit, retry and deadline, both text-delivery cutoff paths, malformed calls,
and both adapters through the runner.

Full `bun run typecheck --pretty false` remains red on the 27 already identified
storage format and reference-consumer errors. The real `test/scripted.test.ts`
scheduler case fails at missing `startCall` because the memory and SQLite
call-store implementations belong to Stage 3; the other four cases pass. Stage 3
must repeat channel usability and the scripted test on both real adapters, along
with persistence and crash gates. No Stage 3 storage work is included here.
Independent Stage 2 review is pending.

Gro did not approve `c02868b`: final subscriptions received ephemeral text
notifications that the current stdio parser rejects. The protocol publication
filter now drops text_delta, text_gap and text_incomplete for final mode, after
the runner's independent retry cutoff. A protocol regression test verifies
receipts, message_completed, tool and turn events still pass. The expanded gate
(`bun test test/model-final-filter.test.ts test/model-channel-double.test.ts
 test/model-runner.test.ts test/model-stream-adapter.test.ts test/loop.test.ts`)
passed 22 tests, 0 failures, 68 assertions. Full typecheck remains at the same
27 deferred storage/reference errors; the real scripted scheduler remains
blocked on Stage 3's call store. Independent re-review is pending.

Gro approved Stage 2 at `aeb81af68d9dcdbd3619fdeb71608e2165bc5e08`;
their independent focused gate passed 22 tests, 0 failures, 68 assertions.

## Stage 3: storage and streaming

Memory and SQLite use the shared call-store transactions; format 2/3/4 recovery
and migration publish format 5, and logical archive 4 retains call summaries,
script positions and message identity. The stdio parser accepts stream events
and reference completions. A bounded live queue drops deltas with a gap or fails
a blocked connection; oversized committed text is available in bounded byte
pages. The public client exposes message and model-call reads and usage summing.

Both real adapters pass interruption followed by new work, receipt and usage
reopen, script reservation and archive identity tests. SQLite SIGKILL tests on
both sides of response commit check call outcome, timeline identity and the next
reserved script step. Other checks cover final/stream message IDs and ordering,
a slow reader while another channel commits, blocked-queue shutdown, large
UTF-8 reads on both transports, and a storage failure after a streamed draft.
The test using usage reports across reopen uses a clean handle close to simulate
recovery; the SIGKILL fixtures do not themselves report provider usage.

Gate: `bun run typecheck --pretty false` passed; `bun test ./test` passed 282
tests, 0 failures, 3103 assertions across 39 files (57.84s), with local IPC
access. The shared storage engine remains over 400 lines because it owns the
transactional lifecycle and model-call rules for both adapters. Model metadata is
currently serialized as one state record, so updates copy and rewrite that record
as call history grows; performance at large call counts has not been benchmarked.
Independent Stage 3 review is pending. Stage 4 still requires the real scripted
stdio stall/deadline scenario, documentation and final independent review.

Gro did not approve Stage 3 at `2ed06ec`: summary pagination discarded earlier
records when a later summary exceeded a frame, and in-process delivery lacked
the bounded live queue. The fix returns a continuation after earlier whole
summaries and fails only when an oversized summary is first on its page. The
in-process transport now uses the same bounded queue as stdio; nondroppable
overflow closes the connection and stops the session. Regression tests cover
both paging orders, delta drop and gap, and connection failure. No Stage 4 work
is included. Re-review gate: `bun run typecheck --pretty false` passed;
`bun test ./test` passed 285 tests, 0 failures, 3113 assertions across 40 files
(51.79s), with local IPC access. Independent re-review is pending.
