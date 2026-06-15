Two genuinely big wins buried in there, and one sharp design problem. Let me take them in order.

## The wins
- **kimi worked** — the CLI you historically couldn't get going. And the path that fixed it is exactly the tty-auth story we built for: *it silently failed (no error, empty turns) → you `/bridge`d in → logged in inside kimi's real TUI → came back → it works.* That's the whole reason the bridge exists, validated on the hardest case.
- **The unification you spotted**: bridged interactive sessions and ACP sessions are the *same storage*. Drive the native TUI, then pick it up programmatically. That really does tie the modes together.

## What I meant by #1 (`loginCommand`)
You just did the manual version of it: to log into kimi you bridged the **chat** TUI (`kimi`) and happened to log in from there. `loginCommand` would just be an adapter field for the *dedicated* login command (`kimi login`, `codex login`), so `/login` in degraded mode bridges **that** directly instead of you bridging the chat UI and finding the login flow yourself. Since bridging-the-chat-UI-and-logging-in already works, it's a convenience, not essential. So I'd now rank it **below** the command problem.

## The real problem: three command namespaces colliding
You've named it exactly. There are three sources:
1. **Consumer commands** — the hub's, via the `onSlashCommand` callback (the seam exists).
2. **acp-lib native** — `/sessions`, `/load`, `/bridge`, `/login`, …
3. **Agent commands** — kimi's `/sessions`, codex's `/d`/`/model`, claude's `/resume`, …

Current routing: a `/foo` line hits our handler; if we know it, **we win**; if not, it **falls through** to the agent as a prompt. So `/model` reaches codex (we don't define it), but `/sessions` is *shadowed* — ours runs, kimi's is unreachable. That's the mess.

The minimal fix that cleanly resolves it: **a verbatim agent-passthrough prefix, `//`.**
- `/sessions` → our session list (unchanged).
- `//sessions` → sends literal `/sessions` to the **agent** (kimi's), bypassing us.
- `/model`, `/d` → still work via plain `/` fall-through (no conflict).
- Plain text → prompt.

One extra mechanic (`//`), everything else stays, and every conflict becomes reachable. Then two polish layers on top:
- **Surface agent commands** in `/help`: in *normal* (ACP) mode the agent advertises its commands (`available_commands` in `session/update`) — we can list them under an "agent:" section so you know what `//` can reach. (Degraded can't introspect, but `//` still forwards.)
- **Later refactor**: split *native* command handling out of the CLI's `onSlashCommand` so the hub inherits native commands for free and only *adds* its own — making the precedence consumer → native → agent explicit instead of bundled.

One caveat for **degraded** specifically: forwarding an agent command (`//sessions`) types `/sessions` into the TUI, which opens a modal — the same `/d` wedge. So in degraded, `//cmd` realistically pairs with `/bridge` (forward it, then bridge to interact). That's acceptable, and it's why I'd still keep the modal-readiness item parked behind the bridge.

(Side note on your kimi `+2`→`8`-not-`10`: that's the naive extractor anchoring on a *stale* `+2` from the bridge transcript — the screen had several identical `+2`→answer pairs and it grabbed an old one before the new reply settled. Real but low-priority; better anchoring / the SML fixes it. Your "maybe I went too early" is also plausibly true.)

So my proposal: **`//` passthrough first** (small, kills the conflict), then surface agent commands in `/help`, and defer the native/consumer split + `loginCommand` + modal-readiness. Does that routing model match how you want the three to coexist — `/` ours, `//` the agent — or would you rather flip it (agent owns `/`, ours get a sigil)?