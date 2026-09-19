We’ve built most of the foundation, but not yet the full multi-agent system. The important change is that the remaining work is much better defined.

| Area | Where we stand |
|---|---|
| Agent and conversations | Implemented: one stable agent ID, multiple independently persisted conversations, stable participant IDs. |
| Persistence and recovery | Implemented: SQLite records, search, metering, audit rotation, and checkpoint-based recovery. The full transcript remains available for display. |
| Concurrency | The model is settled: one owning process per agent database can run many conversations concurrently. We have database concurrency tests, but not yet a realistic 20-plus-harness load test. |
| Identity | The [identity interface](/home/ffacu/q/apps/libs/acp-lib/src/identity.ts) is wired into prompts and record updates. The *actual shared memory behavior*—what to learn, merge, retrieve, and forget—is not implemented. Checkpoints recover individual conversations; they are not that shared identity. |
| Agent-to-agent communication | Still to build: discoverability, addressing, a send tool/API, and routing a message into the recipient’s conversation. |

So I’d call the storage/runtime layer largely complete, with two major product layers remaining: **identity v1** and **agent-to-agent communication**. Concurrency no longer needs an architectural invention for the single-owner case; it needs realistic validation. Identity has an integration point and a clearer consistency model, but its memory policy is still the biggest design-and-implementation task.




---


Yes—those are the two remaining functional pieces. There’s also an end-to-end integration pass after them, but I wouldn’t treat that as a third architectural subsystem.

**Identity v1** can be deliberately simple: maintain an agent-wide summary from all its conversations, then load that summary plus a recent cross-conversation tail before each prompt. The [identity hook](/home/ffacu/q/apps/libs/acp-lib/src/identity.ts) and persistence tables exist, and internal inference can generate summaries. What’s missing is the policy and worker that actually maintain them. I’d make the tail *token-bounded*, with “up to 400 messages” as a ceiling, since 400 full messages could overwhelm the provider context. We also need to decide when a new message becomes visible to another concurrent conversation. This would be a working shared identity, even if its memory selection is crude.

**Agent tools** split exactly as you describe. ACP conversations already accept [MCP server configuration](/home/ffacu/q/apps/libs/acp-lib/src/agent.ts), so MCP is a practical first way to expose tools to the model. But the library does not yet provide the server or the behavior behind `discover_agents`/`send_message`. Some building blocks exist—agent and conversation IDs, conversation lookup/creation, and [`promptFrom()`](/home/ffacu/q/apps/libs/acp-lib/src/agent-session.ts)—but we still need addressing, recipient routing, response delivery, and safeguards against accidental message loops. The consumer could initially supply the discoverable-agent list, avoiding a global registry.

So the shortest path to the thing we imagined is: **simple shared identity → MCP-backed discovery and messaging → multi-agent end-to-end test**. Native harness tools, sophisticated RAG, and a cross-process agent hub can remain later refinements.




Here’s the current architecture, before adding shared identity behavior or agent-to-agent tools:

```text
Consumer / orchestration app
  ├─ Agent “atlas” (ags-…) ─────────────── one agent SQLite database
  │    ├─ adapter registry                 Codex, OpenCode, etc.
  │    ├─ identity runtime                 hook exists; default remembers nothing
  │    ├─ conversation manager
  │    │    ├─ Conversation A (agc-…) → Controller → ACP harness process/thread
  │    │    └─ Conversation B (agc-…) → Controller → ACP harness process/thread
  │    ├─ internal inference               disposable harness calls for background work
  │    ├─ checkpoint/recovery              per-conversation continuation summaries
  │    └─ audit writer                     separate, rotating JSONL destination
  └─ Agent “bob” (ags-…) ───────────────── separate SQLite database
```

The central distinction is that an **Agent owns identity and durable state**, while each **AgentConversation owns one live interaction**. A conversation’s `agc-*` ID stays stable even if its provider’s internal session is replaced during recovery or handoff. `AgentConversation` and the older `AgentSession` name currently refer to the same runtime class; its controller handles ACP communication, configuration, and prompts. See [agent.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent.ts) and [agent-conversation.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent-conversation.ts).

