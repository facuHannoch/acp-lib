# Overview

Status: current implementation, 2026-11-16.

## The entity

One session represents one agent with a configured system prompt, model/tools,
shared history and multiple channels. Channels preserve participant attribution
and run independently. Each channel runs one turn at a time; different channels
can await inference or tools concurrently.

The harness provides execution and configurable capabilities. Coding workers
and their orchestration belong to the consumer, initially acp-client. Configured
tools can expose those capabilities without making them built-in harness concepts.
Policy configuration is part of the target design; the current prototype does
not implement the full policy or permission system.

## Composition and entry points

`src/index.ts` exposes `createSession(options)`. It assembles the store, context
builder, scheduler and inner loop. It starts no listener, reads no input and
requires no provider key itself. The host supplies per-turn model and tool
services and can supply a store and observation wrapper.

| Entry point | Current role |
| --- | --- |
| `bun run start` | Development assembly: OpenRouter, scenario tools, Unix socket, inspector and LAN web chat |
| `bun run chat <channelId> <participantId>` | Terminal client of the development server |
| `src/client.ts` | Typed client with in-process and stdio transports |
| `src/testing.ts` | Scripted server assembly and in-process test client |
| `bun run serve --stdio` | Scripted experimental JSON-RPC server over newline-delimited JSON |

The development socket protocol and experimental JSON-RPC protocol are distinct
adapters. They share session execution, but are not interchangeable wire formats.
The stdio subset currently supports initialize, session/create, channel/push and
session/idle. It makes no real inference calls and has no load/resume operation.

## Ownership

| Part | Owns |
| --- | --- |
| Contracts | Neutral messages, model/tool interfaces, session and transport interfaces |
| Kernel | Per-channel scheduling, active inboxes and inference/tool iteration |
| Context capability | Rendering stored experience into inference messages |
| Model capability | Provider translation or scripted model behavior |
| Tool capabilities | Tool definitions and implementations |
| State/storage | The shared append-only conversation store, currently in memory |
| Interfaces | Protocol validation, clients, output subscriptions and inspection |
| Entry points | Configuration and assembly of implementations |

The kernel imports contracts only. Features communicate through contracts;
composition at entry points connects implementations. No harness module imports
acp-client code. The package must remain independently extractable.

## What survives today

Channels and their work survive a client disconnect while the process remains
alive. Nothing survives a process restart. History, queues, counters, pending
notices and protocol deduplication are all in memory. Tool-owned state, such as
the dashboard scenario counter, is also in memory and separate from history.

The stdio server drains accepted work at EOF within a five-second deadline.
Expiry exits with an error; it does not create a persisted suspension checkpoint.
SQLite and restart semantics are proposed in [Persistence](persistence.md).
