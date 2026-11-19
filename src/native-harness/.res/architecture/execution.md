# Execution

Status: current implementation, 2026-11-16.

## Accepting and scheduling input

`createChannelScheduler` in `src/kernel/channels.ts` assigns a session-local turn
ID and immediately appends attributed input to the shared store. A promise chain
queues execution for that channel. Other channels have independent chains, so
several turns can run concurrently.

An accepted input can already appear in shared history while its turn is queued.
Timeline order records append order; it does not serialize inference or tool
execution across channels. A later append cannot change a request already sent
to the model.

## Inner loop

`runTurn` in `src/kernel/loop.ts` repeats:

1. Drain pending explicit notices into the active turn's stored history.
2. Build context from a fresh shared-store snapshot and call the model.
3. Append the assistant response and publish any assistant text.
4. Execute requested tools sequentially within this iteration, recording results.
5. Continue after tools. With no tool calls, end only if no notices remain.

The final notice check and closing of admission are synchronous. A notice that
arrives after admission closes queues a new turn, even if the previous turn's
promise has not settled yet. There is no fixed notice-pass limit or tool-call
limit in this prototype.

Ordinary activity in other channels does not keep a turn alive. Explicit notices
do. The next inference includes fresh shared activity, but there is no automatic
revalidation of a final answer or proposed side effect against newer events.

## Notices

`agent.notify` validates the target channel, rejects unknown or failed channels,
and either places a notice in an active accepting inbox or queues a notice-driven
turn. It acknowledges acceptance without awaiting the target's answer. This
avoids two concurrent turns waiting for one another through notifications.

Notices retain source-channel attribution and are not human messages. Their
current model rendering uses the API's user role with explicit internal-notice
text. This role is a rendering choice, not participant identity or authority.

Busy-channel notices are stored only when drained; before that they exist solely
in the scheduler's array. Idle-channel notices are stored by the enqueue path.
Both paths currently lose everything on process exit.

## Output and failures

The loop emits completed assistant text independently of turn completion. A
notice can extend a turn after an answer has already been published. The scheduler
emits turn lifecycle events; interface adapters subscribe outside the kernel.

A thrown model/tool failure stops that channel for the process lifetime. Queued
turns on that channel fail explicitly; other channels continue. The prototype
does not replay failed tools or reconcile external effects. Restart currently
clears the failure along with all history.

These facts matter for persistence: turn IDs and failure state cannot simply
reset while old history remains, and an unanswered tool call must not be
automatically executed again after a crash.
