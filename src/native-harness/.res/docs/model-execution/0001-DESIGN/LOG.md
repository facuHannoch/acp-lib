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

Stage 2 work in progress adds the logical-call runner, scripted reservation
adapter, OpenRouter streaming translation and the turn's commit-before-dispatch
path. Focused runner, adapter and loop checks pass using a call-store double.
The existing scripted scheduler test currently fails because the real adapters do
not yet implement the call-store methods assigned to Stage 3. A runner-level
concurrency test is not yet evidence that the real channel remains usable after
an interrupt. The stage boundary and independent review remain pending with Gro;
no Stage 3 storage implementation has been started.
