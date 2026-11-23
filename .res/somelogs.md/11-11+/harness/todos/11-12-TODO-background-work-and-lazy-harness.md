# TODO: background work, waking a stopped harness, and a lazily loading harness

Status: deferred to phase 2. Written 2026-11-12, from the review of the integration spec. Nothing here changes the
v1 design; it builds on it.

## Where v1 leaves it

- acp-client starts the harness process **lazily, on activity** (a message, a pushed item, an operation that needs
  the harness such as export), like an ACP provider is started today, and may **stop it when idle**. Before start,
  config, models, commands and capabilities are known from the stored config and the harness package's
  `describe(config)` (integration spec, Process lifecycle).
- The harness can already start turns on its own (overview, decision 41), and acp-client records turns it didn't
  ask for, loading the conversation on demand. Channels always exist.
- v1 has **no background work**: a stopped harness never needs to wake itself.

## 1. Background work and waking

> **2026-11-23:** reminders and waking a stopped harness are now specified in
> `../../11-23-SPEC-reminders-and-routines.md`. Watches stay here.

Watches, reminders and other work the agent does without being asked (`11-11-TODO-watches.md`) need the harness
running, or a way to wake it.

- **Stay up:** an agent with background work configured isn't idle-stopped. Simple; costs a running container per
  such agent.
- **Wake by the host:** the harness tells acp-client when it next needs to run (a time, or an external event
  source), and acp-client starts it then. Keeps containers down between wakes; acp-client needs a small scheduler
  and must itself be running.
- **External trigger:** an event source outside acp-client (a webhook, a queue) wakes the harness directly. Needs the
  harness reachable without acp-client, which v1 doesn't allow (stdio, child process).

## 2. A harness that starts cheaply: "like a server"

Existing harnesses keep each session's transcript as JSON and load it whole, which is most of their memory and
start-up cost. Ours can be built to start cheaply and load lazily:

- the process starts with nothing loaded; a channel's context is loaded when the channel is used, and dropped when
  idle;
- the event-sourced store and SQLite make partial loading natural (snapshots plus the tail of the log);
- in the limit, each request could start the process, handle it and exit, like a server handling requests, with all
  state in the harness home.

This makes lazy start fast and idle stop cheap, but the container still has to run while the process does, so it
reduces cost per wake rather than removing it.

## Questions for when this is designed

- [ ] Which wake model, and whether acp-client hosts a scheduler.
- [ ] How long a cold start may take before the first message feels slow; whether start progress is enough for
      consumers.
- [ ] What the harness keeps in memory per channel and when it unloads it.
- [ ] Whether per-request processes are worth it over a long-lived process with lazy loading.
