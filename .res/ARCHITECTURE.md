This is a library that allows to talk to an agent via ACP. This is the normal mode. If this mode is not available, then it also provides a "degraded" mode.


sessionsDir
sessionId

provider-agnostic


What methods should this lib expose:

- Prompt

Should we hide the session creation / loading, etc?
I think we should, 

Do we need state?



Let's start from the most simple.
I start a connection to the acp, so I want to send a prompt.
Like "hello".
This requires
1. `initialize` -> initialize ACP connection
2. `session/new` -> start new session
3. `session/prompt` -> send prompt
But the user could be authenticated, or not. Authentication state is fully opaque until something breaks.
4. `end_turn` / error -> user is not authenticated (pressumably). If no error, suggest user to authenticate.
5. `authenticate`. Some implementations do not accept auth via acp. 
6. `session/prompt` -> send prompt

We could store the credentials, but certain implementations simply end the turn if it is not logged. This is not mature, so this workaround is the safest option we have.

Now, where do we store the sessionId?
Should the library keep a state of it? Maybe, but maybe not storing it.
It could store the sessions in `SESSIONS_DIR`. But, this should be something that can be overrided by the client.

So like
```
ACPClient:
    sessionId: string
    sessionsDir: string
```

So, I want to chat with an AI.
Then, how?
Do I start it like ACPClient.prompt()? which could return an ACPConnection
Or do I manually manage it?
```
const client = new AcpClient({
    adapter: ADAPTERS.kimi,
    sessionsDir: "/path/to/sessions",  // optional
    sessionId: sessionId
})
```

```js
const ADAPTERS = {
  kimi:   { command: ["kimi", "acp"] },
  claude: { command: ["claude-agent-acp"] },
  codex:  { command: ["codex-acp"] },
}

const client = new AcpClient({
  adapter: ADAPTERS.kimi,
  sessionId: "abc-123",
})

const client = new AcpClient({ adapter: ADAPTERS.kimi })
await client.connect()  // spawn + initialize + session/new

client.capabilities.authMethods  // available now, before any prompt
await client.prompt("hello")

client.capabilities.authMethods  // discovered from initialize
client.capabilities.loadSession  // discovered from initialize
client.capabilities.fs           // discovered from initialize
```


the structure from the protocol itself is already the right shape. Just reflect it directly:

```ts
client.capabilities.agent.loadSession
client.capabilities.agent.promptCapabilities.image
client.capabilities.agent.promptCapabilities.audio
client.capabilities.agent.mcpCapabilities.http
client.capabilities.agent.auth.logout
client.capabilities.agent.sessionCapabilities.delete
client.capabilities.agent.sessionCapabilities.additionalDirectories

client.capabilities.client.fs.readTextFile
client.capabilities.client.fs.writeTextFile
client.capabilities.client.terminal
```

Don't flatten it — the protocol's nested structure maps directly to what UIs need to check. `client.capabilities.agent.auth.logout != null` → show logout button. No translation needed.


If no session is provided, we start a 

??   The library doesn't maintain the list — it just reads mtime from whatever files are in sessionsDir at startup. Source of truth stays with the




`prompt()` returns the result and the caller decides what it means:

```ts
const result = await client.prompt("hello", {
    onChunk: (text) => ...,
    onActivity: (event) => ...  // thinking, tool calls, etc.
    onPermissionRequest: (request) => {
        // caller decides
        return { outcome: "selected", optionId: "approve" }
    }
})

result.text        // the response
result.stopReason  // "end_turn", "max_tokens", etc.
result.usage       // token counts
```

If `text` is empty and `stopReason` is `"end_turn"` — probably not authenticated. The library doesn't interpret that, just surfaces it. The caller acts on it.


Streaming chunks — agent_message_chunk events that arrive while the prompt is in flight. These are partial text, delivered via a callback:
Activity events — agent_thought_chunk, tool_call, tool_call_update, plan — separate from the text stream, also via callback:




Yes — store the raw config options from `session/list_config_options` as a map keyed by `configId`:

```ts
interface ConfigOption {
  configId: string
  label?: string
  description?: string
  currentValue: unknown
  allowedValues?: Array<{ value: unknown; label?: string; description?: string }>
}

// on the client after connect():
client.configOptions  // Map<string, ConfigOption>
```

So the caller can:

```ts
// inspect what's available
client.configOptions.get("reasoning_effort")
// { configId, label, currentValue: "medium", allowedValues: ["low","medium","high","xhigh"] }

// list everything for a settings UI
for (const opt of client.configOptions.values()) { ... }

// set one
await client.setConfig("reasoning_effort", "high")
```

