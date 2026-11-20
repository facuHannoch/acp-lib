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
