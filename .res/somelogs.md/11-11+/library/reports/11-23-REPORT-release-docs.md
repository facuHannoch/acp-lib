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
