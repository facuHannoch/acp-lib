# CLI on `Agent`

Status: agreed, lowest priority (library line, last, in `../11-11-NOTE-overview.md`). Written 2026-11-11.

## Problem

The CLI drives the lower layers: `acp-client chat` builds an `AgentController` directly (`src/cli/index.ts:119`), and
`create` / `open` drive `AgentSession` through `SessionManager` (`src/cli/managed.ts`). Nothing drives `Agent` and its
conversations, which is where every new piece lives (the native harness, the orchestrator, identity injection).

A CLI is a consumer, and implementing a consumer is a project of its own. The library comes first: this spec only
fixes the shape so the library work doesn't close doors, and lists what the CLI needs from the API.

## How many CLIs

Two binaries, not three:

| Binary | Owner | What it drives |
| --- | --- | --- |
| `acp-client` | the library | `chat`: `AgentController` (adapter bring-up, `--wire`, degraded mode). `create` / `open`: managed sessions. New `agent ...`: `Agent` and its conversations |
| `harness` | the harness (`src/native-harness/`, its `cli/main.ts`) | `harness new`, `harness sessions`, `harness chat --session S [--channel C]`, `harness config`, `harness usage` against a harness home (`~/.harness/` by default), standalone; `harness serve --stdio --session S`, which hosts such as acp-client launch (`../harness/11-11-SPEC-harness-v1.md`) |

- **Decoupled on purpose.** The harness must be usable without acp-client, so its CLI ships with it. `acp-client agent`
  hosts the harness through `Agent` and adds what only the library has: ACP conversations, workers, the shared
  records.
- **Shared code is optional.** `acp-client` may reuse harness exports (event rendering, config validation); it never
  duplicates harness logic. Whether rendering helpers are worth sharing is decided when both exist.
- **Owns no logic** ("library first, CLI second", `src/cli/index.ts`). Anything awkward for the CLI is awkward for
  consumers and is fixed in the API.

## `acp-client agent`

Value before the native harness exists: one tool driving Codex, Claude, OpenCode and Grok with one persistence layer,
transcript and usage ledger, and conversations that switch harness mid-way without losing history (`handoff`,
`src/agent-session.ts:2046`).

Order:

1. **A REPL on `Agent`,** reusing `runRepl` (`src/repl/`): list, create and open conversations; switch adapter; show
   usage. Then, as the pieces land: `/workers` (list, check, stop through the orchestrator's consumer API), a
   model-call log for native conversations (the native `--wire`), and delegations, worker replies and wakes shown in
   the output.
2. **A TUI** once events are complete. It is the most demanding consumer of events (streaming text, tool calls,
   permission prompts, worker states, wakes), so events that drive a TUI drive any consumer's UI.

- Native conversations use the `Agent`'s harness session (its home and config). `--model` and reasoning flags set the
  conversation's channel settings; the system prompt and the rest of the config change through the harness's config
  API (or `harness config`), not through new library options. The API key comes from the harness's environment.
- ACP-only commands (`/bridge`, `/commands`) are hidden by controller capability
  (`11-11-SPEC-controller-interface.md`).
- It starts as a subcommand group of `acp-client` and becomes its own binary only if it grows into a product.

## What the API must provide

These are library requirements the CLI exposes, not CLI features:

- conversation listing with adapter, kind and state;
- every event the TUI needs, including worker states and wakes (`11-11-SPEC-orchestrator.md`);
- a model-call log event for native conversations (request summary, usage, latency, stop reason);
- the orchestrator's consumer API (`agent.workers.*`).

## Open

- [ ] Does the managed `AgentSession` REPL (`create` / `open`) fold into `acp-client agent`, or stay for managed
      sessions? Depends on whether the managed path stays supported.
- [ ] TUI framework (Ink, OpenTUI or other) when the time comes.
