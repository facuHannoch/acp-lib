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

### Stage 2: configuration and policy implementation

The implementation adds managed per-session paths, active and saved config
selection, validation, format 4 policy metadata and archive 3 migration,
policy-aware input signatures and transitive notice references, and canonical
checkpoint-policy fingerprints. A mismatched policy reference permits
inspection without executing; legacy incompatible SQLite sessions use an
isolated inspection view. Fresh-home session-file import reopens using saved
config. `29b4856` introduced pure validation and policy helpers; `ad71378` and
`8cb8888` extended the reviewed contracts before their implementation.

The scripted-only config raised a scope question because the existing explicit
`--db` development path also supports OpenRouter. The coordinator confirmed
that this provider needs managed config as part of the work.
Tool dispatch enforcement and consumer approvals belong to Stage 3 and are not
yet implemented; Stage 2 must be reviewed before that work starts.

The user approved extending managed config for OpenRouter. Contract amendment
0017 and its types are submitted separately before provider implementation.
It preserves the existing OpenRouter compatibility key, records only the
environment variable name, and leaves key values in the destination process.
