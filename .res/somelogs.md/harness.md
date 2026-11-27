Each conversation runs its own model calls, like a server handling requests. There's no single shared call and no periodic loop. Let me walk through your example and then take the three points.

## The execution model

Four conversations, four separate contexts:

```
C-user    (John)    ──┐
C-agent1  (agent1)  ──┼── same system prompt, same shared state, same memory
C-agent2  (agent2)  ──┤   = one entity
C-agent3  (agent3)  ──┘   but four separate message lists
```

- **A message arriving in a conversation starts a model call with that conversation's context.** Four conversations can be mid-turn at once: four independent HTTP requests.
- **What makes it one agent is everything shared,** not a shared request: the system prompt, shared state, memory and identity.

So when agent3 says "package X is compromised", only C-agent3 runs a call. What C-agent1, C-agent2 and C-user see depends on what the agent does in that turn.

## In that turn, the agent can do three things

| What                     | How                                          | Effect on other conversations                                                                        |
| ------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Reply to agent3          | Plain text                                   | None. Text always goes to this conversation's own participants.                                      |
| Record it                | A shared-state tool                          | **Pull:** each other conversation sees it on its next call, filtered by its policy. Nobody is woken. |
| Tell specific others now | A `message` tool with one or more recipients | **Push:** it reaches them now                                                                        |

So yes: telling others is behavior. It's the agent's judgment, through a tool, exactly as you guessed. Plain text is the answer to whoever is in this conversation. Anything aimed elsewhere is a tool call. And recipients are a list from the start: `message(to: ["agent2", "john"], text)`. Multi-party is the point of this harness, so multiple recipients belong in the first version.

## What does `message` actually do? Two options

**A. Direct delivery.** The tool's text goes straight to agent2. It's recorded in C-agent2's history as something the agent said. No model call in C-agent2.

- Cheap: one call total.
- But the text was written with C-agent3's context. It doesn't know what agent2 already knows, it may leak details from C-agent3, and it's phrased for no one in particular.

**B. Wake the target conversation.** The tool puts an inbox item in C-agent2 ("from your conversation with agent3: package X is compromised; tell agent2"). That starts a model call in C-agent2, and that turn writes to agent2 with C-agent2's own context.

- Costs one extra call per recipient.
- The message is written knowing agent2: what it was told before, its policy, its language. Nothing from C-agent3 leaks beyond the item itself.

My pick: **support both, and let the agent choose.**

- **`message`** is direct (A), for "tell them this" when the text is self-contained. It's the common case and cheap.
- **`notify`** is B, for "handle this over there", when the target conversation has to think: adapt the message, ask something, combine it with what it knows.

**Why plain text isn't routed through a tool too.** You could make every visible output a tool call, so that even the reply to agent3 is `message(to: "agent3")`. Letta (formerly MemGPT) works that way: plain text is the agent's private thinking, and only `send_message` reaches anyone. It gives uniform addressing and private reasoning. The costs: models are trained to answer directly, every reply needs an extra tool call, and streaming replies gets awkward. For the conversation's own participants, I'd keep plain text, with tools for everyone else.

## 2. Policy

Your point 2 came through empty. In case it was about sending: a message is checked on both sides.

- **The sender's policy:** can this conversation message others, and whom? For example, a `guest` can't message the owner's chat directly; the owner gets reached only through escalation.
- **The recipient side:** the content's scope must be visible to the recipient's policy, the same rule as shared-state visibility.

Tell me if you meant something else there.

## 3. How "append" works

The context is a list, and new things are only ever added at the end. Here's C-agent2 over time:

```
call 5:  [system] [tools] [header] m1 m2 ... m9 [agent2: "hi"]
         ── meanwhile agent3 reports package X in another conversation ──
call 6:  [system] [tools] [header] m1 m2 ... m9 [agent2: "hi"] [reply]
         [user] <since-last-turn> agent3 (trusted): package X is compromised </since-last-turn>
         [agent2: "should I install X?"]
```

**What happens at call 6:**

- **The harness checks what changed.** Each conversation keeps a watermark, the shared-state version it last saw. The library already does this for out-of-band messages (`outOfBandDelivery` in persistence).
- **It renders the delta once and appends it,** as a tagged block, before the new incoming message.
- **The delta then stays in the history permanently.** At call 7 it's part of the unchanged prefix, so it's served from cache. It's never re-rendered or moved.

**The alternative breaks the cache.** A "current state" block near the top, rewritten on every call, would change the prefix every time and invalidate everything after it, every call.

**The cost of appending:** old deltas pile up in the history. Compaction handles that. When a conversation is compacted, the accumulated deltas get folded into one fresh snapshot.





## The pattern

- **Microkernel with ports and adapters.** The kernel coordinates, every feature plugs in through a contract, and the outside world (providers, storage, the library) sits behind adapters.
- **Inside the kernel, two pieces:**
    - **One actor per session.** Each session has a mailbox (the inbox) and processes it one item at a time. Sessions run in parallel. No framework, just a sequential queue per session.
    - **An explicit turn state machine:** idle → building → calling → running tools → building… → idle, plus interrupting. It's a pure function from state and event to the next state and the actions to run. A separate runner executes those actions. Steering is just an item arriving while the session isn't idle: it waits in the mailbox and gets picked up at the next build.
- **A functional core for the context:** pipeline stages, renderers and compactors are pure functions from data to data. Only stores, clients, providers and the kernel's runner do I/O.
- **Middleware chains, only for model calls and tool calls:** retries, permissions, timeouts, logging.
- **Registries** for tools, renderers and providers.
- **An event-sourced store:** the session is an append-only log, the context is a projection of it, and compaction is an event in the log.

## The structure

```
packages/native-harness/
  package.json              exports: ".", "./openai-compatible", "./mcp", "./testing"
  AGENTS.md                 contribution rules
  ARCHITECTURE.md           the pattern and the rules, next to the code
  decisions/                0001-contracts.md, ...
  src/
    contracts/              imports nothing
      entries.ts            Entry, Part, SenderRef
      inbox.ts              InboxItem
      model.ts              ModelClient, ModelRequest, ModelEvent
      context.ts            PipelineStage, Renderer, Compactor, ContextStore
      tools.ts              ToolDefinition, ToolProvider, ToolMiddleware
      permissions.ts        PermissionGate
      guards.ts             Guard
      events.ts             LifecycleEvent, EventSource
      errors.ts             typed errors
    kernel/
      harness.ts            registries; createSession / loadSession
      session.ts            the session actor: mailbox, one item at a time
      turn-machine.ts       states and transitions; pure
      turn-runner.ts        runs the machine's actions through the extension points
      lifecycle.ts          event bus
    context/                pure, except store/
      pipeline/             compose.ts; layers.ts, inbox.ts, senders.ts, cache-order.ts
      renderers/            registry.ts; user-message.ts, worker-reply.ts, ...
      compactors/           clear-tool-results.ts, summarize.ts
      store/                log.ts (append-only log + projection), memory.ts, file.ts
    model/
      chain/                compose.ts, retry.ts, rate-limit.ts, call-log.ts
      profiles/
      clients/
        openai-compatible/  render.ts (neutral → provider JSON), parse.ts (stream → events), client.ts
    tools/
      registry.ts
      chain/                compose.ts, validate.ts, permission.ts, timeout.ts, truncate.ts
      providers/
        consumer/
        mcp/
    permissions/            allow-all.ts
    guards/                 call-limit.ts, unattended-turns.ts
    events/                 reminders.ts
    testing/                scripted-client.ts, golden.ts, conformance/ (one suite per contract)
    index.ts                public API only
  test/
    scenarios/              whole turns with the scripted client
    golden/                 expected requests
```

