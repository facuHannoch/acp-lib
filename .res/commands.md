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







Ah — now I see exactly where we diverged, and the good news is **what we built is correct**; the confusion is conceptual. Let me untangle it, because your own test actually proves the distinction.

There are **two different command sets**, and they are not the same thing:

**1. ACP-advertised commands** (what we capture via `available_commands_update`)
This is a *curated subset* the agent chooses to expose **over the protocol**. For kimi-acp that's `/init /compact /clear /yolo /afk /plan /add-dir /export /import`. They run by sending the command as prompt text — which is **exactly** what the page you linked describes ("Commands are included as regular user messages in prompt requests"). Our `//name` does precisely this. Your test confirms it works:
- `//compact` → "The context is empty" ✅ (it's advertised, so it ran)
- `//sessions` → "Unknown slash command /sessions" ✅ (kimi-acp does **not** advertise `/sessions`, so the agent legitimately rejects it)

So `//` is behaving correctly. `//sessions` "fails" because **`/sessions` isn't an ACP command at all.**

**2. The interactive TUI's own command set** (what you saw in the kimi banner)
`/sessions /changelog /debug /editor /btw /theme …` — the full native CLI menu. **These are NOT part of ACP.** The agent never exposes them over the protocol; they only exist inside the real TUI. There is *no* ACP mechanism to invoke them. The protocol deliberately advertises a smaller, headless-friendly subset (note kimi's ACP list omits all the UI-ish ones like sessions/editor/theme).

So the boundary is fundamental, not a gap we can close:

|                       | ACP-advertised cmds | TUI-only cmds                |
| --------------------- | ------------------- | ---------------------------- |
| **ACP (normal) mode** | `//name` ✅         | unreachable — use `/bridge`  |
| **degraded mode**     | typed into TUI      | all work (you *are* the TUI) |

The answer to your "can we access them?" is: **the TUI-only commands, only by driving the real TUI** — i.e. `/bridge` in normal mode, or degraded mode where you're already in it. That's why the bridge matters: it's the *only* door to that second set.

So nothing's broken — but the label `agent commands` oversold it and made you expect the full TUI menu. I'd make `/help` honest about it:

```
agent (ACP) commands — send with //name:  /init /compact /clear /yolo /afk /plan /add-dir /export /import
  (the agent's full interactive menu — /sessions, /theme, … — is only reachable via /bridge)
```

That one wording change sets the right expectation: `//` = the protocol's command subset; `/bridge` = the real TUI's everything. Want me to make that `/help` tweak (and otherwise leave the working `//` mechanism as-is)?