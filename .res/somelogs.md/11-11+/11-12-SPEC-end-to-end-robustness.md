# End-to-end robustness: a stress test across the library and the harness

Status: agreed, not started. Written 2026-11-12, moved out of the integration spec. Cross-cutting: it exercises the
library and the harness together, so it runs **after everything that is actually building is done** (the four
library specs and both harness parts; `11-11-NOTE-overview.md`, Order of work). No implementation plan yet.

## Why

Errors around persistence and message delivery exist in acp-client today, and the native harness adds more ways for
them to happen (a shared process, lazy start, holds, held turns, two logs). The specs define a decent first model;
this test is how it becomes robust. It is used to **refine the model**, not only to check it: a failure that shows a
gap in the model changes the spec it belongs to.

## What it runs against

A real `harness serve` with the scripted model (no provider key), started through the launcher, hosted by an `Agent`
with several native conversations and, once the orchestrator exists, fake and real throwaway workers. ACP
conversations through the fixture agents run alongside, since the two kinds share the queue, steering, permissions and
persistence.

## Scenarios

- many messages back and forth on several native conversations of one `Agent` at once, queued and steered;
- interrupts mid-turn and mid-tool; withdraws racing the harness taking a message;
- the harness process killed at random points (mid-turn, mid-permission, during start), and restarted, including
  running out of restarts;
- the connection lost and restored; a slow or failing persistence backend; disk-full style write failures;
- holds and their lease expiry, including a holder that disappears; a start that hangs;
- idle stop racing new messages; config, policy and setting changes while the harness is stopped; deletes and resets
  while stopped;
- permission requests answered, timed out, and arriving in held turns;
- workers replying, failing and being interrupted while their conversation is busy (with the orchestrator).

## Invariants, checked after every run

- every prompt settles exactly once;
- no conversation stays busy with nothing running, and no channel stays held;
- no wait exceeds its bound (integration spec, Nothing waits forever);
- records and the harness's context agree, except where a surfaced error says why;
- usage is filed once per model call, under the right turn or at the entity level;
- a policy or setting changed while stopped is in force before the first turn after start.

## How findings are handled

Each failure found becomes a scripted scenario that reproduces it first, then a fix; where it shows a gap in the
model, the owning spec (integration, controller interface, orchestrator, harness v1) is changed before the fix.

## Open

- [ ] Randomized (seeded, replayable) runs or a fixed scenario list, or both.
- [ ] How long a run is and whether it runs in CI or on demand.
- [ ] Whether a live-model variant runs once a provider key exists.
