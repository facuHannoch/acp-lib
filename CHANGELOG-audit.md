# Agent audit log — breaking changes and release notes

Pre-1.0 changes introduced by the SQLite-backed Agent audit stream
(`.res/somelogs.md/9-16+/9-18-SPEC-agent-audit-log.md`). Fold this into the release notes.

## 1. SQLite schema version 8

Schema version 8 adds the durable Agent audit state and pending outbox. Pre-release
version-7 databases are intentionally not migrated; recreate development and smoke-test
databases before opening them with this release.

The SQLite database remains the conversation-recovery source. Audit JSONL files are an
independent operational history, not a second recovery backend.

## 2. One optional audit stream per Agent

`Agent.open()` accepts `auditLog`. Its caller-selected directory contains one logical
stream across all conversations owned by that agent, split into numbered JSONL segments.
Capture policy is evaluated from the normalized observation independently of canonical
SQLite capture, so either side may retain more detail than the other.

Canonical persistence and outbox enqueue share a transaction. Delivery happens in the
background, is ordered, durable, and at least once. Entries carry stable audit sequence,
outbox, source-observation, agent, and optional conversation identifiers.

## 3. Rotation, recovery, and observability

Size and age triggers rotate the stream without changing its identity. Startup validates
the contiguous segment set, repairs only an incomplete highest tail, and reconciles the
bounded physically written but unacknowledged suffix against SQLite. Missing delivered
history and identity conflicts fail closed.

`agent.audit` exposes `status()`, `subscribe()`, `flush()`, and `retry()`. `Agent.close()`
attempts a bounded flush and preserves undelivered rows for the next open.

`AgentAuditLogReader` provides paginated `logical` and `physical` views. Logical mode
deduplicates the bounded crash-replay window; physical mode preserves it for diagnostics.

## 4. Explicit single-owner rule

One live process owns an agent SQLite database, and one live writer owns an audit
destination. A second open fails with `AgentDatabaseInUseError` or
`AuditLogDestinationInUseError`. Any number of conversations may still execute
concurrently through that owning `Agent` instance.

## 5. Accepted initial limitations

- Audit configuration cannot change while an Agent is open.
- All numbered segments are required; automatic retention is not included.
- Enabling audit later does not backfill canonical history.
- Age rotation is evaluated on delivery, not by an idle timer.
- Files are plaintext and unsigned.
- Entry-level syncing prioritizes crash recovery over maximum raw-protocol throughput.
- Custom persistence backends cannot enable Agent audit until they implement the durable
  audit outbox contract.

The older `SessionManager` transcript/audit system remains supported and is not silently
redirected to this Agent-level stream.
