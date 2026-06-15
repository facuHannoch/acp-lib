Good instinct to design first — `/login` has a hidden sequencing problem and degraded login is genuinely two different beasts. Let me lay it out.

## Part 1 — ACP `/login` (normal mode)

Your command shape is right, and auth has no nesting, so two levels not three:
- `/login` → list methods (`authMethods` is already parsed: `{id, name, description}`)
- `/login METHOD` → start

**"Is the start process something we have?"** — almost. The call itself is trivial (`transport.authenticate({methodId})` exists; just surface it on `AcpClient`/`AgentController`). And you're right that *if the agent supports it, it mostly works normally*: for browser/device-code flows the agent does the work and the `authenticate` call just **blocks until the user finishes**. So there's no "flow engine" to build on our side.

There are **two real things** to add, though:

1. **Surface the agent's auth output.** During an interactive method the agent relays the login URL / device code — almost always over **stderr** (which we already capture but only `log.debug`). So `/login METHOD` must, *while the call is pending*, route the agent's stderr to the user so they see "go to URL X, enter code Y." Without that, `/login` looks like it hangs. That's the main piece of work, and it's small.

2. **The sequencing trap.** Auth is *connection-level, pre-session*. But `controller.start()` today does `connect()` **then** `startSession()` atomically — and an unauthenticated agent will **fail `session/new`**, so `start()` throws and the controller never comes up… meaning you can't even *reach* `/login`. The correct order for an unauthed agent is: `connect` → (advertises authMethods, no session yet) → `/login` → `startSession`. So we need a **"connected, no session" state**: `start()` should treat a session failure as non-fatal when `authMethods` are present, keep the connection, and let `/login` (then a prompt) create the session afterward. We already have `isConnected` vs `hasSession`, so it's a modest change — but it's the part that makes `/login` actually testable on a logged-out agent.

So ACP `/login` = surface `authenticate`/`authMethods` + stream stderr during the call + make `start()` tolerate a deferred session. No flow engine.

## Part 2 — degraded `/login`

These aren't really "two options for the same thing" — they suit **different login shapes**, and that's the key insight:

- **Device-code / URL flows** (codex, gh, most modern CLIs): the tool prints `URL + code` and polls. This needs **no driving** — it's read-only. Your "parse the login flow" reduces to *relaying the screen* so the user sees the URL/code and completes it in a browser. The `/d` modal problem **doesn't bite here**, because we're not trying to drive a modal — just display it and wait for a success marker / settle.
- **Interactive credential flows** (type email → password → 2FA): this *is* `/d` hell — back-and-forth, modal, provider-specific. Driving+parsing this blindly is brittle and not worth it. **Bridge** is the honest answer.

So I'd frame degraded login as: **bridge is the must-have; read-only relay is a nice optimization for the common URL case; drive-and-parse interactive creds is a no.**

And a unifying realization: **bridged login is mode-independent.** It's just "run the provider's login CLI in a pty and hand the terminal to the user" — which is exactly the SPEC's tty-auth answer (`kimi login` needs a real terminal; a pty *is* one). That means:
- The adapter should carry a **`loginCommand`** (e.g. `["codex","login"]`, `["kimi","login"]`), spawned in its *own* pty and bridged — not the existing chat pty.
- `/login` can be **smart**: ACP `authenticate` if methods are advertised; else bridged `loginCommand` if present; else "no login mechanism." So even *normal* mode falls back to bridge when the agent has no protocol auth or needs a real tty (kimi).
- The **bridge is a reusable primitive** — it's also the `/bridge` escape hatch we discussed. Building it serves login *and* "just let me drive the TUI."

## My recommendation / order

1. **ACP `/login` first** (it's the smaller, protocol-correct piece): surface `authenticate`/`authMethods`, stream stderr during the call, add the connected-no-session state. Testable against codex.
2. **Then the bridge primitive** + `adapter.loginCommand`, and wire degraded (and fallback) `/login` to it. This is the robust tty-auth path.
3. **Read-only URL-relay** as a later refinement, only if the bridge feels too heavy for device-code logins.

Three things I'd want your call on before building:

- **Bridge exit key**: how does the user leave the bridge back to our REPL — a chord like `Ctrl-]` (telnet-style), or auto-detect login-complete and return? I lean `Ctrl-]` + best-effort completion detection.
- **`loginCommand` on the adapter** — agree that's where it belongs (alongside `command`/`ptyCommand`)?
- **Scope now**: just #1 (ACP `/login`) this round, or #1 + the bridge (#2) so degraded login actually works end-to-end?

What's your read — especially on whether to pull the bridge into this round or keep it to the ACP path first?