**Details worth noting:**

- **Subpath exports keep heavy dependencies optional.** `./openai-compatible` and `./mcp` are separate entry points, so the MCP SDK is only loaded by consumers who use it.
- **Conformance suites are exported through `./testing`.** The library's own implementations (its store, its policy gate, its tool provider) run the same suites as the harness's built-in ones. The contract is checked on both sides of the boundary.
- **Provider translation is two pure functions:** neutral-to-provider rendering and stream parsing. Both are golden-testable without a network.
- **Each top-level folder is one workstream:** `context/`, `model/`, `tools/`, `permissions/` and `guards/`, `events/`. That's the unit of parallel work.

**The dependency rules, enforced by tooling:**

1. `contracts` imports nothing.
2. `kernel` imports only `contracts`.
3. Every other folder imports `contracts`, never another folder's internals.
4. Nothing imports from the library.

Should I write this pattern and structure into the harness doc? It would replace the current package-structure section and add the pattern to the principles, without the comparison of alternatives.






The design is done at the level we planned. What's left is a few decisions only you can make, plus open items that can be settled during implementation.

**Decisions for you, before or at the start of implementation:**

1. **Phase 1 memory:** a simple shared state, or copying context between conversations (the current checkpoint-backed identity)? I recommend shared state for native conversations, with copying kept as the fallback for ACP ones.
2. **Repo layout:** turn the repo into a Bun workspace with `packages/native-harness`, or keep a single package with `src/native-harness/` and enforced boundaries? The workspace changes how the repo publishes.
3. **Harness package name,** and whether it's published separately from the start or kept private until it stabilizes.

