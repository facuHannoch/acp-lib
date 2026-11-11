# Memory for one agent across many conversations: findings

Status: findings, not a specification. Written 2026-11-11. Phase 1 memory (the timeline v1 and shared state) is
specified in `11-11-SPEC-harness-v1.md`; this note records what we learned and decided to defer, so phase 2 starts
from it. General background is the Memory section of `theory/11-11-NOTE-harness-theory.md`.

## The problem is not storage

The model remembers nothing between calls; every memory is something the harness writes down and puts back into a
context. For one agent talking to many parties at once, the hard questions are:

- **who knows what:** each conversation's context has seen a different part of what happened;
- **provenance and scope:** "the owner said" and "a guest said" are different kinds of fact, and a guest must not
  read what its policy hides;
- **cost:** whatever is delivered competes with the task for the same context budget, and re-sent on every call.

## What we tried and dropped

- **Copying transcripts between conversations** (acp-client's checkpoint-backed identity): raw messages from other
  conversations pasted into a preamble under character caps. Unreliable: no single truth, noise, and cursors per pair
  of conversations as a workaround.
- **A participant registry with per-item ledgers** ("who was told what" per participant and item): too rigid; who
  someone is to the agent is better learned from what happened.
- **A "current state" block near the top of the context, rewritten each call:** breaks the cache on every call.
  Deltas appended once, at the end, become cached prefix; compaction folds them into a snapshot.
- **The library owning the memory store:** it made the harness the same library split in two. The harness owns it;
  hosts plug in sources.

## What we chose: a timeline

One append-only history for the entity, a position per conversation, delivery as a digest of the slice since a
position, shared state and memory as projections (details in the harness design spec). Why it fits:

- one truth that every conversation is positioned on, instead of pairwise cursors;
- "what happened since I last talked to John" is a slice, for single details and long spans alike;
- provenance and scope travel on every event, so filtering by policy is mechanical (policy goes to code);
- "what John was told" is a separate fact from "what John's conversation has seen", recorded as told events.

The cost: a slice over a long span is large, so it must be digested, and digests are where quality lives.

## Kinds of memory against the timeline

| Kind | Holds | In this design |
| --- | --- | --- |
| Working | the current context | each session's context; compaction |
| Episodic | what happened | the timeline itself, with digests per span |
| Semantic | facts learned | shared state (current facts, commitments) now; consolidated memory later |
| Procedural | how to do things | the system prompt; skills later |
| Identity | who the agent is and who it talks to | config and system prompt; "who it knows" learned from the timeline |

## Write and read paths

- **Write:** native sessions append automatically; the agent records facts with `state_write` (judgment, in
  inference); hosts report messages and summaries; background extraction ("dreaming") later.
- **Read:** a digest of the slice since the position, rendered each turn (always delivered, budgeted); `state_read`,
  `timeline_since` and `timeline_search` on demand. Automatic similarity retrieval (RAG) is not planned: it fetches by
  similarity, not relevance, and adds noise.

A common and good combination, which we follow: a small always-delivered part plus on-demand tools for detail.

## Digests: the open design

In v1, digests are stitched from host summaries plus truncated recent events. Phase 2 needs digests at several
granularities (events, episodes, days) so that old spans cost little:

- **What a digest is:** a summary of a span, with the scope of its least visible event, so a policy can still filter.
- **When:** on idle, after each episode, or on request; cost is one cheap model call each.
- **Who reads them:** delivery (coarse for old spans, raw for recent) and consolidation into long-term memory.
- **Risk:** a digest written under one policy and read under another; digests must be produced per scope or carry the
  most restrictive scope of what they cover.

## Maintenance and risks (for phase 2)

- **Consolidation and updating:** merge duplicates, let a new fact replace an old one, fade old episodes.
- **Conflicts:** two facts disagree; one wins, or the agent asks.
- **Poisoning:** a guest plants false facts; read-only policies write nothing, and scope keeps guest facts as guest
  facts.
- **Leaks across conversations:** filtering by the receiving turn's policy, always in code.
- **Staleness:** a remembered fact that names a file or a function should be checked before it is relied on.

## Letta (formerly MemGPT), checked 2026-11-11

- The original MemGPT loop made every action a tool call, including visible replies through `send_message`, with a
  `request_heartbeat` flag to keep going. In October 2025 `letta_v1_agent` deprecated heartbeats and `send_message` in
  favour of native reasoning and direct assistant messages, to stay in-distribution with how current models are
  trained ([Letta blog](https://www.letta.com/blog/letta-v1-agent/)). We took the same position: plain text answers
  the current conversation.
- Cross-agent consistency came from memory blocks attached to several agents; the docs now say they no longer
  recommend building on memory blocks and point to shared memory as Git repositories agents commit to and pull
  ([v1 shared memory](https://docs.letta.com/v1-sdk/memory/shared-memory),
  [shared memory](https://docs.letta.com/concepts/shared-memory)).
- Background consolidation is called dreaming: subagents review recent conversations and update memory after a number
  of steps or on compaction ([memory and dreaming](https://docs.letta.com/configuration/memory)).
- No current Letta guide on serving many users with one agent was found.
- **Our difference:** one entity with many deep conversation contexts and live shared state, rather than small,
  centrally managed contexts. Whether this sacrifices depth per conversation is the question their design answers
  differently; ours keeps each conversation's full context and shares through the timeline.

## Is this publishable?

Possibly, once there is evidence. The contribution would be the timeline model for one agent across many concurrent
conversations with policies per message (positions, digested slices, scope filtering, told events), measured on the
basic-promise checks and the injection suite across models. It needs the eval numbers first; a write-up before them
would be a position paper.

## Deferred, with the reason

| Item | Why later |
| --- | --- |
| Long-term memory and consolidation | needs the timeline running to know what is worth keeping |
| Digests at several granularities | stitched host summaries are enough to judge the basic promise |
| Background watch evaluator | structural and agent-noticed cover phase 1; one extra call per batch otherwise |
| Member-session tools (MCP server) | ACP members are crude anyway; native sessions prove the model first |
| Memory files (markdown, one fact per file) | a storage choice for consolidated memory; decide with it |
