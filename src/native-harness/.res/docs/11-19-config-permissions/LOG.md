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

Gro approved amendment `6cac6d2`: a custom `apiKeyEnv` is resolved only by
that name, without falling back to `OPENROUTER_API_KEY`. The key value and
variable name are deliberately excluded from checkpoint fingerprints; changing
the referenced credential therefore does not block resume. A legacy direct
`provider.apiKey` can be used for the current open only when no saved config
exists, and is never persisted. The destination must supply the saved reference
on later opens. Provider tests use injected offline models and fake secrets.

The Stage 2 implementation supports scripted and OpenRouter managed configs,
keeps the original provider checkpoint key, resolves the selected environment
reference on open, and does not persist credential values. Fake-provider tests
cover fresh-home import/reopen, custom environment selection, missing keys,
sidecar/model precedence, model and reference checkpoint compatibility, and a
pre-managed provider checkpoint. Provider error text is redacted if it echoes
the credential. SQLite statement cleanup was tightened after a migrated-session
reopen exposed a lock retained by prepared statements. `engine.ts` remains over
400 lines because both adapters share its transactional lifecycle and policy
rules; splitting that engine is deferred to a dedicated change.

Stage 2 gate: `bun run typecheck` passed; `bun test ./test` passed 209 tests,
0 failures, 2753 assertions across 25 files (52.39s), using local IPC access.
The gate includes both-adapter migration and inherited-notice tests, managed and
explicit-db reopen, fresh-home session-file import, and offline fake-provider
credential and checkpoint tests.

Gro approved Stage 2 at `47cd4df`; their independent typecheck passed and the
full suite passed 209 tests, 0 failures, 2753 assertions (73.23s).

## Stage 3: dispatch and approvals

Gro approved dispatch-evidence decision 0018 at `4ef6286`, confirmed distinct
interrupt/stop close codes in `d67c693`, and approved owner-config binding at
`00ecb36`. The gate resolves policies from the storage owner's immutable config,
tracks approval requests and unused grants, and commits dispatch evidence before
invoking a tool. Pending approval closure writes its paired result before live
interrupt, stop or checkpoint; crash recovery never replays a request or grant.
The stdio and in-process paths expose the same approval event and answer request.

Gate: `bun run typecheck` passed; `bun test ./test` passed 243 tests, 0 failures,
2917 assertions across 29 files (64.41s), with local IPC access. Focused tests
cover policy precedence at take, inherited notices, deny/unhandled/timeout/
disconnect, one-time grants, both suspension/dispatch orders, reentrant
interrupt and stop, a real crash with approval pending, legacy and invalid
dispatch evidence, and owner-config mismatch/failure/mutation on both adapters.
Independent Stage 3 review is pending. Stage 4's public end-to-end scenario and
documentation remain outstanding.
