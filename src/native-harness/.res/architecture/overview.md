# Overview

A native harness session represents one agent with a shared identity, system
prompt, configuration, and timeline. The harness owns its channels. Each
channel has its own inputs, participants, policy, and turns. At most one turn
executes at a time on a channel. Different channels can await models and tools
concurrently.

## Ownership

| Component | What it owns |
| --- | --- |
| Harness session | Configuration, approval handling, shared timeline, session lifecycle, and storage ownership |
| Channel scheduler | Admission, turn scheduling, and channel lifecycle |
| Turn | Inferences and tool invocations, with their results attributed to the turn and channel |
| Model adapter | Translating neutral requests and provider responses |
| Consumer host | Process launch, transport, conversation-to-channel mapping, and application records |
| Client attachment | Observing a channel and delivering its updates to a participant |

A turn can run without anyone observing its channel. A participant closing a
development chat subscription leaves accepted work in the harness. On the
integration branch, native controller shutdown currently requests a targeted
interrupt before detaching. The [operator controls proposal](../docs/operator-controls/0001-DESIGN/SPEC.md)
defines attachment disposal independently of channel and agent controls.

The host can provide policy and respond to approvals. Consumer-registered
tool callbacks are [proposed](../docs/tools-and-callbacks/0001-DESIGN/SPEC.md).
Coding workers and their orchestration belong to the consumer.

## Entry points

Paths are relative to the harness package.

| Entry point | Role |
| --- | --- |
| [`src/index.ts`](../../src/index.ts) | Assemble a session with its configured services and storage |
| [`src/client.ts`](../../src/client.ts) | Typed public client and in-process and stdio transports |
| [`src/testing.ts`](../../src/testing.ts) | Scripted model helpers for offline tests |
| `bun run serve --stdio` | Newline-delimited JSON-RPC endpoint. Use `--home` for managed SQLite sessions. |
| `bun run start` and `bun run chat` | Development runtime and terminal chat over Unix-socket HTTP, with an inspector and optional web chat |

Development HTTP and stdio are separate interfaces over the same session
assembly. The stdio host launches the child and holds the connection. See the
[package README](../../README.md) for commands and supported operations.