On a prompt, the conversation asks the agent’s identity runtime for context, records the participant’s message, sends the prompt through its controller, then records the assistant’s messages and other captured observations. SQLite holds the full, typed conversation timeline, participants, metering, search indexes, and recovery state. Checkpoints summarize **one conversation for recovery**; they do not currently form an agent-wide memory. The identity hook is wired in, but its default implementation does nothing. See [identity.ts](/home/ffacu/q/apps/libs/acp-lib/src/identity.ts).

One process owns an agent database at a time, but that owner can run multiple conversations—and therefore multiple harness processes—concurrently. The older `SessionManager`/JSONL API remains as a compatibility path; it is not the manager above `Agent`. Agent-to-agent discovery, message routing, and a library-provided MCP tool server do **not** yet exist.



# Identity


We have an identity **framework**, but not yet a memory-bearing identity.

Today, each `Agent` has a stable `ags-*` ID and one SQLite database containing all its conversations. On every prompt, the conversation calls `identity.load()`, then stores the incoming message and calls `identity.update()`. After the response, it stores each assistant message and calls `update()` again. If `load()` returns a `promptPreamble`, that text is added privately to the provider prompt—not to the visible transcript. That flow is in [agent.ts](/home/ffacu/q/apps/libs/acp-lib/src/agent.ts:863).

The pieces available to an implementation are:

- An [identity runtime contract](/home/ffacu/q/apps/libs/acp-lib/src/identity.ts): `load`, `update`, and optional `synchronize`.
- SQLite storage for agent-wide memory observations, versioned identity snapshots, and progress watermarks, exposed through [persistence interfaces](/home/ffacu/q/apps/libs/acp-lib/src/persistence/backend.ts:520).
- Internal inference, which can run background AI work. It supports an `identity_update` purpose, but we have not supplied a built-in identity strategy.

The crucial limitation: the default runtime is [`NoopAgentIdentityRuntime`](/home/ffacu/q/apps/libs/acp-lib/src/identity.ts:48). It injects nothing and saves no memories. The `eventual`/`through-current` setting is passed to a custom runtime, but the library does not itself enforce a shared-memory synchronization policy. And the existing recovery summaries are **per conversation**, not an agent-wide identity summary.

So we have the entry points, storage substrate, and AI-work mechanism. What we need to design now is the actual pipeline: which conversation records enter shared memory, how the rolling summary is produced, and how summary plus recent unsummarized messages are selected for `load()`.


---

Ok, so let's build a basic identity.
So, what we want is the agent to know:
1. Who it is
2. What it has done
3. What it was told
4. What it has to do

So, the most basic identity would be a summary of all the conversations + the last 300 conversations ? 
But, we can't take all the texts and make a summary, because this wouldnt scale. 



Yes. For a conversation, the next checkpoint is generated from:

```text
previous summary covering through sequence k
+ canonical message records with sequence (k, n]
→ LLM
→ new summary covering through sequence n
```

The first checkpoint has no previous summary, so it starts with the messages from the beginning. It runs through a disposable internal-inference session in the background; `prompt()` does not wait for the summary generation. By default, checkpoints are requested after successful responses 1, 5, 10, 15, 30, 50, then every 50 responses. The strategy currently reads **message records only**, not tool calls or activities. See [checkpointing strategy](/home/ffacu/q/apps/libs/acp-lib/src/checkpointing/strategy.ts:34) and [schedule](/home/ffacu/q/apps/libs/acp-lib/src/checkpointing/config.ts:31).

One distinction for the identity design: these summaries follow each *individual conversation’s* sequence. They could be inputs to an agent-wide identity, but they do not currently combine knowledge across conversations.



Yes. Each conversation’s latest checkpoint stores both the summary and a `coveredSequence`. We can retrieve that conversation’s messages with `sequence > coveredSequence`; if it has no checkpoint yet, use `0`. So we know exactly **which messages are not represented by the latest summary** and can derive their count. The sequence difference itself is *not* a message count, because other record types share the sequence. See [checkpoint contract](/home/ffacu/q/apps/libs/acp-lib/src/checkpointing/contracts.ts:6) and [message query](/home/ffacu/q/apps/libs/acp-lib/src/persistence/sqlite-backend.ts:643).

