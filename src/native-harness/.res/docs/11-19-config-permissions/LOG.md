# Configuration and permissions work log

Branch `aiagent/cod1a-config-permissions`, based on session-file closure
`df43007`. Spec/plan `821f5f6` cherry-picked as `610451d`. Implementer:
cod1a-m; independent reviewer: gro1a-o; coordinator: haurness-l.

## Stage 1: contract and decision

Decision 0016 and the contract types define config provisioning, durable policy
references, approval wire messages and lifecycle ordering. Contract review is
required before implementation. Typecheck and the retry, notice/restart and
suspension/dispatch traces are the gate.

Gro reviewed `92605f3` without approval and requested locks for legacy migration
and signatures, canonical checkpoint fingerprints, initialization and interrupt
semantics, and incompatible execution and channel policy edits. The follow-up
records those requirements; Stage 2 remains blocked on independent approval.

Gro approved contract revision `d09cb7e`; their independent typecheck passed.
Stage 2 is in progress. Its first increment provides pure config validation,
policy precedence, canonical policy fingerprints, signature and inherited
reference helpers, and `config/validate` over both client transports. These do
not yet enforce policies at dispatch or provide managed reopen. The focused
validation and policy tests are separate from the required Stage 2 gate.
