# TODO: watches ("notify me when something important happens")

Related: `../11-11-SPEC-harness-design.md` (the timeline), `../11-11-NOTE-memory-findings.md`,
`../../11-11-NOTE-overview.md`. Taken out of the phase 1 scope on 2026-11-11: the idea came up in the design
discussion but was never defined enough to specify, and phase 1 is large already. It belongs to the harness (it is
about the entity's timeline), not to the library.

## The idea

Someone tells the agent, in one conversation, "notify me when something important happens" (or "tell me when the
deploy finishes", "let me know if Bob mentions the contract"). That is a standing request: it outlives the turn and
has to fire later, from events that happen in other conversations or in workers.

The design notes sketched it as a watch stored on the timeline: `{ owner conversation, condition, created at, expiry }`.
A match becomes an inbox item in the owner's conversation (a wake), carrying the matching events.

## Matchers sketched, cheapest first

| Matcher | How | Good for | Cost |
| --- | --- | --- | --- |
| Structural | code matches event kinds or tags on append | "when the worker finishes", "when Bob writes" | none |
| Agent-noticed | active watches are rendered into conversations as standing requests; the agent uses `trigger_response` or `message_participant` when it sees something relevant | conditions that need understanding, while a conversation is already running | context space in every turn |
| Background evaluator | after each batch of timeline events, one cheap model call checks active watches | vague conditions ("something important") with no conversation running | one call per batch |

A watcher only matches events its policy can see.

## What was never defined

- **How a watch is created.** An agent tool (the agent judges that a request is a watch), a host API (the consumer
  creates watches in code), or both. A `watch_create(condition, expiry?)` tool was written into the v1 spec without
  being agreed, and removed.
- **What a condition is.** Free text, structured (event kind, sender, tag), or both; who turns free text into
  something structural.
- **Lifetime and cleanup.** Expiry defaults, one-shot or repeating, how the owner lists and cancels watches.
- **Noise.** How often a vague watch may fire; batching matches; whether a match always wakes or can be quiet.
- **Agent-noticed cost.** Rendering every active watch into every conversation costs context and may leak the
  existence of a watch to conversations whose policy shouldn't see it.
- **Interaction with the way back.** Worker replies already wake the delegating conversation; a watch on "when it's
  done" overlaps with that.

## Until then

"Tell me when it's done" is covered by the commitment staying in the conversation's context and the worker's reply
waking it (harness design spec, The two loops). Later, self-scheduled reminders cover the "nothing happened" case.
The inbox item kind for a match can be added with its renderer when watches are specified.
