theres a thing that I would like to work on, not necessarily now, but that could shape thedesign:
So currently we have, if im not mistaken, two controllers:
- acp
- degraded 

is this so ? 

degraded is not deprecated but is not really usable as of now, and would need work to be usable. There was not need for it though so that keeps deferred.
But theres a motivation for a different kind of controller. One that is not driven by a harness, but by simple model calls.
Because while the main motivation of the library was to drive a harness programmatically, the conversation and the agent overall now have a sense of identity.
So what im thinking is a controller that uses no harness whatsoever, and is just a chatbot. This is useful because:
- is much cheaper, quick and flexible when it has to only work as a chatbot
- it would allow for untrusted users to talk to the agent.
- is scalable. 10 conversations with teha cp controller mean 10 harnesses, maybe like 4 GB ram. In contrast, 1k conversations of this kind would have the load of a very small node server

It does mean that the agent can no longer make actions and read files, and the login would ahve to (I think) necessarily be via api key. Thats the tradeoff. It also may require to actually built the outer harness layer intended, so this controller could make actions or do things.







Yes, there are two today. `AgentController` drives one leaf at a time:
- **`normal`:** `AcpClient`, which drives the harness over ACP.
- **`degraded`:** `PtyClient` in `src/degraded/`, which drives the harness's terminal UI.

Both implement the same small `AgentClient` contract: `prompt`, `interrupt`, `stop`. The conversation layer uses much more than that, though: `startFresh`, `load`, config options, available commands, usage updates, list and delete. So the real seam is wider and ACP-shaped.

## What a model-call controller changes
The trade-offs you list are right. Underneath, it flips one thing: **who owns the conversation's context.**

- **With a harness,** the provider holds the history and we mirror it. `session/load`, adoption and recovery exist because the harness is the source of truth.
- **With model calls,** the library is the source of truth. Every prompt builds the message list from stored records (or memory) and sends it. As a result:
  - `load` just rebuilds from records, and recovery is trivial. Adoption doesn't apply.
  - **Context-window management becomes the library's job.** The checkpoint floor already gives the shape: send the checkpoint summary plus the messages after it. Checkpoints stop being only a recovery artifact and become the compaction mechanism.
  - Metering becomes exact per call, which is the per-turn reading, with no cumulative counters to interpret.
  - Steering gets simpler. With no tools there are no tool boundaries, so a steer can abort the stream and re-request with the new message, or wait for the turn to end.

## Where it connects to what we have
1. **Internal inference could use it.** Checkpoints and recovery seeds are single prompt-and-answer calls. A model-call runtime would avoid spawning a harness per checkpoint, which fixes the cost and the OpenCode title-request problem at once. It may be the first practical use, even before chat.
2. **Step 1, the reliability design.** It argues for putting the lifecycle guarantees above the controller: states, `silent since`, bounded cancel, abandoned. Each controller then only supplies two primitives:
   - **cancel:** `session/cancel` for ACP, or aborting the fetch for model calls;
   - **force-stop:** killing the process for ACP, or dropping the connection for model calls.

   Your "behave like an HTTP request" is literal for the model-call controller, so the same contract should fit both.
3. **Requirements #6–#8 (parts and media).** The `parts` model should be the library's own, not ACP content blocks, because a model-call controller has to map parts to each API's content format.
4. **Untrusted users and identity.** The risk isn't only tools. An untrusted user's conversation feeds the shared memory that other, trusted conversations read, which opens a route for prompt injection. So per-conversation control over contributing to identity, and receiving it, becomes necessary rather than parked. That's the parked `identity: false` TODO.
5. **API-key auth.** It's also where your inference gateway would plug in. An OpenAI- or Anthropic-compatible endpoint is probably the first target.

## Cost
`agent-session.ts` is about 4,500 lines and built around the ACP leaf. A third controller means extracting a real provider-session interface first. That's a sizeable refactor, but it's the same refactor that makes the lifecycle guarantees controller-independent.

## What I'd do now
Not build it. Let it shape two things:
- **Step 1:** design the lifecycle contract above the controller, with cancel and force-stop as controller primitives.
- **Requirements #6–#8:** keep `parts` in library terms.

I'd also write a short design note now, so the idea isn't lost: the context-ownership flip, compaction via checkpoints, internal inference as the first user, and identity for untrusted conversations.

Do you want that note, and should I check what `interrupt()` does today when a harness ignores cancel? That's the piece we need for step 1.





Yes, the refactor is the prerequisite, and it fits best after the current work, not before.

**Why it's needed.** The nominal contract is small: `prompt`, `interrupt`, `stop`. But `agent-session.ts` uses about 20 `AgentController` members, all shaped around ACP. The heaviest are `configOptions` (27 uses), `isDegraded` (8), `start` (6) and `setConfig` (5), plus load with replay, list and delete. A third controller needs that surface pulled out into an interface the conversation layer depends on. ACP and PTY would be two implementations, with ACP-only features like load, list, delete, modes and commands as optional capabilities.

**Why after.** The step 1 work naturally builds the first slice of that interface. If the never-invisible, never-stuck guarantees sit above the controller, each controller only supplies two primitives: `cancel` and `forceStop`. Doing step 1 that way gives a small, real piece of the seam without committing to the whole extraction early.

The order in the note:
1. **Operation lifecycle guarantees**, above the controller.
2. **The 10-13 requirements**, keeping `parts` in the library's own terms.
3. **The provider-session interface extraction.**
4. **A model-call runtime for internal inference.** It's the first real user: no process per checkpoint, and no harness background work.
5. **The model-call chat controller.** Then identity controls for untrusted conversations, then tools.

The note is at `.res/somelogs.md/9-22+/10-17-NOTE-model-call-controller.md` and isn't committed yet. It also covers the context-ownership flip (the library becomes the source of truth and checkpoints become compaction) and the identity risk for untrusted users.

The stall measurement is still running in the background. Meanwhile I can check what `interrupt()` does today when a harness ignores `session/cancel`, which is the fact step 1 hinges on.