That gives us a very plausible identity v1:

```text
For each relevant conversation:
  latest summary, if any
  + messages after its coveredSequence

Combine those into the private context loaded before a prompt.
```

We do **not** need an agent-wide summary initially. The tradeoff is size: as conversations accumulate, concatenating every summary and every uncovered tail on every prompt becomes expensive. We can start with a total token budget and a clear rule for what gets included; importantly, a “last 400 messages” cap must not silently imply that it includes *all* messages since the checkpoint when it doesn’t. I’d also avoid re-injecting the current conversation’s history when its live provider thread already has it.




The summaries are generated by the **checkpointing system**, not by the identity runtime. After scheduled successful responses, the agent enqueues a background internal inference. That inference starts a disposable harness session, gives it the previous summary plus new messages, and stores the result as a checkpoint for that conversation in SQLite. The default instruction is aimed at *continuing that conversation*, and an agent can already customize it with `checkpointing.summaryInstruction`.

For identity v1, I’d keep those responsibilities separate:

```text
Checkpointing → generates and stores one rolling summary per conversation
Identity runtime → reads summaries + uncovered message tails
                 → selects/formats private context for the next prompt
```

That suggests one built-in identity implementation—something like `ConversationSummaryIdentityRuntime`—alongside the existing custom `AgentIdentityRuntime` interface. It would **reuse** checkpoints, not generate another set of summaries or need a new identity table. It would require checkpointing to be enabled; before a conversation’s first checkpoint, its messages are simply the uncovered tail.

Your customization point matters. Today `summaryInstruction` is configured per **agent**, so Atlas and Bob could use different instructions, but conversations within Atlas would share one. For v1, I’d allow that plus a customizable identity *selection/formatting* policy. If we later need summaries specifically optimized for identity—or different instructions per conversation—we should give those a separate strategy and stored artifact. Changing a recovery summary solely to improve identity could make recovery worse.



The default summary instruction is in [checkpointing/config.ts](/home/ffacu/q/apps/libs/acp-lib/src/checkpointing/config.ts:54):

> Create a precise continuation summary for another instance of this agent. Preserve objectives, decisions, important facts, unresolved questions, pending actions, relevant resources, and the latest conversational state. Do not invent information. Return only the continuation summary.

A consumer can replace it with `checkpointing.summaryInstruction` when opening the `Agent`. [ConversationCheckpointStrategy](/home/ffacu/q/apps/libs/acp-lib/src/checkpointing/strategy.ts:49) then combines that instruction with the previous summary and new messages to form the actual model prompt.






# Optimization

Ok, yes that is actually a thing, we would be putting every time the same messages.
We would even be putting the same summary everytime.
What if we have a kind of cursor ?
Like suppose we have

agc1: summary [0: 100) + 7 messages
agc2: summary [0: 50) + 0 messages
agc3: summary [0: 50) + 32 messages


User sends a message to agc1, which means


 summary <-- ???
 + summary [0: 50) + 0 messages
 + summary [0: 50) + 32 messages

And now we could have a cursor which could keep track of the messages already covered like:


| |agc1|agc2|agc3|
|-|-|-|-|
|agc1|x|50|82|
|agc2|
|agc3|

Then, suppose the state advances to

agc1: summary [0: 100) + 8 messages
agc2: summary [0: 50) + 4 messages
agc3: summary [0: 100) + 2 messages

the next message would not send it all again, but instead maybe

 summary <-- ???
 + 4 messages
 + summary [0: 100) + 2 messages

Which arises a question of how to know about whether the summary is new or not, maybe we can infer this from the data we store for it

something like that ? New summaries I think should be sent

w u think ? 









Yes—I think the cursor is the right model. It means “what this **target provider thread** has already been told about each source conversation,” not “what the agent has stored.”

Your example has an important twist: if agc1 has already received agc3’s summary through 50 and messages through 82, and agc3 later publishes a summary through 100, **agc1 does not automatically need that new summary**. It already knows through 82. We could send messages 83 onward. The new summary is useful when initializing a *fresh* thread, or when the undelivered messages are too large and we deliberately use the summary to catch up. Sending every new summary would repeatedly re-send older knowledge.

