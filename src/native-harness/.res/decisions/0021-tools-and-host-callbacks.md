# 0021: Tool catalog, invocation lifecycle and host callbacks

## Problem

A consumer needs to register functions the model can call. Today tools are
fixed by session assembly, a call has only the provider's ID, a skipped or
timed-out call is indistinguishable in storage from a success, and the protocol
carries requests in one direction only. See the
[spec](../docs/tools-and-callbacks/0001-DESIGN/SPEC.md).

## Options

Catalog in the managed config, or supplied with each open. Invocation records
in a new table, or derived from the evidence storage already keeps. Callback as
a host-polled queue, or a request from harness to host on the same connection.
Large results stored by the harness, or by whoever produced them.

## Choice

**Catalog.** `session/create` and `session/load` take `tools: { catalog,
enabled?, defaultDeadlineMs? }`. Each entry is `{ name, description,
parameters, handler, group, deadlineMs? }`; `group` is `fixed`, `revocable` or
`runtime`. Definitions are supplied on every open and are not stored. Names are
unique across the catalog and the built-ins; a duplicate, a malformed entry or
an `enabled` name that is not a `runtime` entry rejects the open with nothing
opened. A repeated load must repeat the same `tools` or omit it
(`invalid_state` otherwise). `tool/revoke` and `tool/restore` act on
`revocable` entries and are durable; `tool/enable` and `tool/remove` act on
`runtime` entries and live in memory; any of them on another group is
`invalid_state`, an unknown name `not_found`. `session/tools` lists every
entry with `available` and, when false, one `reason`: `revoked`,
`not_enabled` or `handler_missing`. Availability says nothing about policy.

**Handlers.** `initialize` accepts `callbacks: ["functions/call"]` and
`functions: string[]`, the handler names this connection serves. A tool whose
handler is not served is unavailable. A server advertises
`capabilities.functions: true`.

**Offered tools.** Each inference offers the built-ins and the available
catalog entries that the turn's policy does not deny, fixed group first, then
by name. `ModelRequest.fixedToolCount` marks the stable prefix. The request is
frozen for the call, so a retry offers the same list. The set offered by the
latest inference is what dispatch checks against.

**Dispatch order**, at the existing gate: policy (`deny` gives
`policy_denied`, as before); for a catalog tool, offered in this request and
still available (`tool_unavailable`); arguments valid against the definition
(`invalid_arguments`); approval when policy says `ask`; availability again
after the approval (`tool_unavailable`); then dispatch evidence and the
executor. A pending approval is closed when its tool becomes unavailable. Every
skip commits the one paired result and dispatches nothing.

**Invocation.** The invocation ID is `<turnId>:<toolCallId>`; storage already
refuses a repeated call ID within a turn. A tool result may carry `outcome:
{ status, code?, reference? }`, `status` one of `succeeded`, `failed`,
`skipped`, `interrupted`; a result without it is a legacy success. The record
is derived, with no new table: `requested` (call committed, nothing else),
`waiting_for_approval` (live only), `started` (dispatch evidence, no result),
the stored `outcome`, or `interrupted` with `effect: "unknown"` when the turn
ended with evidence and no result. `tool_call` events carry `invocationId` and
gain `skipped` and `interrupted`. `session/tool-invocation` returns one record
by ID; `session/tool-invocations` lists a turn's.

**Callback.** After evidence commits, the harness sends a request
`functions/call` `{ invocationId, sessionId, channel, turnId, tool, handler,
arguments }` with its own numeric ID; IDs are per connection and per
direction. The host answers `{ output }`, `{ preview, reference }` or an error
`{ code, message }`. `functions/cancel { invocationId, reason }` is a
notification. A response is matched by request ID to an outstanding wait; one
for a closed wait is ignored. Handlers run off the read loop.

**Deadlines.** `deadlineMs` per tool, else `defaultDeadlineMs`, else none.
The clock starts at dispatch. On expiry with the turn live: cancel, commit one
paired result `tool_timeout` (`interrupted`, effect unknown), continue. An
interrupt or stop cancels and ends the turn under 0014 and 0018. A lost
connection fails the wait; the call stays dispatched without a result, so it
is uncertain and never repeated.

**Phase.** `activeTurn.phase` is `{ kind: "model" | "approval" | "tool", since,
id? }` with the model call, approval request or invocation ID. In memory.

**Large results.** The inline limit is 16384 bytes of serialized output. A
producer with more stores the bytes itself and returns `{ preview, reference:
{ resultId, bytes, retention, expiresAt? } }`. The reference is kept in the
tool result's `outcome`. The built-in `read_tool_result { result_id, offset?,
length? }` is offered while a catalog exists; the harness resolves the ID
against the references recorded for the requesting channel only, then sends
`results/read { resultId, invocationId, channel, offset, length }` to the
host. Unknown IDs and paths are `result_not_found`, another channel
`result_forbidden`, an expired result `result_expired`. An inline output over
the limit that reaches the harness fails `result_too_large`.

## Compatibility

Wire additions are optional. An old client sends no `functions` and receives
no callback. `tool_call` gains two statuses that only catalog tools produce.
Storage: `revokedTools` joins the snapshot and archive as an optional field,
and a tool result accepts `outcome`; SQLite format stays 5 and the archive 4,
as 0018 did for dispatch evidence. A file written here opens on the previous
revision except for results carrying `outcome`.
