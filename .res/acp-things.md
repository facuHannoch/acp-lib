## Session setup

**`session/load` vs `session/resume`**
Both reconnect to an existing session. The difference is what happens before you can send prompts again:
- `load` — agent replays the entire conversation history to you as `session/update` notifications, then responds. You get all the messages back so your UI can reconstruct the chat.
- `resume` — agent just restores internal context and responds immediately. No history replay. You're reconnected but your UI has no messages — you'd have to store them yourself client-side.

So: `load` = agent holds the history and gives it back. `resume` = agent holds context only, you hold history yourself.

**`session/close`**
The session still exists in history — you can `load` it later. Close just means "stop whatever is running right now and free the active resources." Think of it like closing a terminal tab — the project isn't deleted, just the running process.

**Where does the session ID get stored?**
The agent stores it. The agent is a persistent process (or has persistent storage) — it keeps sessions around. You just hold onto the `sessionId` string on your side. When you reconnect (new process, new connection), you pass that ID back and the agent looks it up.

This is also why `session/delete` exists separately — that's "remove it from the agent's storage entirely."

Want me to append `session/new` (minimal, and with MCP) to the file?

No — `session/close` doesn't kill the agent process, it just frees the active in-memory resources for that session. The agent process keeps running, and the session ID is still stored persistently by the agent.

What kills the agent process is literally killing the subprocess (SIGTERM, closing stdin, etc.). Even then, a well-implemented agent would have persisted the session to disk before dying, so you can reconnect later with the same session ID.

The lifecycle is:

- **`session/close`** — session still exists, agent still running, just cleaned up active resources
- **`session/delete`** — session removed from agent's storage permanently
- **kill the process** — agent dies, but session data may survive on disk depending on implementation