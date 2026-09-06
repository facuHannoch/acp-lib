# test6 — metering persistence contract

The executable contract for the division of labour in
[`9-6-SPEC-metering.md`](../../.res/somelogs.md/9-5+/9-6-SPEC-metering.md) §11: the
library is operatively stateful while an `AgentSession` object lives, but owns **no
durable accounting database**. It hands the consumer an immutable record per operation
plus the state to persist beside it. The consumer stores both, and supplies the last
state when it rebuilds the session.

This test plays that consumer — a small `UsageRepository` backed by a JSON file — against
a deterministic fake harness, so it needs no credentials, network, or model tokens:

```bash
bun smoke-tests/test6-metering/metering-smoke.ts
```

Exit codes:

- `0` — the persistence contract holds.
- `1` — one or more checks failed.
- `2` — the fixture could not start, so the contract was not exercised.

## What it proves that a unit test cannot

Lifetime totals survive the `AgentSession` **object** being destroyed and rebuilt, with
no transcript and no `SessionManager` involved:

```text
object lifetime 1        two operations      totals 200
  commit(record, record.nextState)  ->  usage.json
object destroyed
object lifetime 2        initialState from usage.json
  one operation                          totals 300
```

The interesting assertion is the first operation after the restore. The fake harness
reports **cumulative** counters, so without the restored baseline that operation would
attribute the entire running total (300) instead of its own delta (100) — silently
tripling the bill. The check pins the delta.

## Why the fixture takes `--resume=N`

A real provider thread that is resumed keeps counting; its counters do not restart. A
fresh subprocess would restart them, and the library reads that — correctly — as a
`counter_reset` and refuses to attribute anything.

`--resume=N` makes the fake harness continue from turn `N`, modelling the persistence a
resumed thread actually has. Without it the restore case tests the reset path rather than
the restore path, which is a different (also correct) behaviour.

## Committing records and state together

`UsageRepository.commit()` writes the record and `record.nextState` in one operation. A
record stored without its state leaves the next session with a stale baseline, which is
the one way to get double-counted usage out of a correct library.

The repository also keys on `operationId`, which is what makes duplicate delivery
idempotent (§19). Committing the same record twice leaves three rows, not four.
