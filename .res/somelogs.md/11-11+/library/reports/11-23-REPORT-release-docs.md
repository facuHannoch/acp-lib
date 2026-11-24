# Release documentation and 0.12.1 migration verification

Branch `release-docs` starts from merged alpha `510e2a7`. The consumer guide
covers permission decisions and events, deferred and cancellable startup,
native OpenRouter and scripted harness setup, worker orchestration, durable
delivery and the offline smoke entry point. `MIGRATION-0.12-to-0.13.md` covers
the one-way schema 16 to 21 upgrade, caller-facing changes and explicit
agents-core edits. Package version remains 0.12.1.

## agents-core scratch comparison

Symlinked the agents-core checkout into two scratch trees, isolated each
`node_modules` package link, and used its own TypeScript compiler. The baseline
used the installed 0.12.1. The candidate used a local archive of `510e2a7`
with the library's dependencies linked in. The baseline reported 112
`src/` diagnostics and the candidate reported 125. The 13 additions were
nine permission configuration diagnostics, one launcher kind diagnostic,
one controller narrowing diagnostic and two branded context diagnostics in
the internal resolver test. A separate copied source tree with the migration
edits returned byte-for-byte to the baseline diagnostics. The recording
test's two diagnostics come from resolving the branded ID through both a
public package link and a relative internal path. The proposed edit ties
that fixture's type to its existing resolver. No agents-core files were
edited. Scratch logs are under `/tmp/acp-release.ywAUlH`.

## Guide examples and packaging

Extracted and type-checked all seven changed TypeScript blocks against the
archived source using the repository's compiler options. The managed create
and load blocks were checked with the surrounding guide's adapter and
session-manager context. Ran the examples offline with a fixture ACP
provider, a temporary SQLite database, and local scripted native models.
This exercised consumer permission decisions, deferred reopen and first
use, direct startup cancellation, native approval and receipt events, worker
controls, and managed create and reopen. The documented orchestrator offline
smoke passed. The existing native policy-blocked delivery test also passed,
including explicit retry. No real provider calls were made.

The pack dry run lists both added documents and the consumer guide, retains
the 0.12.1 version, and lists the native harness CLI source. Package exclusions
were left as configured. No library source or tests changed.

## Release review follow-up

The migration now separates upgrade requirements for existing consumers from
opt-in native and orchestration behavior. A TypeScript compiler API comparison
of the installed and archived package entries counted 828 exports in 0.12.1
and 913 in alpha, with all 828 retained. The package exports map and
dependency fields match. The type audit identified the new required channel
capability, prompt-handle and event-bus methods, turn-start cause, additions
to concrete class shapes and the widened adapter, event, startup and
metering discriminants. The migration distinguishes required
`capabilities.channels` from the optional `workers` and `workerDelivery` flags
and the optional repositories.

The scratch compiler again reported 112 baseline diagnostics, 125 after
switching to alpha and byte-identical baseline diagnostics after the
documented source and test-double edits. That comparison verifies types.
The runtime check used separate scratch copies with the same installed
dependencies and linked both local sibling packages.

| agents-core file | Published 0.12.1 | Alpha, source edits only | Alpha, source and double edits |
| --- | ---: | ---: | ---: |
| `steer-delivery.test.ts` | 9 pass | 1 pass, 8 fail | 9 pass |
| `user-chat-acceptance.test.ts` | 11 pass | 9 pass, 2 fail | 11 pass |

The note names every identified double and shows the method that preserves
its mutable connection. We could not run `unit/hub.test.ts` in the scratch
layout. Importing its Docker configuration fails before any test starts
because the `bundledImageSources` macro is unavailable.

Both README startup blocks compile against alpha and ran with an offline
fixture adapter substituted for Codex. The package dry run lists
515 paths and still reports 0.12.1 with the same exclusions. An exact-word
search of every packed path found `defaultPermission` only in the migration
instructions, changelog and a dated historical native harness design log.
The old migration guide now links to the new one as the next step from
0.12.1. The orchestrator section is labelled experimental and names the
worker event kinds and delivery states. No library source, tests, or
agents-core checkout files changed. The audit, compile and runtime logs
are under `/tmp/acp-release.ywAUlH`.