The library never hardcodes model names or option values — it just reflects whatever the agent reports. Different providers, different options, all handled the same way.


Exactly. The adapter owns its command, the client owns the prefix:
```js
new AcpClient({
    adapter: ADAPTERS.kimi,           // command: ["kimi", "acp"]
    execPrefix: ["docker", "exec", "-i", "container-name"],
    env: { ... },
    cwd: "/workspace",
})
```
The library merges them at spawn time: [...execPrefix, ...adapter.command]. The adapter doesn't know or care how it's being executed.



### Auth

Auth methods come from `capabilities.authMethods` after `connect()`. Each has a `kind`:

- `api_key` — library calls `authenticate` with the key
- `terminal_command` — library tells the caller what command to run, can't do it itself
- `tty` — requires interactive terminal, completely outside the library's control

So:

```ts
client.capabilities.authMethods
// [
//   { id: "api_key", kind: "api_key", label: "API key", envVar: "MOONSHOT_API_KEY" },
//   { id: "login",   kind: "terminal_command", label: "Browser login", command: ["kimi", "login"] },
//   { id: "tty",     kind: "tty", label: "Interactive login" }
// ]
```

The library can only act on `api_key`:

```ts
await client.authenticate({ methodId: "api_key", value: "sk-..." })
```

For `terminal_command` and `tty`, it surfaces the info and the caller figures it out. The library could have a helper:

```ts
client.capabilities.canAuthProgrammatically  // true only if api_key method exists
```

For Kimi's case — where `authenticate` via ACP returns `{}` and does nothing — there's no fix. The library surfaces that auth is available but the caller discovers it doesn't work. Nothing the library can do about broken implementations.



You're right. `terminal_command` is runnable — the library spawns it and streams the output back to the caller:

```ts
await client.authenticate({
  methodId: "device_code",
  onOutput: (line) => console.log(line)  // "Visit this URL: https://..."
})
```

The library spawns `codex login --device-auth`, pipes stdout/stderr through `onOutput`, waits for exit. The caller displays the output in whatever UI they have.

The only one the library truly can't handle is `tty` — that needs stdin attached to a real terminal, which a library process can't provide. Everything else is runnable.


### Session management

session/list should be a function with no object associated ??? same with session/delete

session/load and session/resume...

how does it manages sessions
How does it know if it failed to load a session, or if this is a new session.

Maybe, if there is a file corresponding to the session, it tries to load it
load it or resume it??? -> maybe offer both?

Then, it can send a notification or something like "session could not be resumed". Starting a new session. This for prompt().
But we should also offer the possibility to just resume a session from the list

What is "a file corresponding to the session"? How do we name the files?




**Session files** — named by sessionId, stored in `sessionsDir`:
```
sessions/
  94b5204d-7dd9-4df2-977e-cbccc99c8218.json
  a1b2c3d4-...json
```

Each file contains enough to identify and sort it:
```ts
{ sessionId, adapter: "kimi", createdAt, lastUsedAt }
```

**`session/list` and `session/delete`** — no live connection needed, just filesystem operations. Standalone functions:
```ts
listSessions(sessionsDir)   // reads directory, returns metadata[]
deleteSession(sessionsDir, sessionId)  // deletes the file
```

**Loading vs new** — `connect()` accepts an optional `sessionId`. If provided, tries `session/load`. If that fails, falls back to `session/new`. The result tells the caller what happened:

```ts
const { resumed, sessionId } = await client.connect({ sessionId: "94b5204d..." })
// resumed: false → load failed, new session started
// resumed: true  → successfully resumed
```

The library saves/updates the session file automatically on `connect()`.

**Offering both load and new explicitly** — caller can force a fresh session by simply not passing a `sessionId`.



### Interrupting / canceling

By default, messages get queued. But we need a way to distinguish queued messages from those already delivered. Maybe we should have a type in the PromptResult or whatever we call it. But this type would change (reacting to that is concern of the client anyway). This type would also allow later to mark it as error, not delivered, etc.
messages can be canceled, maybe by calling client.interrupt() ? this should make await client.prompt() return? Then the client would define how to cancel, be it by calling a slash command or by doing something like `<ESC>`


The result needs a status field to carry this:

```ts
interface PromptResult {
  text: string        // partial text accumulated before cancel
  stopReason: string  // "end_turn" | "cancelled" | "max_tokens" | ...
  status: "completed" | "cancelled" | "error"
  usage: Usage | null
}
```

