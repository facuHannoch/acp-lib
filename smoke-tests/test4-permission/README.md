# test4-permission — what agents actually send when they ask

An instrument first, a test second.

The 0.3.2 fix made `defaultPermission: "approve"` choose a permission option by its `kind`
(`allow_once`, falling back to `allow_always`) instead of by its position in the list. The
unit tests in `test/permissions.test.ts` prove the selection logic is right, but they prove
it against a fixture that sends what the ACP schema says agents send. That is circular: if a
real agent spells its kinds differently, or omits `kind`, the fix degrades to a silent
`cancelled` and permissions break again — quietly, and in exactly the way that is hardest to
attribute.

So this spawns real agents, asks each to use a tool, and prints every option verbatim before
judging anything.

```
bun smoke-tests/test4-permission/permission-smoke.ts            # every agent on PATH
bun smoke-tests/test4-permission/permission-smoke.ts claude
bun smoke-tests/test4-permission/permission-smoke.ts --only=mcp
bun smoke-tests/test4-permission/permission-smoke.ts --wire     # keep raw protocol
```

Exit codes: `0` all checks passed, `1` a check failed, `2` nothing could run.

## Four scenarios, because agents gate tools differently

| id | tool |
|---|---|
| `builtin` | the agent's own file-write tool |
| `shell` | the agent's shell/execute tool |
| `mcp` | a tool from `marker-mcp-server.ts`, bound by US at `session/new` |
| `mcp-json` | the same server, discovered by the AGENT from a project-scoped `.mcp.json` |

The MCP ones exist because that is the path the original bug was reported on. An agent may
treat third-party tools quite unlike its own, and testing only the built-in path would have
proved the wrong thing. The two MCP scenarios differ in who binds the server: a server the
agent discovers for itself is trusted on the agent's own terms, and that decision could in
principle never cross ACP at all — in which case `defaultPermission` could not reach it,
whatever it was set to. Measured below: for `claude-code-acp` it makes no difference.

Each scenario ends with a check that the side effect is **visible on disk**. Protocol traffic
can look like a clean approval while the call never happened; the filesystem is the only
witness that cannot be talked out of it. That check is what caught the terminal bug below.

## No `onPermissionRequest` anywhere — on purpose

With no handler, the library's own default path answers, which is the code 0.3.2 changed.
Supplying a handler here would replace the code under test with test code. Both halves of
each exchange are recovered from raw wire traffic instead: the agent's request going one way,
our response coming back, matched on JSON-RPC id.

(An `out` frame with an `id` and no `method` is a response. That distinction matters — our own
outgoing requests use a separate id space and the numbers collide.)

## Measured, 2026-08-04

### The two Claude bridges order their options in OPPOSITE directions

This is the finding. `claude` and `claudeAgent` in `ADAPTERS` are different programs, not a
rename, and a client that picks an option by position gets opposite behaviour from each:

| adapter | package | `options[0]` | what 0.3.1 did |
|---|---|---|---|
| `claude` | `@zed-industries/claude-code-acp` | `allow_always` | granted **standing** permission, silently |
| `claudeAgent` | `@agentclientprotocol/claude-agent-acp` | `reject_once` | **refused everything** |

`claudeAgent`, the one that produced the original bug report, sends:

```
kind="reject_once"   optionId="reject"        name="Deny"
kind="allow_once"    optionId="allow"         name="Allow Once"
kind="allow_always"  optionId="allow_always"  name="Always Allow"
```

Against 0.3.1 that is `options[0]` = `reject`, and every tool call in the session comes back
`User refused permission to run tool` — with the agent, not the client, appearing to be the
one refusing. Confirmed against a production log where `permission_request` and
`permission_response outcome={"outcome":"selected","optionId":"reject"}` are one millisecond
apart.

Its `allow_always` option also carries `_meta.permission.changes`, spelling out that
accepting it writes a `persistent` / `project_local` policy rule. That is the durable-grant
concern made explicit by the agent itself, and it is why `allow_once` is preferred rather
than merely accepted.

### `claude-code-acp` — kinds are standard, the ORDER is the other way round

Identical across all four scenarios — including both MCP binding paths — 8 requests observed:

```
kind="allow_always"  optionId="allow_always"  name="Always Allow"
kind="allow_once"    optionId="allow"         name="Allow"
kind="reject_once"   optionId="reject"        name="Reject"
```

Two things follow, and the second corrects the bug report that started this work.

**The kinds are exactly the four ACP names.** Selecting by `kind` is sound for this agent.
Selecting by `name` would not be — "Always Allow" and "Allow" differ by one word, and nothing
in the protocol makes that prose stable.

**`allow_always` is first. `reject_once` is last** — the reverse of `claudeAgent` above. What
0.3.1 did here was select `options[0]` = **"Always Allow"**: it granted permission, durably,
writing a standing rule into the agent's own settings on every auto-approval. Silent, and it
persists.

Two agents from the same vendor, opposite orderings, opposite failure modes from the same
line of code. Nothing in the protocol makes either order wrong, which is the whole argument
for keying on `kind`.

### `codex-acp` and `kimi` — never asked

Neither routed a file write through `session/request_permission` at all. Both decide
internally, so `defaultPermission` is dead code for them and a consumer relying on a
permission prompt to gate these agents would be relying on nothing. Reported as `skipped`,
never as passed.

### A separate bug this turned up: `terminal/create` was not run through a shell

**Fixed in 0.3.3.** Kept here because the scenario exists to keep it fixed.

The `shell` scenario failed, and not on permissions — all five of its requests were approved
with `allow_once`. `claude-code-acp` routes its Bash tool through ACP terminals and sent:

```json
{"command": "printf 'ran' > shell.txt", "outputByteLimit": 32000, "env": [...]}
```

The whole shell line arrives in `command`, with **no `args`**. `src/terminals.ts` spawns
`[params.command, ...args]`, i.e. treats `command` as an executable path, so the agent gets:

```
Executable not found in $PATH: "printf 'ran' > shell.txt"
```

Every shell tool call from `claude-code-acp` failed this way. The model retried five times
with different phrasings — all five approved — then delegated to a subagent that reported
success without having written anything. From outside, that reads as "the agent is broken"
or "permissions are broken", which is why it is worth naming.

The ACP schema is ambiguous — "The command to execute" plus an optional "Array of command
arguments" — but the agent's behaviour is the de-facto contract, and it puts a shell line
there. `src/terminals.ts` now spawns directly when `args` is present (those arguments are
already final, and re-splitting would turn one argument containing a space into two) and
runs `command` through a shell when it is not. After the fix this scenario takes ONE
permission request instead of five, and `shell.txt` exists.
