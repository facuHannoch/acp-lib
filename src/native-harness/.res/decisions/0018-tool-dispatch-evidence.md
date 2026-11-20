# Durable evidence at the approval dispatch boundary

## Problem and choice

Decision 0016 requires interruption or a crash while approval is pending to
report no uncertain effect, while a dispatched call with no result remains
uncertain. An assistant's durable call record alone cannot distinguish these
states. Alternatives are volatile tracking (lost on crash), recording a skipped
result after interruption (violates the turn fence), or durable dispatch evidence.
Choose evidence in the existing turn state, without a schema-format bump.

Every append of an assistant message with calls to a running turn ensures
`dispatchedCallIds` exists in that same transaction. If absent, set it to `[]`;
do not add the new calls. This includes the next such append on a resumed legacy
checkpoint: absence is conservative only until that write. `markToolDispatched`
succeeds only when the turn is running, the call belongs to that turn, no tool
result exists for it, and its ID is not already listed. Every other mark,
including a duplicate, fails and writes nothing; failure neither invokes the tool
nor emits `started`. The marker is evidence, not a grant.

Any `beforeToolDispatch` barrier resolves before the final cancellation check.
After it resolves, the gate reads both interrupt and suspension signals again.
The no-await span starts at that check: commit evidence, invoke the executor
synchronously, and publish `tool_call:started` before awaiting the returned
promise. Invoking before event publication prevents a reentrant event listener
from interrupting between the started event and the invocation. A crash after
evidence commits but before invocation can conservatively report an uncertain
effect; it never causes an automatic replay.

Carry dispatch IDs through checkpoint/resume. If the list is present,
`uncertainCallIds` is the unanswered call IDs in that list; if absent, every
unanswered call is uncertain. Crash recovery neither appends a tool result nor
replays a call. Live interrupt, stop, suspension, deny, timeout, disconnect, and
missing consumer write the one paired result for a closed, undispatched approval
while its turn is still running, before the turn ends. Interrupt and stop close
the request and commit that result before committing the turn's terminal state;
after that state no result is appended. Dispatched calls without results retain
the existing uncertain-effect rule.

The paired result for an undispatched approval closed by a single-turn interrupt
uses `approval_cancelled_by_interrupt`; session stop uses
`approval_cancelled_by_stop`. These are distinct from
`approval_cancelled_by_suspension` and are not the turn's interrupt reason.
Already-dispatched calls receive neither code and keep the uncertain-effect rule.

Import accepts an absent list. A present list must consist of unique nonempty
strings, each naming a call belonging to the same turn; otherwise import writes
nothing. A suspended turn still cannot contain an unanswered call. The marker is
internal evidence, not an approval record. SQLite `formatVersion` stays 4,
logical archive version stays 3 and session-file envelope version stays 1.

The scheduler exposes a per-turn suspension signal that aborts for session
suspension or this turn's own channel suspension only. It is distinct from the
interrupt signal and is never passed to `ExecuteTool`. Once marking succeeds,
suspension does not abort that call; interrupt still does. Any later ask in the
finishing iteration gets `approval_cancelled_by_suspension` without opening a
request. The gate consumes approval only at dispatch; its last check observes
both signals. The loop receives a gated result and never directly invokes a tool.
`approval_requested` is an always-on channel event; `approval/respond` answers
once. A connection disconnect closes its requests.

Storage's `ownerConfig()` returns the validated config supplied to this open,
copied at bind time, or `undefined` for a legacy allow-only open. It is not
`readSavedConfig()` or `importedConfig()`; `saveConfig()` does not retarget it,
and later mutation of the caller's object cannot change it. Legacy absence is
not the internal placeholder with an empty system and script `"legacy"`.

Session assembly takes its gate policy from that owner snapshot. Omitting the
session config uses the snapshot; legacy allow applies only if `ownerConfig()`
succeeds with an absent value. A supplied config is accepted only if it deeply
matches the snapshot, ignoring object key order. If the snapshot exists,
`systemPrompt` must equal its `system`; when absent, `systemPrompt` is the
legacy model prompt and is not compared. A failed `ownerConfig()` fails assembly
before the session starts: failure is not absence and the caller's config is not
a substitute. When assembly creates storage it passes that same selected config
into open, omitting it only for a legacy allow-only session. This prevents input
resolution under one set of policies and dispatch under a looser set. No config
comes from model text or mutable caller-owned objects after assembly.
