# Controller interface: what a conversation needs from its backend

Status: agreed, not started. Written 2026-11-11. First line of work (L1 in `../11-11-NOTE-overview.md`): an offline
refactor that every native piece depends on. Carries over the "provider-session interface" prerequisite of
`../../9-22+/10-17-NOTE-model-call-controller.md` and the 2026-11-09 review (counts below are from that review, on
`beta` at 0.12.1).

## Problem

`AgentConversation` is built on `AgentSession` (`src/agent-session.ts`, 5,022 lines), which depends on the concrete
`AgentController` (`src/controller.ts:122`). The nominal contract, `AgentClient` (`prompt`, `interrupt`, `stop`;
`src/agent-client.ts:45`), is much smaller than what the session uses. A second backend (the `NativeController`,
`11-11-SPEC-native-harness-integration.md`) can't be plugged in until that surface is an interface with ACP-only
parts marked optional.

The decision (overview, decision 6): one `AgentConversation`, with the backend chosen by the adapter's kind. A
separate conversation type was rejected because it would split the consumer API and everything built on
conversations.

## The interface

`AgentSession` uses about 20 members of `AgentController`. They split three ways.

| Group | Members | Native backend |
| --- | --- | --- |
| Core (required) | `prompt`, `cancel`, `forceStop`, `stop`, `start`, `startFresh`, `isConnected`, `subscribeOutput`, `subscribeConnection`, `cancelGraceMs`, `capabilities` | Implemented. `forceStop` aborts the HTTP call; `start` has nothing to launch. |
| Generalize | `configOptions`, `setConfig` (27 and 5 uses), `subscribeUsageUpdate`, `currentSessionId`, `availableCommands`, `subscribeAvailableCommands` | Its own settings in the same `ConfigOption` shape (model, reasoning, temperature); usage from every response; no commands at first. |
| Optional, behind capabilities | `isDegraded`, `currentMode`, `setMode`, `reconnect`, `listSessions`, `bridge`, `authenticate`; `session/load` with replay, `session/delete` | Absent; callers check capabilities. |

- **Name:** `ConversationController` (working name), in its own file next to `AgentClient`. `AgentController`
  implements it unchanged.
- **Optional members are capabilities, not stubs.** A backend reports what it supports; `AgentSession` checks before
  calling, rather than catching "not supported".
- **The operation-lifecycle primitives stay as they are:** each controller supplies `cancel` and `forceStop`; the
  never-invisible and never-stuck guarantees stay above the controller (`../../9-22+/10-17-SPEC-operation-lifecycle.md`).

## Neutral capabilities

`Capabilities` today is ACP's `initialize` result (protocol version, client fs and terminal, `loadSession`, prompt and
MCP capabilities). Add a neutral layer the session reads:

```ts
interface ConversationCapabilities {
  loadSession: boolean;         // can reattach to an existing provider session with its context
  forkSession: boolean;
  listSessions: boolean;
  modes: boolean;               // currentMode / setMode
  degradedMode: boolean;        // PTY fallback
  commands: boolean;            // availableCommands
  nativeSteering: boolean;      // inject at the next model call instead of cancel + resend
  media: { image: boolean; audio: boolean; file: boolean };   // from the model for native, from ACP for ACP
  mcpServers: { stdio: boolean; http: boolean; sse: boolean };
  acp?: AcpCapabilities;        // the raw initialize result, ACP backends only
}
```

`nativeSteering` is what the inbox and steering work (`11-11-SPEC-native-harness-integration.md`) reads to hand steer
items to the controller instead of cancelling.

## Paths inside `AgentSession`

Gate by capability; don't fake. Counted by references in `src/agent-session.ts`.

| Path | Size | Native backend |
| --- | --- | --- |
| Continuation after a crash or lost session | ~160 | Not needed: the harness reloads its own context store |
| Recovery and the missing-session classifier | ~53 | Not needed |
| Transcript and session-log writing | ~278 | Keep the SQLite side; JSONL optional |
| Handoff (switching adapter mid-conversation, `handoff`) | ~105 | Into native: seed from records or a summary; out of native: as today |
| Adoption and transcript import | ~70 | ACP-only |
| Degraded mode | ~20 | ACP-only |
| `internalSessionId` | ~87 | Generalized with the provider-session record |
| Client-side fs and terminals (`client.ts`, `terminals.ts`) | — | ACP-only |

Splitting `AgentSession` into a core and ACP-specific parts is worth considering later, not first.

## Records

Most records are neutral already (metering, error, cancellation, activity, media, out-of-band, participants). For a
native conversation the library's records stay an **observation log**: the harness keeps the context the model sees
in its own store (two logs, deliberately; integration spec). The changes this refactor needs:

| Record or table | Change |
| --- | --- |
| `provider_sessions` (`adapterId`, `mode`, `internalSessionId`) | A neutral "what backs this conversation" record; ACP session id and mode become ACP fields; native records the harness session id |
| `permission` | `PermissionRequest` carries ACP option kinds and a raw SDK request; make the shape neutral with ACP as one producer (also needed for forwarded worker requests, `11-11-SPEC-orchestrator.md`) |
| `protocol` (`conversation_protocol_records`) | Add a neutral model-call record: model, request id, usage, cache reads, latency, stop reason |
| `message` | Optional opaque provider data, for display and audit only (the harness owns passback) |

Superseded by the identity decision: generalizing `identity_delivery_cursors` and `targetProviderContextId` into a
context epoch. Delivery positions move to the harness timeline (integration spec).

## Steps

1. Introduce `ConversationController` and `ConversationCapabilities`; `AgentController` implements both. No behaviour
   change; existing tests cover it.
2. Replace direct `AgentController` uses in `AgentSession` with the interface; gate optional members by capability.
3. Generalize `provider_sessions` and the permission request; add the model-call record.
4. A fake controller in the test helpers implements only the core, and a test suite runs a conversation on it
   (prompt, steer, interrupt, stale policy, usage). That suite becomes the conformance check for the
   `NativeController`.

## Acceptance

- The full existing test suite passes with no behaviour change for ACP conversations.
- A conversation runs on the fake core-only controller: prompt, queue and steer delivery, interrupt, force stop,
  stale detection, usage recording, records written.
- No `instanceof AgentController` and no ACP type in `AgentSession` outside capability-gated paths.