I’d model it roughly as:

```text
(target agc, target provider-session ID, source agc)
  → delivered-through source sequence
```

On first delivery: send the source’s latest summary plus its uncovered tail. Thereafter: send only messages after the cursor. Advance the cursor only after the target prompt succeeds; if delivery is uncertain, re-sending is safer than silently losing context. When the target gets a new provider thread, its cursors reset. The existing checkpoint ID and `coveredSequence` tell us whether a newer summary can cover an oversized gap.

This is more than a minor optimization: without it, repeated identity injection could consume a lot of context. I’d design the cursor into identity v1, while deferring clever decisions about *when to substitute a summary for a large delta*. One implementation change is needed: the current `identity.load()` hook does not identify the target provider thread or acknowledge successful delivery, so the lifecycle would need to expose those points.


Yes, if we want cursors to survive reopening the library, a **new table** is the cleanest place. The existing identity tables describe the agent’s knowledge; these cursors describe what a particular provider thread has *received*.

It would be a fixed, sparse table—not a new column for every conversation:

```text
identity_delivery_cursors
  target_conversation_id
  target_internal_session_id
  source_conversation_id
  delivered_through_sequence
  updated_at
```

One row exists only after that target thread has received context from that source. Creating a conversation changes **no schema and no cursor rows**. At its first prompt, it finds no rows, receives the relevant summaries and tails, and rows are created after successful delivery. Likewise, an existing conversation discovers a newly created source at its next prompt.

The important edge cases are manageable:

- **New/recovered/handoff provider thread:** new internal session ID means a fresh set of cursors and a full initial view.
- **Source changes during a prompt:** record the exact source sequence included in that prompt; later messages wait for the next one.
- **Prompt fails or delivery is uncertain:** don’t advance the cursor. Possible repetition is preferable to missing knowledge.
- **Same thread is reopened:** reuse its cursors. If the harness silently discards context while retaining its session ID, we cannot reliably detect that; that’s an explicit limitation or a reason to provide a cursor-reset operation.
- **Many conversations:** rows grow by observed target–source pairs, not by messages. Even 20 conversations imply at most 380 pairs per provider-thread generation.

So adding the table requires one ordinary database schema change, but **adding an agent conversation never alters the table’s structure**.


Yes: with three conversations, there are **at most six directed pairs** (`agc1 → agc2` and `agc2 → agc1` are different cursors). With four, the maximum is twelve. But creating the fourth conversation creates **zero cursor rows**. Rows are added lazily, only when a target provider thread is actually given context from a source conversation. Some pairs may never exist.

And I agree: **no self-cursor**. A conversation’s live provider thread already has its own chat; if that thread is lost, the existing conversation checkpoint and recovery mechanism restore it. Identity delivery should cover *other* conversations, so `target_conversation_id !== source_conversation_id`. That keeps the two responsibilities separate.




---


We have the **core architecture** defined. I’d call it ready for a v1 spec, but I’d pin down a few behavioral rules before implementation:

- **Visibility:** assume every non-deleted conversation in an agent is a source for every other conversation. That is genuinely shared identity; it also means information from one user’s chat could reach another’s. We should make that assumption explicit.
- **Delivery:** a new provider thread gets each source’s latest checkpoint summary plus messages after it. An existing thread gets only messages beyond its cursor. A newer summary is used to bridge an undelivered gap, not automatically resent.
- **Budget:** send only an ordered portion that fits. Advance a cursor only through content actually delivered—never skip unseen messages silently. A later checkpoint can help catch up.
- **Acknowledgment:** capture the source frontiers while composing the prompt, then advance their cursors only when that prompt completes successfully. This requires extending the current identity lifecycle; `load()` alone cannot safely do it.

No self-cursors; own-chat recovery stays with checkpointing. Different agents can configure different checkpoint summary instructions, and more specialized identity summaries can come later. So there’s no major architectural unknown left for this first version, but those four rules should be written into the spec rather than left to incidental implementation choices.

