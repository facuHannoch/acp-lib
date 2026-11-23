# Reminders and routines

Status: proposed, 2026-11-23. Not reviewed. Spans both parts: the harness half needs agreeing on the harness side
(its own spec and decision under `../../../src/native-harness/.res/`), the acp-client half lands in the integration
spec's plan. Takes over section 1 of `harness/todos/11-12-TODO-background-work-and-lazy-harness.md` (reminders and
waking a stopped harness); watches (`harness/todos/11-11-TODO-watches.md`) stay there.

## What it is

A **reminder** is work the agent does later without being asked at that moment: "check in 30 minutes if the build
passed". A **routine** is a reminder that repeats ("every morning, summarize the build"). Both queue a turn on a
channel when due. The agent creates them with tools; the consumer of acp-client creates, lists and cancels them
through the library.

## Ownership

**The harness owns what a reminder is** and keeps it in its session storage, the single source of truth:

- **A reminder belongs to a channel**, like inputs and tool calls: it exists to queue a turn there. It records its
  id, the channel, the due time, the text, who created it (the agent in a turn, or the host) and the policy names
  that apply (the creating turn's, or the host's; the same provenance as external notices).
- **The channel's lifecycle applies:** retiring a channel cancels its reminders; a reminder due while its channel or
  the session is suspended waits and fires at resume.
- **When due**, it becomes an inbox notice on its channel with a stable id (the reminder id plus its due time), so a
  repeated firing can't queue two turns. It steers a running turn or wakes an idle channel, as notices do.
- **While running**, the harness's own timer fires it. **At open**, reminders already past due become eligible after
  the open's pending channel changes are applied, the existing ordering.
- The session keeps a derived index: **the next due time** across its channels.

**acp-client owns waking a stopped harness and the consumer's controls:**

- **The wake index:** one value per `Agent`, when its harness next needs to be awake, in acp-client's database (it
  survives an acp-client restart), and a timer for it. When it fires, acp-client starts the harness with the existing
  lazy start; opening the session is enough to queue the due turns. No separate wake request.
- **Pending writes while the harness is stopped**, as durable intents (below).
- **A read cache** of the reminders confirmed at the last open, so a list works with the harness stopped. Never the
  source of truth.

## The contract between them

- **The harness reports its next due time** in every open's response and in an event whenever reminders change;
  acp-client stores it in the wake index.
- **The harness reports each reminder fired or cancelled, by id.** A wake retried, or the harness's own timer racing
  acp-client's wake, still fires a reminder once.
- **Idle stop takes reminders into account:** the harness may stop when idle; acp-client wakes it at the next due
  time, so containers stay stopped between reminders.
- **Requests:** create, cancel and list reminders, per channel or session-wide. The agent's tools and acp-client's
  calls are the same operations.

## Writes from the consumer

`conversation.reminders.create({ id?, dueAt, text })`, `conversation.reminders.cancel(id)`,
`conversation.reminders.list()`, and `agent.reminders.list()` across conversations (names provisional).

- **Harness running:** a request; done when the harness confirms.
- **Harness stopped:** recorded as a **durable intent** in acp-client's database, the pattern of durable channel
  intents (`library/11-11-SPEC-native-harness-integration.md`, Durable channel intents; brief R1), with two more
  intent kinds: "create reminder" (`{ id, channel, dueAt, text, policy }`) and "cancel reminder". The reminder's id
  is chosen up front. acp-client puts its due time straight into the wake index, sends the intents in the next open
  batch, and clears each only when the harness confirms it by id. No container starts just to set a reminder, and a
  crash or a retry can't create a duplicate.
- **Lists with the harness stopped** show the cached confirmed reminders plus pending intents, marked pending.
- A cancel racing a firing: the harness decides and reports which happened.

## First version

1. **Harness reminders while running:** one-off reminders owned by channels, the agent's tools (create, cancel,
   list), the requests, firing as notices, past-due reminders at open. Useful with no waking at all.
2. **acp-client wakes and controls:** the wake index and timer, the next-due event, the two intent kinds on R1's
   repository, `conversation.reminders` and `agent.reminders`, idle stop with reminders.
3. **Later:** repeating routines (an interval, daily, cron-style); waking a little early to hide the cold start, with
   the harness holding the turn until it's due.

Depends on: the harness's external notices (firing reuses the inbox notice path) and integration brief R1 (the
intents repository).

## Limitations

- **It only wakes while acp-client is running.** In a REPL or desktop app, closing the app means nothing fires until
  it's opened again; then overdue reminders run at open, late but not lost. Firing with nothing open needs acp-client
  running as a service, or an independent scheduler that starts it (later; keep the wake contract small enough for a
  standalone launcher).
- **A narrow crash window:** if the harness crashes after saving a reminder but before acp-client stored the new due
  time, that reminder runs at the next open instead of on time. Accepted rather than a handshake before every
  reminder is confirmed.
- **Cold start delay:** a woken container starts the turn once it is ready, not exactly at the due time (until the
  "wake early" item).

## Open

- [ ] Names: reminders vs. routines in the public API; whether one-off reminders and routines share one object.
- [ ] Whether a reminder created by the consumer runs under the channel's policy or a policy the consumer names.
