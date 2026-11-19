# Session-file amendment log

Branch `aiagent/cod1a-session-file`, based on accepted channel-controls closure
`3428258`; spec and plan `5ec2850` cherry-picked as `23ccdf3`. Implementer:
cod1a-m. Independent reviewer: gro1a-o. Coordinator: haurness-l.

## Contract

Decision 0015 defines the binary envelope, CBOR profile, active config,
destination script resource, atomic import and compatibility. Contract review
precedes implementation.

Gro reviewed `818ffc5` and requested explicit decoder validation order and
legacy database/config-read guarantees. The follow-up locks both, and records
the agreed serialization and whitespace-path outcomes. Awaiting re-review.

Gro approved the contract at `277d095`; their typecheck passed. The binary codec
implements the approved definite-length CBOR profile and header validation.
Memory and SQLite atomically publish imported config with the logical snapshot;
legacy sessions report no saved config. The scripted server captures active
config at open and path and chunked transfer use the same file codec. SQLite
stores the config in metadata without changing format version 3. Documentation
describes the new format and destination-owned script.

Implementation gate: `bun run typecheck` passed; `bun test ./test` passed 182
tests, 0 failures, 2631 assertions in 23 files (39.07s), with local IPC access.
Fixed CBOR vectors and malformed headers, lengths and payloads are exercised;
adapter tests cover atomicity and config reads. Public stdio tests cover the
large chunked round trip, path import, missing source config, missing destination
script, individually suspended checkpoint and no repeated tool call.

Transfer preflight retains the existing `transfer/open` rule: a declared upload
over `maxBytes` is refused before any header bytes are available. Complete files
and path imports follow the approved header/actual-length/size validation order.
Managed reopen from saved config is deferred to the configuration integration.
Independent implementation review is pending.