**Can be settled during implementation** (all listed in the docs' open questions):

- **The way back:** what a worker reply contains, batching, and the loop guard's limits.
- **The shared-state tool:** its shape, and when the agent should write and share.
- **Steering:** whether it aborts an in-flight model call or waits for it.
- **Smaller items:**
    - who answers a worker's permission request when the delegating conversation can't;
    - whether the pool is the only way to wake a worker;
    - eviction preference;
    - the cache cost of changing a policy;
    - linking worker cost to the delegating conversation;
    - the fate of the `AgentSession` REPL;
    - size limits, boundary tooling, and the decision-record format.
- **All the prompt text,** which is deliberately deferred: tool descriptions, headers, sender tags, delta wording.

**Blocking for later steps:**

- **A provider key** for anything past the offline work. There's no OpenRouter key yet, and the OpenCode Zen key has expired.

**Next step:** an implementation plan. The first pieces need no provider key:

1. extract the controller interface from what `AgentSession` uses;
2. lay the harness foundation: contracts, conformance skeletons, the kernel with the scripted client, golden requests;
3. build the orchestrator and pool, tested through the consumer API;
4. build participants, policies and the shared-state skeleton.

**Docs:**

- [Front conversations and a worker pool (design notes)](https://claude.ai/artifact/RwBuqXuW3UU7cfr7j41n7R)
- [Native harness: project architecture and contribution rules](https://claude.ai/artifact/Vntbpf743LuQxU8jrWvjTg)
- [Agent harnesses: a learning guide](https://claude.ai/artifact/D5GCV8S4T3mE1ekPoRA9ty)

Once you answer 1 to 3, I can write the implementation plan and start on step 1.





if we delegate the store then we just have the same library separated. 

no that isnt a harness, is totally dependant on the library.
If it has to be separated then it should be the other way: the harness writes, and optionally it can be told to write in a specific location, which is what the library does for its own persistence, so we can then just forward that to the harness to determine the memory part etc

then the client is another big problem. I understand the reason but if we do it like that then separating into a different package is simply stupid.
I know this would mean to have two httpClients on both the library and the harness (if we want an internal inference provider from http, which seems pretty good), but this could be a place where duplication is the only real way for the separation objective we have
Also, the NativeController does not need to have an equivalent to ACPClient. We could just allow the agent to define that.

also as it is, it would absolutely not work standalone via cli.


also I dont like to have tools and policy defined like that. thats too complex. it should be json.

Im thinkin on the ofllowing:

we have like two parts on teh flow of the harness:
1. configuration
tools, path (optionally, to set where to store), policy, etc --> harness
this gets stored as config, someway, and it gets retrived for each prompt or whateverj


2. prompt
send prompt, fetch configuration



tools should be a simple json. thats for sure. wait, not sure actually. because if we allow to just pass a function then that would be pretty good right?
in any case the harness should define the contract, not the library

then for policy, what do we do? a policy over what governs? Only the tools? no, is also over the memory. So there we get into a sort of problem, because it can touch things itnernal to the harness, like memory, but also over tools defiend by the user, which can be dinamically defined so the harness doesnt know them. one ooption is to just have an implicit contract, and so the harness could have 

memory
messaging
...

and then a policy could be something like

[
    "agent": {
        "memory": ??,
        "sending message to user": true
        "customTools": {
            "tool_defined_by_the_user": true
            }
    },
    ...
]

And we would also have a persistence part like all harnesses have, probably writing a simple jsonl file. this could be disabled, and probably even deferred for this pass.
But storage wuold have:
- config
- session
- memory




Altough, there is a catch... because the orchestrator is outside the harness. So then we are building like a harness which needs like a full suite of components around.
but... does that concern the harness? Because yes we would need to give it access to the orchestrator to have subagents.
But that is because we cant make the harness work as good as other harnesses, but we need a high degree of customization.

So the harness could very well grow quite beyond the current point (thats kind of the point), and then it cuold actually do the editing, reading, etc itself.
The orchestrator still could make sense, becausae this is a whole aprt that the harness probably never will encompass: driving another harnesses, even with different providers, etc. Like this library is literally about driving another harness instead of doing the work itself, so the harness itself will never be as good as this at that.










# ?

It's a two-step handshake: **prepare** computes what's pending without committing, **delivered** commits. The harness keeps one watermark per member session: the position in its state log up to which that member has received entries.

## Step by step

ACP conversation C is registered in the harness as member session M. M's watermark is at log position 140.

1. **acp-client is about to send a prompt to C.** It calls `prepare(C, providerContextId)`.
2. **The harness computes what's pending:** entries after position 140 that M's policy can see. It renders them into a preamble and returns:

   ```ts
   { preamble: "...", receipt: { member: "M", context: "ctx-7", through: 152 } }
   ```

   **The watermark doesn't move yet.**
3. **acp-client sends the prompt** to Codex, preamble included.
4. **Once the provider has the prompt,** acp-client calls `delivered(receipt)`. The harness moves M's watermark to 152. It only ever moves forward: `max(current, 152)`.
5. **The next `prepare` starts from 152.** Only newer entries are delivered.

acp-client stores nothing identity-related. It holds the receipt in memory between steps 2 and 4, and that's all.

## Failure cases

| What happens                                                                  | Result                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The prompt fails before reaching the provider (error, cancelled while queued) | No `delivered` call, so the watermark stays at 140. The next prompt delivers the same entries. Nothing is lost.                                                                                                                       |
| A crash after the provider received the prompt but before `delivered`         | The next prompt repeats entries 141 to 152. Delivery is at least once, and duplicate information is harmless. The harness can mark them as repeated.                                                                                  |
| Two prompts prepared before either is delivered                               | Doesn't happen. acp-client runs one turn at a time per conversation, and messages that are combined go out as one prompt with one receipt.                                                                                            |
| The ACP context is replaced (new provider session, handoff, recovery)         | The watermark is keyed by member and provider context, as today's cursor is keyed by `targetProviderContextId`. A new context hasn't seen anything, so the harness starts it from a snapshot of current state, not from the full log. |
| Codex compacts its own context and drops what we delivered                    | We can't detect this. The member can still pull through the MCP tools (`state_since`, `state_read`).                                                                                                                                  |

## Why the harness keeps the watermark

The harness decides what's pending. Only it knows its log positions, its policy filters and its snapshot rules. Keeping the watermark next to the log avoids two stores that have to agree. And since members are already sessions in the harness, with an id and a policy, the watermark is just one more field on them.

**An alternative that's also decoupled: an opaque cursor held by acp-client.** The harness returns a cursor string with each delivery. acp-client stores it per conversation and context, and passes it back on the next `prepare`, like a pagination token. The harness then holds no per-member delivery state, but acp-client persists a string per conversation, which is roughly what it does today with its own cursors.

I'd keep the watermark in the harness, because member sessions exist there anyway.






# !?

but we still have a pretty big conflict here. Because a lot of this goes in the direction of the harness having knowledge over different conversations. But if it holds cursors for each conversation, then it would probably hold also the identity for each right? but if it does that, it may also as well store the actual messages. And then we have another sqlite.
At the same time... is that neccessarily bad?
Like yes it does seem a little exagerated to have a second sqlite db, but we need to store the data somehow. And if we want to make the harness useful on its own, we need a way to hold data. An sqlite is just a good way to do that a lot of the times. in fact is probably the best way for storing messages that I want to later search through.

It also makes me think... if I wanted to provide the model the capacity of searching through its own chats, I would need to give tools for searching within the chats. which could a) be tools the harness has; or b) be tools acp-client sends
a implies that the harness looks over its own db, or the acp-client db. b implies that the harness requires acp-client to search through its sent messages.

this is a concern that starts to appear with a lot of capabilities, not only chats.
which is basically whether to write for acp-client, and have the harness get this tools in the context of being embedded into acp-client; or write for the harness, making it more useful on its own, but restricting what acp-client can offer for the other harnesses (which could also be a valid option, but is not free).
Other option is to accept the eventual duplication. the session transcript is not a priority for the harness in any case.

but when it comes to actual identity the problem becomes a little confusing...

so, for once, we do need the harness to deal with the concept of different users, policies and memory overall.
So, it would seem that it has to necessarily know about the users, and also about whats with each user. It then follows that it must also need to know about what each user already knows right? otherwise it would be kind of fragmented. and doing it like this would also give place to pretty crazy things like the agent knowing that a participant does not know about x, because it can know up until what moment it was sent a message or something. So your point about cursors on the library is probably not so bad.
but, it couldnt be in the same way that we have them now. because thats too coupled to the messages

but does it has to know about each transcript? Like, does it really care?
and note that again, I do think that is quite valid to later have session storage on the harness itself, but do we actually care about that?
Because, as I see... the main point in which the power of this idea of harness relies is not in the past or persistence, but in how it works while is up and running. Because when is active, then it becomes a sort of server, which dynamically allows to get 100s of requests and have a dynamic shared identity with a stable core, reacting to information. and since the context is a very large text, we could even get off without any sort of persistence whatsoever (which is not the case as acp-client persist the messages)







I think the conflict dissolves once we separate the three kinds of data the harness could hold. They're very different in how much they matter.

## Three kinds of harness data

| Data                 | What it is                                                               | Without it                                                                                            | Must persist?                                  |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Identity core**    | Config, participants, policies, shared state, memory, and who knows what | The entity has amnesia after a restart: a different agent                                             | **Yes.** It's small and essential              |
| **Working contexts** | The live context of each native session                                  | A restarted conversation begins fresh, with identity layers and a summary instead of its full history | Useful for resuming; optional, can be deferred |
| **Transcripts**      | The full record of every conversation, for search and audit              | The agent can't search its past chats natively                                                        | No; acp-client already keeps its own           |

That matches your point about runtime. The power is in the running server: hundreds of requests, a shared identity reacting live. So persistence can be minimal, but not zero. The identity core has to survive a restart, or the entity isn't stable. The rest can live in memory for the first pass.

**A second SQLite database is fine.** The two have different owners and different purposes: acp-client's records observe conversations; the harness's store is the entity. Bun ships SQLite built in (`bun:sqlite`), so it costs no dependency. The host can point both at the same directory if it wants.

## Who knows what: a ledger of facts, not message cursors

You're right that today's cursors are too tied to messages ("delivered through message sequence N from conversation Y"). The new version tracks **entries and participants**. There are two different questions here:

1. **What a conversation's context contains** (the agent's side): which shared-state entries have been rendered into that context. This is the watermark from before: per session and provider context, over the state log. It's structural and exact.
2. **What a participant has been told** (the person's side): which facts actually reached John, in any of his conversations. This is what makes "John doesn't know about X yet" possible. It gets recorded two ways:
    - **structurally,** when the agent passes something on through a messaging tool that references an entry: `message_participant(to: john, text, about: [entry-42])`;
    - **by judgment,** when the agent mentions something in plain text and records "told John about X" as an entry.

Both live in the harness, because they're about the entity. Neither needs the transcripts. They point at entries and participants, not message sequences.

## The general dilemma: write for the harness or for acp-client?

This will come up with many capabilities. Chat search is the first. A rule that resolves it:

- **The harness owns capabilities about the entity:** identity, memory, shared state, participants, its own sessions. It defines the contract and ships a native implementation, so it's useful on its own.
- **acp-client owns capabilities about driving other harnesses:** workers, ACP sessions, the pool.
- **When both have data for the same capability,** the harness defines a **source contract** and the host plugs in extra sources. That's the same pattern as `registerFunction` and delegation backends: extension, not dependency.

For chat search, that means:

- **The harness has a `search_conversations` tool** backed by a history-source contract.
- **Standalone,** the source is the harness's own working contexts, plus its transcripts if those are enabled.
- **Embedded in acp-client,** the library adds a source over its records, which covers the ACP conversations the harness never held.

The harness never reads acp-client's database. The library hands it a source. And the tool works either way.

This isn't the delegated store you rejected. The harness doesn't depend on the source to function. It's an optional extra input, like any plugin.

## For the first pass

- **The identity core,** persisted in the harness's own SQLite: config, participants, policies, the shared-state log, both ledgers, and memory once it exists.
- **Working contexts** in memory, with a JSONL snapshot later.
- **Transcripts** not kept by the harness; acp-client's records cover them.
- **Chat search** later, through the source contract.

Does this split resolve it for you? If so, I'll fold it into the docs with everything else pending.









I've updated both docs.

**[Native harness doc](https://claude.ai/artifact/Vntbpf743LuQxU8jrWvjTg):**

- **Principles:** the harness is self-sufficient (own storage, model client, config, policies and CLI), and the library is one host among others.
- **Extension points:** three new ones — a function registry, a delegation backend and history sources. The cells that still said "library store" or "library policy gate" are fixed.
- **New "Configuration and policies" section:**
    - the full JSON config;
    - tools that run as `http`, `command` or `function`;
    - policies over capabilities the harness names, plus tool patterns;
    - presets, participants and the standalone CLI.
- **New "Data and storage" section:**
    - identity core vs. working contexts vs. transcripts, with how each persists;
    - the file layout, with SQLite for the identity core.
- **New "Identity and member sessions" section:**
    - the harness instance is the entity;
    - full vs. member sessions, and the MCP server tools;
    - workers as members;
    - the two ledgers of who knows what;
    - the delivery handshake with its failure cases, and the limits.
- **Rewritten "Boundary with the library":**
    - the ownership rule;
    - the seam table;
    - `IdentitySource` as injection only, with the injector skipping native conversations;
    - the two logs.
- **Smaller fixes:**
    - the new folders in the package structure;
    - the extra workstreams;
    - the integration step;
    - three new open questions;
    - the diagram's library label.

**[Design doc](https://claude.ai/artifact/RwBuqXuW3UU7cfr7j41n7R):**

- **New "Identity ownership" section:** the harness owns the entity and acp-client only injects; delivery, the ledgers, and deprecating the checkpoint-backed runtime; the sequence.
- **Configuration rewritten:** the `Agent` config now only points at the harness (root and config), registers functions, sets up the orchestrator and picks the internal inference runtime. The section also covers the new `http` internal-inference runtime.
- **A note in the policies section:** policies now live in the harness's JSON.
- **Decisions and open questions:** six new agreed items. "Phase 1 memory = shared state" moved from open questions to decisions. New open questions on the repo layout and the harness name.











ok, but I still dont think the identity is finished. your proposal, seems quite rigid and I dont know if that would actually work. You are thinking too much in terms of inidividual items, and could work for individual details, but not for big chunks of time
what im thinking is... what if we had a sort of timeline? each new message or whatever, maybe notification or maybe request... would advance the timeline.  Then a conversation gets stuck in a point in the timeline.
This does seem pretty similar to the cursors. There is a slight difference though: in there all conversations had pointers referencing how much of the other conversations they already covered. Here it is different: there is only one timeline, and every conversation gets stuck in a point in time in reference to that timeline.
And this does support individual details, because each new detail now has a point in time in which it was said.
So now saying to john all the important things that happened is just retrieving all the details that are from the point in time 3 to the current timeline.
There are still some open questions like how to cover things aside from one-off details. like for example context about other chats, etc. but I feel like that is just because the memory system is not defined (which is kind of what we agreed) not a limitation of the model Im proposing.

w u think




I think it's better than what I proposed, and it ties the other pieces together.

## Why it's better

|                        | Old cursors                                | My ledgers                         | Your timeline                                 |
| ---------------------- | ------------------------------------------ | ---------------------------------- | --------------------------------------------- |
| State kept             | One cursor per pair of conversations (N×N) | Watermarks plus per-entry records  | **One position per conversation**             |
| Unit                   | Messages of one other conversation         | Individual entries                 | **Points in time,** over everything           |
| "What happened since?" | Assembled from N cursors                   | Only what got recorded as an entry | **One query: the slice from position to now** |
| Big chunks of time     | Copied raw                                 | Not covered                        | **Natural: a slice is a span**                |

And it fits what we already chose. The harness store is event-sourced, so the timeline is simply the harness's log, made global:

- **Shared state becomes a projection of the timeline:** the current facts and commitments, derived from its events.
- **Memory becomes a consolidation of the timeline** over long spans.
- **Delivery becomes "give conversation C the slice from its position to now".**

One log, several views.

## Four refinements, so it doesn't fall back into copying

**1. A slice must be digested, not copied.** A raw slice from point 3 to now is exactly what made the old identity useless: too much text, cut off by a budget. So the timeline needs **summaries at several granularities**: raw events, then summaries of episodes, then summaries of days. Delivering "everything since point 3" takes the coarse summaries for old spans and raw events only for the recent part. That's how it handles big chunks of time. The summaries are background work, and the new `http` internal-inference runtime is the right tool for producing them.

**2. Every event carries a scope.** Slices are filtered by the receiving conversation's policy. Then a public chat's slice never includes John's private conversation, even though both are on the same timeline.

**3. A position means "this context has been brought up to here".** That's the agent's side. What a participant actually knows is still a different question: being at point 9 in John's chat doesn't mean John was told everything up to 9. But that also fits the timeline. "Told John about X" is itself an event, written either by the messaging tools or by the agent's own judgment. "What doesn't John know yet?" becomes: what's important after the last time he was briefed on it.

**4. The timeline is only as complete as what reaches it.** For native sessions, every message lands on it automatically. For ACP members, the harness doesn't see their conversations, so the host has to report them. The library appends their messages (or turn summaries) to the timeline through the member API. Otherwise those conversations are holes in the agent's history.

## The resulting model

```
timeline          append-only events: { seq, at, kind, conversation, participant, scope, content }
positions         per session and provider context: the seq its context has reached
projections       current state (facts, commitments) · summaries per span · "told" events
delivery          digest(position..now, viewer's policy) → handshake → position advances
agent tools       timeline_since, timeline_search: pull more on demand
```

The handshake from before stays as it was, with one change: the receipt advances a single position on the global timeline, instead of a watermark over one state log.

## Still open

These are the memory questions you mentioned, and the model has a place for each:

- **Granularities and when summaries are made:** after each episode, on idle, or when a slice is requested.
- **What counts as important** in a digest, and how relevance is judged per receiving conversation.
- **What an event is:** every message, or only meaningful ones. I'd log every message, since that's cheap, and let the summaries do the selecting.
- **How positions behave when a conversation compacts or gets a new provider context:** probably rebased onto a snapshot of the current state plus a digest.

Should I update the docs so the timeline replaces the ledgers and watermarks, with shared state and memory recast as projections of it?




---

# 


Agreed on the adapters: `Adapter` stays the `HarnessController`'s type, and `NativeAdapter` is a separate type. `Agent` configs take either one. Below is the full model restated, then the orchestrator in depth. It's grounded in the code I read; nothing is written to the specs yet.

# The full model

## The pieces

| Piece                                  | What it is                                                                                                   | Owned by                                      | Lifetime                                     | Persisted in                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Agent**                              | One entity: one identity, one persistence, one pool. Usually one per process                                 | consumer                                      | process                                      | library SQLite                                                                                                     |
| **Conversation** (`AgentConversation`) | One thread of talk. Backed by a `HarnessController` (external harness) or a `NativeController` (our harness) | `Agent`'s conversation manager                | until deleted                                | library records (an observation log)                                                                               |
| **Native harness instance**            | The entity's mind: config, policies, timeline, shared state, model client, tools                             | the `Agent` (one per `Agent`)                 | process; its identity core survives restarts | harness SQLite in its root                                                                                         |
| **Harness session**                    | The live context of one native conversation (what the model sees)                                            | the harness                                   | per conversation                             | harness store; in memory first                                                                                     |
| **Worker**                             | An ordinary conversation the pool runs on the agent's behalf, usually ACP, sometimes native                  | the orchestrator                              | until dropped                                | library records, plus the orchestrator's own table                                                                 |
| **Pool**                               | The worker slots: how many workers may be live at once                                                       | the orchestrator                              | process                                      | derived from the orchestrator's table                                                                              |
| **Inbox**                              | What waits to reach a conversation                                                                           | the library (`agc`)                           | per conversation                             | two parts: the in-memory queue for live items, persisted out-of-band records for items that must survive a restart |
| **Policy**                             | What the agent may do for whoever sent this message                                                          | harness config; chosen per prompt by the host | per prompt                                   | harness config                                                                                                     |
| **Timeline**                           | One history of everything; a position per conversation                                                       | the harness                                   | permanent                                    | harness SQLite                                                                                                     |

## The roles in one sentence each

- **The host** (consumer code) decides who is talking and under which policy.
- **The harness** decides what the agent sees and enforces what it may do.
- **The model** decides what to do.
- **The orchestrator** decides whether a delegation can happen and runs it.
- **Workers** do the environment work.
- **The library** records everything and never speaks in the agent's voice.

## How things connect

```
host ──prompt(sender, policy)──► Conversation (native) ──NativeController──► harness session
                                     ▲  inbox                                   │ model calls
                                     │                                          │ tool calls
                                     │                                   delegate / check / stop
                                     │                                          ▼
                                     │                          delegation backend (src/native)
                                     │                                          ▼
                     delivery port ◄─┴──────────────────────────────── orchestrator ──► pool
                     (replies, permission requests, interrupted)            │
                                                                            ▼
                                                     worker Conversation ──HarnessController──► Codex/Claude
ACP Conversation ──HarnessController──► Claude          ▲
   └─ identity runtime (harness adapter): load → preamble, update → timeline, delivered → position
```

## Flow 1: a message reaches a native conversation

1. The host calls `conversation.prompt({ text, participantId, policy })`.
2. The library records the user message. The identity runtime's `update` reports it to the timeline, which the native side does on its own anyway.
3. The `NativeController` pushes an inbox item with sender and policy into the harness session.
4. The harness runs a turn: it renders the digest since the conversation's position, tools placed under the turn's policy, and the message. The tool loop runs, and the answer streams back.
5. The `NativeController` translates events into the update model, and the library records messages, tool calls and usage.

## Flow 2: a delegation round trip

1. The model calls `delegate(text)`.
2. The harness's permission gate checks the `delegation` capability, then calls the delegation backend.
3. The backend calls `orchestrator.open(actor = { conversation, policy }, text)`.
4. The orchestrator checks the policy limits (may use, scope, max held), takes a slot (evicting an idle worker if it has to), creates a worker conversation on the pool's adapter, records it in its table, and prompts it without awaiting the result. It returns `{ handle: "w1", status: "sent" }` at once.
5. The tool result goes back to the model, which tells the user something, and the turn ends.
6. The worker's turn ends. The orchestrator gets its result and builds a reply item: the worker's final message, sender `w1`. It hands the item to the delivery port, addressed to the opener conversation.
7. The delivery port persists the item, so a restart can't lose it, and wakes the conversation. The agent takes a turn and decides what to tell whom.

## Flow 3: permission forwarding

Today each prompt carries `handlers.onPermissionRequest(request, signal)` (`src/agent-session.ts:3536`). When the orchestrator prompts a worker, it passes a handler that:

1. resolves the level from the delegating turn's policy: deny, ask me, ask the agent, or allow;
2. for the two ask levels, records a pending request and delivers an inbox item (to the delegating conversation, or to the consumer's chosen target);
3. waits for an answer (`orchestrator.answerPermission`), for the timeout to expire (refusal), or for the abort signal (cancelled);
4. returns the outcome to the worker's harness.

## Flow 4: restart

- **The harness** reloads its identity core. Native sessions restart from identity layers plus a summary, or from snapshots if enabled.
- **The orchestrator** reads its table. Every worker comes back not live. Workers that were busy are marked interrupted, and an "interrupted" item is delivered to their opener. Pending permission requests are refused.
- **Persisted inbox items** that weren't consumed are delivered on the next wake.

# The orchestrator in depth

## What it is, and what it isn't

It's one library module, `src/orchestrator/`. It turns "the agent wants work done" into worker conversations and keeps every rule about them in one place.

It does not:
- decide whether to delegate (judgment, in the model);
- render anything into a context (the harness);
- speak to users (nobody in the library does);
- know about the harness (it only implements a backend shape the `src/native/` adapter wires up).

## Dependencies

| It uses                                                                       | For                                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------- |
| The `Agent`'s conversation manager (`create`, `open`, `list`, `delete`, stop) | creating, reloading and deleting workers        |
| A persistence extension (`orchestrator`, its own versioned table)             | its own state, without touching the core schema |
| A delivery port (an interface it defines)                                     | the way back, to native or ACP conversations    |
| The `Agent` event bus                                                         | events for the consumer                         |

Nothing imports the orchestrator except `src/native/delegation-backend.ts` and the `Agent`, which constructs it when `orchestrator` is configured.

## Data model

One row per worker in `orchestrator_workers`:

| Field               | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `handle`            | the short id the agent sees (`w1`), unique per `Agent`           |
| `conversationId`    | the worker's ordinary conversation                               |
| `openedBy`          | conversation id, or `consumer`                                   |
| `adapterId`, `kind` | where it runs; `kind` for limits counted per kind                |
| `residency`         | `live` or `evicted`                                              |
| `activity`          | `idle`, `busy`, `awaiting_permission`, `failed`, `interrupted`   |
| `currentPrompt`     | who sent the running prompt, its first characters, started at    |
| `lastUsedAt`        | for LRU eviction                                                 |
| `unreadReply`       | a reply whose opener is gone, shown on `check`                   |
| `droppedAt`         | soft delete until the conversation and provider session are gone |

Plus `orchestrator_permission_requests`: id, handle, the neutral request, the target conversation, status, deadline.

## Worker states

Two independent dimensions, plus dropped:

```
residency:  live ⇄ evicted                 (slots; only an idle worker is evicted)
activity:   idle → busy → idle             (a prompt, then its turn ends)
                   busy → awaiting_permission → busy
                   busy → failed | interrupted → idle on the next send
dropped:    terminal; any state → dropped (stops first if busy)
```

Only `live` counts against the slots. "No worker free" means every live worker is busy or awaiting permission and nothing idle can be evicted.

## Slots and scheduling

- **The limit:**
    - `workers.limit` counts live workers;
    - optional per-kind limits;
    - native workers count separately because they cost no process.
- **Acquiring a slot:** an `open`, or a `send` to an evicted worker, needs one. If the pool is full, the least recently used idle worker is evicted (stopped, handle kept). If none is idle, the answer is "no worker free" with the listing.
- **Serialization:**
    - Pool operations (acquire, evict, drop) run one at a time per `Agent`, so two conversations can't race for the last slot.
    - Prompts to a worker go through that worker conversation's own queue, which already serializes them.
- **Several conversations on one worker** (scope `all`): prompts queue in the worker in order, each with `participantId` set to the sending conversation. Steering only applies when the sender is the one whose prompt is running; otherwise the prompt queues. This is an assumption, see open item 5 below.
- **No wait queue,** and no retry by the orchestrator.

## The operations

| Operation                             | Checks                                                                 | Effect                                                                                                     | Returns                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `open(actor, text)`                   | `use`; `max` held by this conversation; depth if the actor is a worker | slot, create, record, prompt (not awaited)                                                                 | `{handle, sent}` or no worker free                                                                         |
| `send(actor, handle, text)`           | scope (own or all); not dropped                                        | slot if evicted (reload); prompt with `steer` if busy and the sender owns the running prompt, else `queue` | sent / steered / queued / no worker free                                                                   |
| `check(actor, handle)`                | scope                                                                  | none; read from the record and the worker's state                                                          | activity, elapsed, current prompt, last tool call titles, latest message, unread reply, pending permission |
| `stop(actor, handle)`                 | scope (a separate `stop` scope, see open item 6)                       | `interrupt()` on the worker, clearing its queue                                                            | stopped                                                                                                    |
| `drop(actor, handle)`                 | scope own, or consumer                                                 | stop, delete the conversation and provider session, mark dropped                                           | dropped                                                                                                    |
| `list(actor)`                         | none                                                                   | the workers visible under the scope                                                                        | summaries                                                                                                  |
| `answerPermission(actor, id, option)` | the actor is the request's target                                      | resolves the waiting handler                                                                               | ok, or already resolved / expired                                                                          |

The consumer API is the same operations with `actor = consumer`, which bypasses policy: `agent.workers.list / check / stop / delete`. That is the product stop button.

## The way back: the delivery port

```ts
interface DeliveryPort {
  deliver(to: ConversationId, item: InboxItemInput): Promise<"delivered" | "target_gone">;
}
```

- **Native targets:** the item is persisted, then pushed into the harness session. It wakes an idle session, or is injected at the next model call if busy.
- **ACP targets** (later, with MCP): it becomes a queued prompt.
- **What gets delivered:**
    - a reply when a worker's turn ends normally;
    - a failure (stalled, crashed, error);
    - a permission request that needs an answer;
    - "interrupted" after a restart.
- **A stop the agent asked for** produces no reply item: the tool result already said "stopped".
- **Target gone** (the opener was deleted): the reply stays as `unreadReply` and shows on any `check` or `list`.

## Events for the consumer

`worker_opened`, `worker_busy`, `worker_idle`, `worker_replied`, `worker_failed`, `worker_permission_requested`, `worker_permission_resolved`, `worker_evicted`, `worker_reloaded`, `worker_dropped`. Each carries the handle, the conversation id and `openedBy`. They're facts, never user-facing text.

## Failure modes

| Case                                           | Behaviour                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The worker process crashes mid-turn            | Existing crash handling ends the turn with an error; `activity: failed`; a failure item to the opener |
| The worker stalls                              | The stale supervisor cancels, then force-stops; a failure item                                        |
| A reload fails (session gone, adapter missing) | `send` returns an error the tool turns into a fixable message; the worker is marked failed            |
| A permission request goes unanswered           | Refused at the deadline; `worker_permission_resolved` with `timeout`                                  |
| The opener's turn is interrupted               | Workers keep running; stop on an agent conversation stops only its own turn                           |
| The `Agent` closes                             | `stopAll` stops live workers; busy ones are marked interrupted on the next start                      |

## Code structure

```
src/orchestrator/
  contracts.ts        Orchestrator, Actor, DelegationPolicy, DeliveryPort, results, events
  orchestrator.ts     the operations: checks, then calls into pool and workers
  pool.ts             slots, serialization, LRU eviction, per-kind limits
  workers.ts          prompting a worker (handlers, participantId, delivery mode), reading status
  permissions.ts      forwarding handler, levels, deadlines, answer routing
  delivery.ts         turning turn ends into reply or failure items
  persistence.ts      the persistence extension: tables, migrations, queries
  restart.ts          rebuild on start
  consumer-api.ts     agent.workers.*
  index.ts
```

Each file is well under the 400-line target. It touches existing code in three places: `Agent` (construct and expose), the conversation manager (its public surface, nothing new), and records (a new `agent_action` kind for delegation facts, if one is needed).

## What was never defined

These need your call; my recommendation comes first in each.

1. **Are workers shared or private by default?** You raised this early. Private, meaning visible to the opener only, with `scope: "all"` granted by policy (owner). Shared by default leaks one conversation's work into another.
2. **What a reply contains.** The final message plus a short fact line (duration, files the worker said it changed, if the harness reports them). The full transcript is available on demand later.
3. **Which turn ends wake the agent.** All of them in v1. Narrow it only if the test run shows noise.
4. **Several replies arriving together.** Batch everything already waiting into one turn. This is natural with the harness draining its inbox per call.
5. **Steer from a different sender.** Queue, never steer, so one conversation can't cut into another's running work. This ties into the existing TODO `10-2-TODO-steer-multi-participant.md`.
6. **Stop scope separate from message scope.** Yes: `scope` for check and message, `stop` for stop and drop. A trusted agent can then talk to a worker without being able to kill it.
7. **What happens to workers when their opener is deleted.** They stay as orphans owned by the consumer; retention cleans them up.
8. **Idle eviction only under pressure, or on a timer too.** Under pressure only in v1. A timer saves processes but costs reloads.
9. **A working directory per worker.** From the pool config (one `cwd`), or per worker kind later. The agent never picks paths.
10. **The loop guard.** It lives in the harness (unattended-turn budget), not in the orchestrator. The orchestrator only enforces the delegation depth limit for workers that delegate.

If this model matches what you have in mind, I'll write it into the orchestrator spec, and the model section into the overview, together with the Code plan sections.






the main premise of the harness is that there is a single agent entity. so each conversation serves the same identity. for acp-client, agc1 and agc2 are two different conversations, even if they are both of the user. So I think it would have to be shared. In fact is probably better for two agc conversations to have access to two workers, than for each to have access to one worker each.
So i would say shared

2. we can tune this and see what actually works. if im not mistaken origianlly we have two methods
- agent pull
- the worker finishes and sends a reply. we could initially just send the reply to the agent

3. yes

4. yes

5. queue doesnt work for a2a communication at all. it just makes sense in rare ocasions, mostly user-oriented. We either steer, or we say that is busy. In this case, I think the best is to say its busy, because two different conversations could have two different objectives. but the agent that called the worker should steer. Which means that we have to keep control of which is the original sender or author.
However, allowing other conversations to steer is not necessarily bad.
Suppose a trusted user makes the worker work on changing the api. then owner says to stop it. The owner has precedence.
So steering always is not necessarily bad, but what happens with two owner conversations?
We could have conditional rules and a sort f hierarchy for policies and trust level, but I feel like that is makeing the model more rigid. donno
We could leave this to the agent judgment. but what does that mean? 
we could maybe make it steer if trust level is equal or higher in the hierarchy, but that is not what fully says which is urgent.
Another agent could say a package is compromised, that could be more urgent that a "change color" from an owner (supposing we are trusting the agent).

At the same time, maybe im trying to save from a case that is not so common? 
Like, if I have two chats with the agent, and its working on thingA because I told that on convA, then I tell it to work on thingB on convB, it wouldnt be illogical that it stops doing thingA to do thingB if there is only one worker.
same with happen with any worker.
So maybe the best thing to do is not necessarily steer right away, or reject, but give a warning.
The agent on thingB (which btw would probably already know that its currently working in thingA) cuold try to steer the worker, and there would be a warning or something that the worker is working on another task.
But we can't say another conversation because remember that there is only one agent.
But we can say it without breaking the entity: it's the same entity, talking with the same user, but is in another conversation. So the agent could say the user naturally something like:
"I'm currently working on the thing you told me on another conversation, would you like me to stop with that and do this?"

And here is where the task model could be interesting, but in a very soft manner, without any actual structure around it. The agent when taking to a worker, could put a very short description of what the assignment is about, like
"debugging api for 403 response on /path"

then, when the agent wants to check the worker, that would be useful, or even as a warning.
And then each worker would have attached:
- the conversation in which it was last talked about
- the "task"
- the last agc or sender

whether it says worker, makes it seem as if it is working itself, is more an implementation detail i think

???


9. So by default we just pass the general agent configuration. But allowing to set a workspace per worker is interesting, and I wuold actually give the option to the agent, but yes this is probably for later, and a single cwd is probably alright. It needs to keep working as it is though, with the launcher, the option for different cwd, etc. remember that the agent could...
thats something important: suppose a consumer that runs acp-client on a container, and has each agent on a different container. That would still work here fully? We need the native harness to respect that. Like, the actual harness, which is the one that makes operations, should be able to be run from outside, im not sure we reallythought about that did we???









## What "inbox" means here

A conversation's inbox is the list of things waiting to reach the agent in that conversation, other than the host's own prompt calls. Concretely, in the code we have:

- **For a native conversation:** the item is pushed into the harness session. If the session is idle, it starts a turn. If a turn is running, it goes into the context at the next model call; it doesn't interrupt.
- **For an ACP conversation:** nothing can be injected into a running harness, so the item waits and goes out with the next prompt. That is exactly what out-of-band messages do today (`src/out-of-band-messages.ts`: persisted records delivered into the next prompt).
- **Persistence:** items that must survive a restart (a worker reply, "interrupted", "redirected") are written as records first, the way out-of-band messages are. Live steering stays in the in-memory queue (`AgentConversationQueue`).

So in the redirect case: conversation A delegated "debugging the 403…". Conversation B redirects the worker. A record lands in A, saying its work was redirected from a conversation with Bob, with what, and when. Then one of two things happens:

- **Wake** (my recommendation): A takes a turn now. The agent may write to its user ("heads up, I've switched to something from our other chat"), or stay silent.
- **Quiet:** A sees it on its next turn, whenever the user writes again.

One catch with waking. A turn the agent takes on its own produces output (events and records), but it only reaches the user if the host delivers it, just as with any reply. That's the consumer's side, and the same holds for worker replies.

## Isolation is a v1 requirement: what it changes

Today an ACP conversation's whole harness runs as its own process, started through the `AcpLauncher`. Its loop, credentials, session files and every operation it performs live in the agent's environment (a container, say), while acp-client runs elsewhere. The native harness must give the same guarantee. The current design runs the harness inside acp-client's process, so it doesn't.

Two ways to get it:

|                                      | A. Isolate only execution                                                               | B. The harness runs as its own process (recommended)                |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| What runs in the agent's environment | `command` tools and stdio MCP servers, through an execution port that uses the launcher | The whole harness: loop, tools, MCP, model calls, storage, identity |
| What stays in acp-client's process   | The kernel, context, timeline, API keys, storage                                        | Only the `NativeController` (a client)                              |
| Same guarantee as ACP conversations  | No. Memory, credentials and network egress for `http` tools stay with acp-client        | Yes                                                                 |
| Cost                                 | Small                                                                                   | A protocol, process lifecycle, callbacks to the host                |

I'd go with B. It is the guarantee you described, and it is also what makes remote and containerized setups work in general. What B means:

- **One harness process per `Agent`, not per conversation.** All the entity's conversations go over one connection, so it stays cheap. It's started through the same launcher as ACP harnesses, so `docker exec`, a cwd and an env work unchanged. That probably means generalizing `AcpLauncher` into a `Launcher` that isn't ACP-specific.
- **`harness serve --stdio`:** the harness ships a server mode. Its protocol is the public API made serializable:
    - sessions, `push`, interrupt, events, config;
    - `prepare`, `delivered` and `report` for member conversations.
- **Callbacks from harness to host,** the way ACP harnesses ask the client for fs and terminals:
    - function tools (`registerFunction` becomes "the host serves these names");
    - the delegation backend (the orchestrator stays in acp-client);
    - history sources;
    - forwarded permission answers.
- **The `NativeController` gets two transports:** in-process, for tests and for the standalone CLI, and a process, the default with acp-client. The kernel doesn't know which one it runs under.
- **Storage** goes in the harness's root inside the agent's environment (a volume). acp-client keeps only its records.

**Own protocol, or ACP with extensions?** ACP already has a process, sessions, prompts, streamed updates, permission requests, client callbacks and custom `_` methods. So "the harness speaks ACP" could reuse the `HarnessController` and all of the library's ACP machinery. That was the rejected "in-process ACP agent", now as a process. But ACP has no:

- turns started by the agent itself (wakes);
- injection into a running turn (native steering);
- policy per prompt, except in `_meta`;
- non-prompt inbox items;
- member identity calls.

The core of our design would live in extensions. I'd use an own JSON-RPC protocol over stdio, reusing the library's transport code (`src/transport`). The `NativeController` is its client, and stays thin.

## What this adds to v1

- The serializable API becomes a v1 requirement, not a later possibility.
- `harness serve --stdio`, the callback methods, and the process transport in the `NativeController`.
- Launching through the (generalized) launcher; crash and restart handling for the harness process. It's one per `Agent`, so a crash affects every native conversation, and the "interrupted" handling has to cover that.
- The execution port (A) is still worth having inside the harness. Standalone, it decides where `command` tools and MCP servers run when no host isolates the harness.

Two decisions before I write this into the specs:

1. **B (the whole harness as its own process) or A (only execution isolated)?**
2. **An own protocol, or ACP with extensions?**









# 


❯ One catch with isolation.                                                                                                                                                                       but the consumer can decide where to put it. they may want to isolate the agent, but keep the data... no but in this case, we do need the data to be in the same isolated environment as the    harness, as it uses that directly right? that could be ok, access to the harness data is no more risky than access to the agent itself, but how would the isolation work if we want to decide   the location? An alternative would be to, in that case, not set the harness location                                                                                                            in any case, the history is currently in acp-client, and also the policies and even tools. Most of whats valuable in the harness is in the present behavior and the server-like                 functionality.                                                                                                                                                                                  So, if we allow to easily inject state, and maybe periodically we can ask the harness for the actual data, memories, even context, etc, whatever. then we save that on the desired location,    as a backup. if the agent is not isolated we don't need to do that                                                                                                                                                                                                                                                                                                                              ???                                                                                                                                                                                                                                                                                                                                                                                             I like your suggestion on having the harness have its own session id, and using that as the internal_session_id. however, the actual conversation id... i didnt get your model for that










# timeline


## Do conversations have titles?

Yes, at creation: `agent.conversations.create({ title })`, and it's stored with the conversation. I didn't find a way to change it afterwards. A small `conversation.setTitle()` would cover that, and the harness then sees the new label.

## Item 4, explained with an example

The harness config says `send_email: "ask"`, so the agent must ask a human before sending an email.

**Case A: the user prompted.**
```
user (owner chat): "Email the client that the fix is live"
agent's turn → calls send_email → the gate says "ask"
```
The question has to reach the person who is chatting. Today acp-client does that through the prompt: the consumer passes `handlers.onPermissionRequest` with the prompt, and the library calls it ("the agent wants to send an email, allow?"). The consumer's interface shows it, and the user answers. **This works today** for ACP. For native, the question starts in the harness process, so the harness has to send it over to acp-client. That's one protocol message (`permission/request`), and acp-client then calls the same handler.

**Case B: nobody prompted.**
```
12:10 worker w1 finishes → the agent takes a turn on its own (item 1)
agent: "the fix is live; I'll email the client" → send_email → "ask"
```
There's no prompt, so there's no handler to call. Today acp-client would fall back to `defaultPermission`, which by default **refuses**. The email silently doesn't go out, and the user never even sees the question.

**My suggestion fixes case B:** the consumer gives each conversation a **standing handler** once, not per prompt:

```ts
conversation.onPermissionRequest(async (request) => askInMyUi(conversation.id, request));
```

- If the turn took a prompt that carried its own handler, use that one (case A, as today).
- Otherwise use the conversation's standing handler (case B).
- Otherwise use `defaultPermission`, as today.
- If nobody answers within the limit, refuse, so the turn doesn't hang forever.

## The timeline, restated in the current model

**What it is.** One append-only log per **session** (the entity). Every event has:
- `seq`, a single order across the whole session;
- `at`;
- `kind`;
- `channel`, where it happened;
- `from`, the sender: the participant, the agent, a worker;
- `scope`, the policy it happened under;
- `content`.

**Who writes it:**

| Source | What it appends |
| --- | --- |
| Native channels, automatically | incoming messages, the agent's replies, delegation facts, worker replies when taken, messages sent to other channels ("told"), shared-state writes, policy changes |
| acp-client, for ACP conversations | their messages, through the identity runtime's `update` |
| acp-client, for every conversation | its summaries when it checkpoints (the `checkpointed` hook). Native conversations are checkpointed by acp-client too, from its records |

**Positions.** Each channel has a position: the last `seq` its context has caught up to. ACP conversations have a position per provider session, since a new ACP session starts from nothing.

**Delivery into a native channel, each turn:**
1. Take the slice from the channel's position to now.
2. **Leave out the channel's own events,** which are already in its context.
3. Filter by the turn's policy. `memory.read: none` sees nothing from other channels; `own` sees only its own channel; `all` sees everything.
4. Digest it: acp-client's summaries where they cover a span, raw events (truncated) for the rest, under a size budget, newest last.
5. Append it as a `<since_last_turn>` block before the new message, and move the position to now. The block becomes part of the context, so it's never sent twice.

**Delivery into an ACP conversation:** the same slice and digest, returned by `load` as a preamble. The position moves only on `delivered`, at least once.

**Pulling more:** `timeline_since` and `timeline_search` for detail, and `state_read` for current facts and commitments, which are a projection of `state_write` events.

**Compaction.** When a native channel's context is compacted, its position is reset to "current state plus a digest", so nothing is lost or repeated.

**Isolated sessions:** the timeline is what acp-client copies, event by event.

## Is it coherent? What I checked, and two gaps

**What holds:**
- One process per session, and appends serialized by SQLite, give one order.
- Leaving out the channel's own events avoids duplicates.
- Advancing the position when the block is appended avoids repeats.
- Scope filtering is mechanical.
- Worker replies keep the policy of whoever gave the work.

**Gap 1: a standalone harness has no summaries.** Digests in v1 are stitched from acp-client's summaries. A standalone session would only have truncated raw events, which works for short histories and degrades for long ones. That's acceptable for v1, since acp-client is the host that matters. The real fix is the harness making its own digests, which is in phase 2.

**Gap 2: what "own" means for `memory.read`.** It's "this channel only", so a guest channel with `read: own` gets no cross-channel identity at all. That's intended, and it's how a guest gets no view into the owner's world. But it means a trusted agent's channel needs `read: all`, or a later "scoped" level, to benefit from the entity. That's a decision for the presets, not for the model.

If this matches what you had in mind, I'll write in item 4 (the standing handler, the protocol message, the timeout), `setTitle`, and the timeline restatement with its two gaps, and close item 5.


