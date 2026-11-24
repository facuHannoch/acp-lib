# Reminders and routines

Status: proposed, 2026-11-23; reviews 1 and 2 applied 2026-11-24. Spans both parts: the harness half needs
agreeing on the harness side (its own spec and decision under `../../../src/native-harness/.res/`), the acp-client half lands in the integration
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
  id, the channel, its schedule, the text, who created it (the agent in a turn, or the host) and the policy names
  that apply (the creating turn's, or the host's; the same provenance as external notices).
- **The agent's tools act only on the calling turn's channel:** the harness fills in the channel; the model's
  arguments can't name another one, so a guest's turn can't schedule into the owner's channel. Reminders on other
  channels come later, with channel messaging and its policy.
- **The channel's lifecycle applies:** retiring a channel cancels its reminders; a reminder due while its channel or
  the session is suspended waits and fires at resume.
- **When due**, it becomes an inbox notice on its channel with a stable id (the reminder id plus its due time), so a
  repeated firing can't queue two turns. It steers a running turn or wakes an idle channel, as notices do.
- **While running**, the harness's own timer fires it. **At open**, reminders already past due become eligible after
  the open's pending channel changes are applied, the existing ordering.
- The session keeps a derived index: **the next due time** across its channels, **leaving out reminders blocked by a
  suspension** of their channel or the session. Otherwise a wake would find nothing runnable, idle stop would stop
  the harness, and acp-client would wake it again at once. A resume (a consumer action, which starts the harness
  anyway) runs the held reminders, coalescing routines (Routines, missed runs), and recomputes the next due time.

**acp-client owns waking a stopped harness and the consumer's controls:**

- **The wake index:** one value per `Agent`, when its harness next needs to be awake, in acp-client's database (it
  survives an acp-client restart), and a timer for it. It is **the earliest of** the harness's last reported next due
  time and the due times of pending create and schedule-edit intents (pending cancels and pauses don't move it; the
  most they cause is one wake for nothing). When the open confirms the intents, the harness's reported value
  replaces it. When it fires, acp-client starts the harness with the existing lazy start; opening the session is
  enough to queue the due turns. No separate wake request. If the harness is already running, the start does nothing
  and the harness's own timer fires the reminder.
- **Pending writes while the harness is stopped**, as durable intents (below).
- **A read cache** of the reminders confirmed at the last open, so a list works with the harness stopped. Never the
  source of truth.

## The contract between them

- **The harness reports its next due time** in every open's response and in an event whenever reminders change;
  acp-client stores it in the wake index.
- **The harness reports each reminder fired or cancelled, by id.** A wake retried, or the harness's own timer racing
  acp-client's wake, still fires a reminder once.
