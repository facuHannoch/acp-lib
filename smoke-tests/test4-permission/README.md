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

### `claude-code-acp` — kinds are standard, the ORDER is not what was assumed

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

**`allow_always` is first. `reject_once` is last.** So the reported failure mode — "the
harness presents reject first, and approve becomes a refusal" — is *not* what this agent
does. What 0.3.1 actually did here was select `options[0]` = **"Always Allow"**: it granted
permission, durably, writing a standing rule into the agent's own settings on every
auto-approval. That is still a real bug, and arguably a worse one than a refusal, because it
is silent and it persists. But it is a different bug, and a refusal observed in production
needs another explanation.

### `codex-acp` and `kimi` — never asked

Neither routed a file write through `session/request_permission` at all. Both decide
internally, so `defaultPermission` is dead code for them and a consumer relying on a
permission prompt to gate these agents would be relying on nothing. Reported as `skipped`,
never as passed.

### A separate bug this turned up: `terminal/create` is not run through a shell

The `shell` scenario fails, and not on permissions — all five of its requests were approved
with `allow_once`. `claude-code-acp` routes its Bash tool through ACP terminals and sends:

```json
{"command": "printf 'ran' > shell.txt", "outputByteLimit": 32000, "env": [...]}
```

The whole shell line arrives in `command`, with **no `args`**. `src/terminals.ts` spawns
`[params.command, ...args]`, i.e. treats `command` as an executable path, so the agent gets:

```
Executable not found in $PATH: "printf 'ran' > shell.txt"
```

Every shell tool call from `claude-code-acp` fails this way. The ACP schema is ambiguous —
"The command to execute" plus an optional "Array of command arguments" — but the agent's
behaviour is the de-facto contract, and it puts a shell line there. Tracked separately from
the permission work; the fix is to run through a shell when `args` is absent or empty and
keep direct spawning when it is present.
