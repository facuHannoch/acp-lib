# ACP Client Library — Multi-Agent (deferred)

Exploratory design for multi-agent capabilities built on top of the core `AcpClient`
(see `SPEC.md`). All of this is **deferred** — captured now because the ideas fall out
naturally from the core design, not because they're scheduled. Nothing here changes the
core primitive; it's all built *on top of* it.

The throughline: **the ACP client is self-similar.** A human and an agent drive it with
the same code, so "agents driving agents" is just the library calling itself.

---

## 1. Companion / observer agent

### The problem
An ACP session is busy during a turn (one prompt in flight, `_isBusy` mutex). While the
worker grinds on a long task, you can't ask it anything — the session won't accept
another prompt until the turn ends. It'd be valuable to answer questions about the
in-progress work, even if only questions.

### The reframe: work off the transcript, not the live session
The activity stream is already a complete, live transcript (thought chunks, tool calls,
outputs, partial response). A **second** agent can read everything the worker emits and
answer on its behalf — without ever touching the busy session.

```
worker session ──(onActivity / onChunk)──▶ transcript buffer ──▶ responder ──▶ answers
   (busy, 1 turn)        live stream            (shared substrate)   (free / read-only)
```

Read-only observer. No session contention, no permission complications, no risk to the
worker.

### Context scope
- The buffer is the **entire observed history since connect**, not just the live turn —
  so "I told it important things earlier" is covered.
- If *we* injected the system/context prompt at session start, the library knows it and
  can include it.
- The only **irreducible gap**: the provider's built-in hidden system prompt (never
  streamed) and anything that happened before we started observing (e.g. an unwitnessed
  resumed session). Rarely matters for meta-Q&A.

### Two flavors (identical context plumbing — both are *fed* the buffer)
- **(a) SML single call** — a small local model (Ollama-style) answers "what's it doing
  / did it touch X / how far along." Cheap, near-free, runs while the worker works. The
  right *first* version.
- **(b) Full second session** — a fresh session of the same provider (same provider to
  avoid auth/complexity), seeded with the transcript, for richer "why did it choose
  this" reasoning. Costs a real turn. **Same context** as the SML — see §3, sessions
  don't share memory; you always feed.

### Quality is bounded by provider chattiness
The responder only knows what's in the stream. Providers that stream thoughts (Kimi)
give a rich observer; providers that don't (GPT/Codex — only `thoughtTokens` in usage)
let the observer narrate the *what* (tool calls, outputs) but not the *why*.

### Read-only vs controller — the line
- **Answer questions about the work** (read-only observer) — tractable, safe, emergent
  from the audit trail. This is the scoped first version.
- **Actually contribute / change course** ("also, do X") — different problem; the
  responder becomes a controller. See §2.

---

## 2. Communication seams ("also, do X")

There is **no push channel into a running turn.** An ACP turn is atomic from the
client's side: send prompt → agent works → turn ends. Two agents can never talk directly
while one is working. All communication routes through the orchestrator (the library) and
only at specific seams.

From least to most disruptive:

1. **Turn-boundary queue (native, easy).** The worker is busy, so "also do X" is
   enqueued and sent as the next prompt when the current turn ends. Just the core
   queuing. Latency = remaining turn time. No cooperation, no work lost. Default answer.

2. **Mailbox via MCP (live-ish, needs cooperation).** Expose a tool like `check_inbox`
   (an MCP server you control). Messages are dropped in it; the worker, if its system
   prompt tells it to, **pulls** the inbox between tool calls and picks up "also do X"
   mid-task. The catch: **pull, not push** — you can't force a check; timing is the
   model's choice. Closest thing to real-time injection, degrades gracefully (worst case
   read at end of turn), and keeps the message inside the worker's own reasoning.

3. **Interrupt + re-prompt (disruptive).** `interrupt()` the worker, re-prompt with
   "original task + also X + transcript so far." Loses the in-flight turn (keep partial).
   Only when X can't wait.