- **Idle stop** (not built yet; part of step 2): `idleStopMs`, off by default; the host stops the harness only when
  it reports idle (no turn running, nothing in an inbox, no pending approval; future reminders aren't work), and not
  if the next due time is within a short window (about twice the measured startup time), so a frequent routine
  doesn't restart the container every run. acp-client wakes it at the next due time. Without idle stop the harness
  runs until `agent.close()`, and waking only matters after an acp-client restart.
- **Requests:** create, get, list, update, pause, resume and cancel reminders, per channel or session-wide. The agent's tools and acp-client's
  calls are the same operations.

## Writes from the consumer

**The model on the conversation** (names provisional), like `configOptions` and `conversationCapabilities` today:

```ts
interface Reminder {
  id: string;
  conversationId: string;
  schedule: { at: string } | { every: string; startAt?: string } | { cron: string; timezone: string };
  text: string;
  state: "active" | "paused" | "pending" | "blocked" | "done" | "cancelled";
  nextRunAt: string | null;
  lastRunAt?: string;
  missed?: number;
  missedRuns?: "coalesce" | "skip" | "each";   // routines; default coalesce
  overlap?: "skip" | "queue";                  // routines; default skip
  until?: string;                              // routines: an optional end
  count?: number;
  createdBy: "agent" | "consumer";
  policyNames: string[];
  blockedReason?: "invalid_policy" | "channel_retired" | "invalid_schedule";
}
```

- `conversation.reminders.create({ id?, schedule, text, policyNames? })` returns `{ id, state: "active" | "pending" }`;
  also `list`, `get`, `pause`, `resume`, `update`, `cancel`; `agent.reminders.list()` across conversations.
- **"In x time" and "at x time" are one thing:** `{ in: "30m" }` is accepted for convenience and converted to
  `{ at }` at creation (by the harness for the agent's reminders, by acp-client for a consumer's made while the
  harness is stopped); only `{ at }` is stored, so a retried or delayed intent doesn't move the due time. Clock
  differences between containers don't matter at minute scale.
- **Events:** `reminder_created`, `reminder_fired`, `reminder_changed`, `reminder_confirmed`, `reminder_blocked`.
- **Capability:** `conversationCapabilities.reminders: boolean`; true for native conversations, false for ACP ones
  (acp-client could later run them for ACP conversations itself, sending the prompt when due, with no API change).
- **Policy of a consumer's reminder:** as for external notices: the destination channel's policy, plus optional
  `policyNames` the consumer passes, recorded at creation; an unknown name is `invalid_policy`. A later change to a
  policy's definition applies when the reminder fires (snapshots deferred, as for notices).

- **Harness running:** a request; done when the harness confirms.
- **Harness stopped:** recorded as a **durable intent** in acp-client's database, the pattern of durable channel
  intents (`library/11-11-SPEC-native-harness-integration.md`, Durable channel intents; brief R1), with three more
  intent kinds: **create** (`{ id, channel, schedule, text, policyNames, routine options }`), **update** (an edit, a
  pause or a resume) and **cancel**. The reminder's id
  is chosen up front. acp-client puts its due time straight into the wake index, sends the intents in the next open
  batch, and clears each only when the harness confirms it by id. No container starts just to set a reminder, and a
  crash or a retry can't create a duplicate.
- **Validated locally first:** the schedule's syntax, the limits (below) and, when acp-client has the config, a
  known policy name, so most errors fail at `create`. Only state-dependent refusals (a channel retired meanwhile)
  wait for the open: the harness answers each intent `applied` or `blocked` with a reason, acp-client emits
  `reminder_confirmed` or `reminder_blocked`, and a blocked reminder stays in `list` as `blocked` until the consumer
  fixes or deletes it (the pattern of blocked channel changes).
- **Lists with the harness stopped** show the cached confirmed reminders plus pending intents, marked pending.
- A cancel racing a firing: the harness decides and reports which happened.

## Routines

A routine is a reminder whose schedule produces many due times (added 2026-11-23). Ownership, storage, the notice
path, the wake contract and the intents don't change; it adds:

- **A schedule with more than one time:** besides `{ at }` (one-off), `{ every, startAt? }` (an interval), or
  `{ cron, timezone }` (calendar rules). Local times are computed in the routine's timezone, so "9:00 every day"
  stays 9:00 across daylight-saving changes.
- **An id per occurrence:** the routine's id plus the scheduled time. It deduplicates a retried wake, or the
  harness's timer racing acp-client's wake, per occurrence.
- **The next occurrence** is computed by the harness after each firing; the session's next due time, and so the
  wake index, is the earliest occurrence across all reminders and routines.
- **Missed runs** (acp-client closed or the harness stopped through several occurrences): **coalesce** by default:
  run once at the next open, telling the agent how many were missed and when the last was scheduled. Also `skip`
  (wait for the next) and `each` (rarely right: a burst of turns).
- **Overlap:** an occurrence due while the previous one is still waiting or running is **skipped** by default
  (recorded as skipped); `queue` is the alternative. A routine never piles up behind itself.
- **End and control:** optional `until` or `count`; pause and resume without deleting; edit the schedule or the
  text. While the harness is stopped, an edit, a pause or a resume is a durable intent ("update routine"), like
  create and cancel.
- **Where it runs:** each run is a turn on its channel, so runs add to that channel's context (a daily summary can
  say "since yesterday…"). For a noisy routine the consumer gives it a dedicated channel (its own conversation),
  keeping the user's chat clean. Documented, no mechanism.
- **Limits, in both places** (adjustable defaults, in the business rules):
  - **the harness:** a minimum interval of 5 minutes and at most 20 active routines per channel. It is the only
    limit on routines the agent creates itself (acp-client never sees those tool calls in advance: a confused
    model or a prompt injection could otherwise schedule unattended, paid turns), and it protects a standalone
    harness;
  - **What they apply to:** the minimum intervals apply to repeating schedules only (for `cron`, between consecutive
    runs); a one-off `{ at }` can be any future time;
  - **acp-client:** a stricter minimum of 15 minutes for routines its consumers create, checked locally so a request
    fails at once even with the harness stopped. acp-client's limits can be stricter than the harness's, never
    looser: the harness checks its own again. Creating beyond a limit fails with a typed error.
- **Unattended runs:** the harness's unattended-turn guard (harness v1, not built yet) caps turns with no human
  input; the routine's policy is recorded at creation; costs are metered as usual and limits stay the consumer's
  (the spending cap is a TODO).

## First version

1. **Harness reminders while running:** one-off reminders owned by channels, the agent's tools (create, cancel,
   list), the requests, firing as notices, past-due reminders at open. Useful with no waking at all.
2. **acp-client wakes and controls:** the wake index and timer, the next-due event, the intent kinds on R1's
   repository, the `Reminder` model with `conversation.reminders` and `agent.reminders`, local validation and blocked
   results, the capability flag, and idle stop (not built yet) with the "next due soon" window.
3. **Routines** (Routines, above): schedules, occurrence ids, next-occurrence computation, missed-run and overlap
   rules, pause, resume and edit, also as intents.
4. **Later:** waking a little early to hide the cold start, with the harness holding the turn until it's due.

Depends on: the harness's external notices (firing reuses the inbox notice path) and integration brief R1 (the
intents repository).

## Limitations

- **Same channel only:** the agent can't set a reminder for another channel ("remind Bob tomorrow") in v1.
- **A fast routine needs a changed default** (the 5 and 15 minute minimums).
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

- [ ] Defaults to confirm: coalesce for missed runs, skip for overlap; the limits (5 and 15 minutes, 20 per channel).

Decided in review 1: one object with a schedule for reminders and routines; a consumer's reminder runs under the
channel's policy plus optional added names.