`client.interrupt()` cancels the in-flight prompt and `prompt()` resolves (not rejects) with `status: "cancelled"` and whatever partial text came in before the interrupt. The caller decides what to do with it.

How the interrupt actually reaches the agent is provider-specific — the library tries in order:
1. ACP `session/cancel` if it exists
xxx 2. A slash command like `/stop`  
xxx 3. Kill + restart the process as last resort

For queuing — `prompt()` calls queue up and run in order. `interrupt()` cancels the current one. Whether it also clears the queue is a caller decision, so maybe:

```ts
client.interrupt()           // cancel current only
client.interrupt({ clearQueue: true })  // cancel current + drop queued
```


### Things

Right on all three:

**MCP servers** → `connect()`, since that's where `session/new` happens:
```ts
await client.connect({ mcpServers: [...] })
```

**Working directory** (the agent's workspace) → `AcpClient(...)`, same level as `sessionsDir`, it's a fixed property of this client instance:
```ts
new AcpClient({ adapter: ADAPTERS.kimi, cwd: "/workspace", sessionsDir: "..." })
```

**Environment variables** → spawn time, never touches the protocol. Goes in `AcpClient(...)` too since it's part of how the process is launched:
```ts
new AcpClient({ adapter: ADAPTERS.kimi, env: { ANTHROPIC_API_KEY: "sk-..." } })
```

So `AcpClient` constructor holds everything about *how to spawn and configure the process*. `connect()` holds everything about *this particular session*.




### Crashes

If the process dies mid-prompt, the library has two options:

**Surface the error** — `prompt()` rejects with something like `ProcessCrashError`. The caller decides whether to reconnect and retry. Simple, predictable.

**Auto-restart** — the library respawns, re-initializes, tries `session/load` to resume, then retries the prompt. Transparent to the caller but hides what happened.

I'd lean toward surfacing the error but making reconnect easy:

```ts
try {
  const result = await client.prompt("hello")
} catch (err) {
  if (err instanceof ProcessCrashError) {
    await client.reconnect()  // respawn + initialize + session/load
    const result = await client.prompt("hello")  // caller retries
  }
}
```

The caller stays in control — they decide whether to retry, show an error, or give up. Auto-restart hides crashes that might be symptoms of something real (bad auth, OOM, misconfiguration).




### degraded mode

if the chat cannot be used for any reason, then we have a degraded mode.

This consists in using the native ai agent tool of the specific ai provider (like claude code, codex, etc), within an PTY. The main problem with this approach is the parsing.
The proposed solution is using an LLM. They are notorously good a parsing input.
Note that the LLM would not be actually interpreting the data or even summarizing. It would just be parsing it.
This means that very small models (SMLs) can be used. This models can even run on local hardware. Libraries like ollama make it very easy to run models in local hardware.
In other words
The degraded mode is an alternative, fallback mode to the normal ACP connection. It uses the native ai agent tool within a PTY subprocess as if it were a human, and it parses the input with a SML running in local hardware.
```
ACP-like ↔ PTY ↔ Interactive CLI
```

Considerations:
- the app must run in full-access mode, to avoid prompts
- as the name implies, this mode implies an inferior experience, with possible problems


### isBusy

We need a way to determine if the agent is working, or waiting, or something.
So, there are certain things we can suppose:
```
Opened ACP ->  opened:  true
after session/new ->  inSession: true
after session/prompt -> working: true | idle: false 
if session/request_permission -> waiting_approval: true | working: false | idle: false
after session/close -> inSession: false
```
Maybe states
- working
- idle
- waiting

But what if the connection dies? 


resolvePath -> do like acpx ?


There is a thing... I want to support doubleSingleAgents. So like two agents that act as the same. Suppose an agent is working on something... then I could talk to it, and it would responds as if it were the same agent. This means we need a sort of routing system, and keeping up with two different sessions. It should be the same acp implementation to avoid login issues, etc.




Nice idea, and it falls out cleanly from something we already have: the **activity stream is a complete, live transcript**. The worker session is busy (one turn at a time, `_isBusy` mutex), so you can't ask *it* anything mid-turn. But nothing stops a *second* agent from reading everything the worker is emitting and answering on its behalf.

The key reframe: **the responder works off the transcript, not the live session.** It never touches the busy session. It subscribes to `onActivity` + `onChunk`, accumulates the running transcript (thought chunks, tool calls, outputs, partial response), and answers questions against *that*. Read-only observer. No session contention, no permission complications, no risk to the worker.

```
worker session ──(onActivity / onChunk)──▶ transcript buffer ──▶ responder ──▶ answers
   (busy, 1 turn)        live stream            (shared substrate)   (free)
```

Two flavors, and they map onto pieces already in the spec:

**(a) Cheap meta-Q&A — the SML.** The same local small model from degraded mode watches the stream and answers "what's it doing right now?", "did it touch the auth file yet?", "how far along?". These are questions *about the stream*, not about the domain — exactly what a tiny local model is good at. Near-free, runs while the worker grinds.

**(b) Rich Q&A — a second session of the same provider, seeded with the transcript.** When you want real reasoning ("why did it choose that approach?"), spin a fresh session, inject the transcript as context, ask. Costs a real turn but gives a real answer. This is a *new* session — it does not and cannot share the worker's internal state beyond what was streamed.

The sharp line to draw — and I think it's where you'd defer:

- **"Answer questions about the work"** (read-only observer) — tractable, safe, and you have all the substrate today. This is what you described ("even if just for answering questions").
- **"Actually contribute / change the worker's course"** — fundamentally different. That requires `interrupt()`-ing the worker and re-prompting, because you can't inject into a turn in flight. Much harder, and it makes the responder a controller, not an observer.

Scoping to the read-only flavor is the right call — it's almost an emergent feature of the audit trail rather than new machinery.

One honest limitation: the responder only knows what's *in the stream*. If the worker reasoned silently (e.g. Codex, which doesn't stream thoughts — only reports `thoughtTokens`), the responder is blind to the *why* and can only narrate the *what* (tool calls, outputs). For Kimi (streams thoughts) it'd be much richer. So the quality of the double-agent is bounded by how chatty the worker's provider is — which ties straight back to the per-provider thought-streaming difference we found.