---

## 3. Peer communication (both idle)

Even with both agents idle, there is **no native peer channel** — an ACP agent only ever
talks to *its client*. It has no concept of "another agent." So communication is always
mediated. Mediation splits into two genuinely different models:

### Relay loop (orchestrator-driven)
The library takes A's output and sends it as B's prompt, takes B's reply back to A, and
loops. The agents don't know they're talking to each other — each just sees prompts from
"the user." The orchestrator decides every handoff. Simple, fully controlled, but agents
are **passive responders** — they can't initiate contact, only respond when fed.

### MCP bridge (agent-driven) — the real "they talk to each other"
Expose agent B to agent A **as an MCP tool**. When A wants to consult B, it calls the
tool (e.g. `ask_agent_b`); the bridge — an MCP server you control — receives the call,
prompts B, waits, and returns B's response as the tool result. From A's perspective,
**B is just a tool.** Can be bidirectional (A is also a tool to B).

Crucially this happens **within A's turn** — A doesn't finish and hand off; it consults B
mid-reasoning like any other tool call, gets an answer, and continues. Agent-*initiated*,
not orchestrator-scheduled. The orchestrator builds the bridge once; after that the
agents drive the conversation themselves.

Composes with the core: the bridge is an MCP server, MCP servers are passed at
`connect()`, transport support is discoverable via `capabilities.agent.mcpCapabilities`.

---

## 4. The recursion: agent-as-tool = library calling itself

An agent **cannot emit ACP bytes** — its only output channels are **text and tool
calls**. So "agent talks to agent via ACP" always means: the agent makes a *tool call*,
and **the tool is an ACP client.** The translation boundary is mandatory and always a
tool.

The payoff: **that ACP client is this library.** The bridge/tool isn't separate
machinery — it's `AcpClient` wrapped as a tool and handed to the agent. When agent A
calls `talk_to_agent(b, "...")`, the tool implementation runs an `AcpClient` to talk to
B — the same `AcpClient` a human uses. The agent is *transitively* an ACP client through
the library.

So the library is the **reusable unit used at every level**:

```
human   ──uses AcpClient──▶                       agent A
agent A ──calls tool── (tool uses AcpClient) ──▶  agent B
agent B ──calls tool── (tool uses AcpClient) ──▶  agent C
```

Same code at every hop. A human driving an agent and an agent driving an agent are the
**identical primitive** — the only difference is whether the caller is a person or a
tool-call. To the library, a caller is a caller. That is what makes orchestration
composable and recursive.

### Consequences
- **The tool holds the session, not the agent.** The agent just emits
  `talk_to_agent(id, msg)`. The tool wrapper keeps a map of `AcpClient` instances keyed
  by agent id, each with its own session/transcript. The agent has no session state of
  its own — the tool layer is the ACP client and owns it.
- **This is why the library must stay clean and embeddable.** No git-dir crawling,
  explicit config, one self-contained `AcpClient`, no hidden global state — exactly what
  lets it be instantiated *inside a tool, inside an agent, inside another agent.* A
  library that assumed it was the top-level app couldn't recurse. This one can.

### Guardrails (deferred)
Recursion means depth, cost, and loop risk (A→B→A→…). The orchestrator needs depth
limits / cycle detection — a guardrail layered on top, not a change to the primitive.

---

## Summary

- **Observer** is emergent from the audit trail: read the transcript, not the session;
  SML first, second-session as a quality upgrade.
- **Communication** has no mid-turn push: queue at turn boundary, MCP mailbox for
  live-ish pull, interrupt as last resort.
- **Peer comms** is always mediated: relay loop (passive) or MCP bridge (agent-driven,
  the real one).
- **Recursion** is the foundation: agent-as-tool means the library calls itself; humans
  and agents drive the same primitive. Keeping `AcpClient` clean and embeddable is what
  makes the whole orchestration layer possible.
