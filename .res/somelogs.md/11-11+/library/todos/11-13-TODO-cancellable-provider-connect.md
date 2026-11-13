# TODO: cancellable provider connect (a harness that never answers)

Status: accepted as today's behaviour for now (decided 2026-11-13, during A2 of the controller-interface spec); to be
fixed as its own small change. It changes ACP behaviour, so it needs the owner's go-ahead.

## The problem

When an ACP harness never answers while acp-client is connecting or reconnecting to it (for example Codex hanging
after a crash), that conversation gets stuck: its next prompts wait, settings changes wait, and `stop()` waits,
forever. Other conversations aren't affected.

It exists in today's code: `pump` waits for `ensureProvider` before moving on, and a connection attempt has no way to
be cancelled. A2 doesn't cause it or make it worse: with A2, the prompt that triggered the reconnect fails as soon as
`send` fails, instead of hanging too; the queue still waits for the reconnect, which keeps the rule that two
reconnects never overlap. Seen on A1 as well.

## Options

1. **Make connecting cancellable (recommended).** `stop()` can cleanly kill a connection attempt in progress, and a
   cancelled attempt can never come back to life later. The proper fix; medium-sized.
2. **A time limit on connecting.** The attempt fails after N seconds. Still needs option 1's cleanup underneath, and
   it is a policy choice: a slow but working harness could be cut off. Recommended only as an option, off by default
   for ACP (native already has its 60 s start timeout, which would use the same machinery).
3. **Leave it as today** (the current decision, until 1 is done).

## What option 1 must define

- **Ownership:** the controller owns the client from the moment it is created, not only after bring-up succeeds.
- **All connection paths:** `start`, `startFresh`, reconnect, mode switches and handoff targets, not only reconnect.
- **Late success:** a cancelled or superseded attempt never installs a client and never emits `provider_reconnected`.
- **One attempt at a time:** a new attempt starts only after the previous one is cancelled or fenced off.
- **`stop()` always cancels an attempt in progress;** repeated `stop` calls are harmless.
- **Bounded teardown:** the harness process is asked to exit, then killed after a deadline, so a harness that ignores
  termination can't stall it.
- **Errors:** callers get a distinct error (for example `ConnectionCancelledError`), not a provider error; queued
  operations settle exactly once; late rejections are observed, never left unhandled.
- **Tests,** with the offline fixtures: a connect that is never answered, late success after cancel, repeated stop, a
  failed reconnect, queued prompts behind it, a harness that ignores termination.

## Where it fits

After the controller-interface spec, before integration stage 2a (native's start timeout uses the same machinery).