Want me to add this as a **deferred "Companion / observer agent"** section in the spec — capturing the transcript-not-session reframe, the two flavors, the read-only vs controller line, and the provider-chattiness bound?






❯ So... using the SML is not a bad idea actually. And you are suggesting just a single call to the SML passing it the context from the current task...  I didnt really thought of that, I went with the more complex idea of having two different sessions (with the same provider for avoiding auth and other complexities), and there would be a routing system inside.  To the user there would only be one sessionId, but the routing... altough I'm not sure if there is a need for a routing system


A couple of things to untangle here, because I think one of them dissolves part of the problem.

**"Only the current task" was me under-scoping, not a real limit.** The library is observing *continuously* — it doesn't have to buffer just the live turn. It can accumulate the **entire observed history since connect**: every turn, every tool call, every response. So "I told it important things earlier" is covered — that's all in the buffer. The responder reads the whole transcript, not just the turn in flight.

**The irreducible gap is narrower than it looks.** What you genuinely *can't* recover is:
- the provider's **built-in hidden system prompt** (never streamed, never exposed)
- anything that happened **before you started observing** (e.g. a resumed session whose earlier turns you didn't witness)

But note: if *you* injected the system prompt / important context at session start (the way the reference lib injects a session prompt), then **the library already knows it** and can include it in the responder's context. So the only true blind spot is the provider's *own* internal prompt — which almost never matters for meta-questions. That mostly removes your concern.

**Now the part that should actually deflate the complex design:** two sessions of the same provider **do not share memory.** Sessions are independent. A second session has its own (provider-default) system prompt and an *empty* history — you'd *still* have to feed it the transcript exactly like the SML. (Loading the same `sessionId` into a second connection concurrently is not safe — concurrent access to one session, providers don't guarantee it, state can corrupt. Don't.)

So the second-session approach gives you **better reasoning quality, not better context access.** Both approaches are fed the same buffer. That reframes the choice:

- **SML single call** → cheap, local, near-free, great for "what's it doing / did it touch X / how far along."
- **Full second session** → real reasoning for "why did it choose this," but a real turn's cost — and *same* context as the SML.

**On routing — you don't need a system, you need one rule.** The single-`sessionId` facade is just:

```
incoming message → worker busy ? responder : worker
```

That's it. There's no routing engine to build until you have a reason. The user sees one session; internally it's "busy → divert to responder." Keep it that thin.

One consistency cost to bank for later: answers from the responder happen **outside** the worker's history, so the worker never learns the question was asked. Fine for meta-Q&A. The moment you want "also, do X" to actually land, you're back in controller territory (interrupt + re-prompt), which we deferred.

So my honest read: the SML single-call is the right *first* version, the second-session is a quality upgrade with identical context plumbing, and "routing" is a one-liner. Want this written up as the deferred **Companion / observer agent** section with this framing — continuous-buffer scope, the narrowed gap, "two sessions don't share memory," and routing-as-one-rule?




Even with both idle, there's no native peer channel — an ACP agent only ever talks to **its client**. It has no concept of "another agent." So communication is *always* mediated by the orchestrator. But "mediated" splits into two genuinely different models, and the second one is probably what you're reaching for:

**1. Relay loop (orchestrator-driven).** Both idle. The library takes A's output and sends it as B's prompt, takes B's reply and sends it back to A, and loops. The agents don't know they're talking to each other — each just sees prompts from "the user." The orchestrator decides every handoff. Simple, fully controlled, but the agents are passive — they can't *initiate* contact, they just respond when fed.

**2. MCP bridge (agent-driven) — this is the real "they talk to each other."** Expose agent B to agent A **as an MCP tool**. When A wants to consult B, it calls the tool (say `ask_agent_b`); the bridge — an MCP server you control — receives the call, prompts B, waits for B's response, and returns it as the tool result. From A's perspective, **B is just a tool.** And you can make it bidirectional: A is also a tool to B.

The important realization: this happens **within A's turn.** A doesn't finish and hand off — it calls B mid-reasoning, gets an answer, and keeps going, exactly like calling any other tool. That's as close to "two agents conversing" as the protocol allows, and it's agent-*initiated*, not orchestrator-scheduled. The orchestrator only builds the bridge once; after that the agents drive the conversation themselves.

So the honest hierarchy:

- **No direct socket** between agents, ever. An agent speaks only to its client.
- **Relay loop** = orchestrator is the conductor; agents are passive responders.
- **MCP bridge** = "agent as a tool"; agents initiate, consult each other mid-turn, conversation is self-driving. This is the foundation for real multi-agent work — sub-agents, delegation, A asking B for a second opinion without you scripting it.

And it composes with everything else: the bridge is an MCP server, MCP servers are passed at `connect()`, transport support is discoverable via `capabilities.agent.mcpCapabilities`. The "agent as a tool" pattern is exactly what turns your single-agent client into the orchestration library you actually want.

This is the piece worth capturing carefully. Want me to write up a deferred **Multi-agent** section covering: the observer/companion agent, the communication seams (no mid-turn push, turn-boundary queue, MCP mailbox), and these two peer models (relay loop vs MCP bridge / agent-as-tool)?




Exactly — and that's the whole thing clicking into place.

An agent can't emit ACP bytes itself. Its only output channels are **text and tool calls** — it has no way to speak JSON-RPC directly. So "an agent talks to another agent via ACP" always means: the agent makes a *tool call*, and **the tool is an ACP client.** The translation boundary is mandatory and it's always a tool.

But here's the payoff: **that ACP client is your library.** The bridge/tool I described isn't some separate machinery — it's *your library, wrapped as a tool and handed to the agent.* When agent A calls `talk_to_agent(b, "...")`, the tool implementation is running an `AcpClient` instance to talk to B — the same `AcpClient` you use as a human. The agent is *transitively* an ACP client, through your library.

So the library is the **reusable unit used at every level**:

```
human ──uses AcpClient──▶ agent A
agent A ──calls tool── (tool uses AcpClient) ──▶ agent B
agent B ──calls tool── (tool uses AcpClient) ──▶ agent C
```

Same code at every hop. A human driving an agent and an agent driving an agent are *the identical primitive* — the only difference is whether the caller is a person or a tool-call. That's what makes the orchestration composable and recursive: an agent can spawn and converse with sub-agents using the exact client you built, because to the library a caller is a caller.

Two concrete consequences:

- **The tool holds the session, not the agent.** The agent just emits `talk_to_agent(id, msg)`. The tool wrapper keeps a map of `AcpClient` instances keyed by agent id, each with its own session/transcript. The agent has no session state of its own to manage — the tool layer is the ACP client and owns it.
- **This is why the library must stay clean and embeddable.** Everything we've insisted on — no git-dir crawling, explicit config, one self-contained `AcpClient`, no hidden global state — is exactly what lets it be instantiated *inside a tool, inside an agent, inside another agent.* A library that assumed it was the top-level app couldn't recurse. Yours can.

The one caution to bank for later: recursion means depth, cost, and loop risk (A→B→A→...). The orchestrator needs depth limits / cycle detection — but that's a guardrail on top, not a change to the primitive.

This is the real foundation of your orchestration library: **the ACP client is self-similar — humans and agents drive it with the same code, so agents driving agents is just the library calling itself.** Want me to capture the whole multi-agent picture now — observer/companion, the communication seams, relay-vs-MCP-bridge, and this "agent-as-tool = library calling itself" recursion — as the deferred section in the spec?

