# Persistence

The [storage contract](../../src/contracts/storage.ts) has two adapters over
one [transaction engine](../../src/state/storage/engine.ts). Memory uses maps
and lasts for the process. SQLite uses `bun:sqlite`, `synchronous=FULL`, and
an exclusive owner for each session file. Model inference, tool execution,
and network waits happen outside storage transactions.

## Durable boundaries

1. Receipt commits the accepted input to the inbox, keyed by its stable ID.
2. Take associates it with a turn and appends its timeline entry.
3. A model response commits its assistant message and recorded calls.
   The model runner also records attempts and provider-reported usage.
4. Tool dispatch evidence precedes possible external effects. The paired tool
   result commits separately.
5. Turn outcome and suspension checkpoints commit before they are reported.

The storage snapshot includes configuration and policy metadata, channel
lifecycle and identities, pending and taken input, timeline entries, turns,
checkpoints, and model-call records. SQLite format 5 is the current on-disk
schema. Storage and context rendering have separate contracts.

## Recovery

Opening storage runs recovery before execution. Clean suspension preserves
checkpoints. Abrupt loss interrupts unfinished turns outside a clean
suspension, while committed individual channel suspensions and their
checkpoints survive. Untaken inputs stay pending. An interrupted turn retains
committed output and reports tool calls whose effects are uncertain. The
harness never automatically repeats those calls.

Transport events are live. Use `session/load` and its message pages to recover
committed replies or outcomes after a disconnect. The protocol writes the
initial load response before starting recovered work. On the integration
branch, startup channel changes are applied before pending input becomes
eligible. See [the integration log](../docs/acp-client-integration/0001-DESIGN/11-20-LOG.md)
for the acceptance status and the current startup batch limitations.

## Session files

Export writes a binary `.harness` envelope, version 1, containing the logical
archive (currently version 4) and active portable configuration. Use a path
when the host and harness share a filesystem, or the protocol's bounded
transfer otherwise. Export requires clean suspension or a running session
without active or checkpointed turns, pending input, or a suspending channel.

Import validates the file and creates a new stored session without starting
it. A managed reopen can use the saved configuration. Credentials remain
environment references and script paths still require the destination's
script. Tool-owned external state stays with its owner. To relocate an agent,
stop the source before resuming the imported copy.

See [persistence](../docs/11-16-persistence/SPEC.md),
[the session-file amendment](../docs/persistence/0002-AMENDMENT-session-file/SPEC.md),
and [the lifecycle guide](suspend-and-resume.md).
