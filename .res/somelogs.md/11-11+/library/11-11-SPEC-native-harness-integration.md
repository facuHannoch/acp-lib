# Native harness in acp-client

Status: **stage 2a's core implemented** from the harness side (State after implementation, below; approved
`7133c5c`); the rest is Remaining work: implementation plan. Reviews 1–5 and a final review 2026-11-12/13; revised 2026-11-21 against the
implementation. Implemented in two stages (2a, 2b) alongside the two parts of harness v1. The harness seen from the
library: what acp-client needs from it and what changes in acp-client. How the harness works inside is its own
documentation (`../../../../src/native-harness/ARCHITECTURE.md`, `README.md`, `.res/docs/`).

## State after implementation (2026-11-21)

Stage 2a's core was built from the harness side, not from the plan that was here (briefs N0–N11, now replaced by
Remaining work: implementation plan, below): the harness's acp-client integration work
(`../../../../src/native-harness/.res/docs/acp-client-integration/0001-DESIGN/`: `SPEC.md`, `PROTOCOL.md`,
`11-20-LOG.md`), Gates 1–3, independently approved at `7133c5c`. **The wire protocol is the harness's** (its
`PROTOCOL.md`, the README's protocol section and decisions `0013`–`0020` under `src/native-harness/.res/decisions/`);
`../11-12-SPEC-harness-protocol.md` is superseded where they differ. The sections below keep the original design
for its reasoning; a note at the head of each says what changed.

**Built** (`src/native/host.ts`, `controller.ts`, `records.ts`; `NativeAdapter`, `AgentConfig.harness`,
`agent.nativeHarness`):

- One process per `Agent`, launched lazily on first work through the launcher (kind `native-harness`); concurrent
  first uses share one start; creating or deleting a conversation starts nothing.
- One durable harness session per `Agent`, one channel per native conversation.
- Pending channel changes (name, policy, suspension, deletion) sent inside `session/load` or `session/create`
  (decision 0020), each with a version (`changeId`) so an old acknowledgement can't clear a newer edit; edits after
  the startup cutoff go through the live channel API before fresh input.
- Each input saved with its exact payload before `channel/push`, retried with the same id after a lost response;
  pushes idempotent by id in the harness.
- Turn correlation from `turn_started` and `turn_took`, also when they arrive before the push response; a turn's
  early output and outcome held until the session's prepared turn attaches.
- Targeted interrupt: `forceStop()` interrupts only its channel's turn; other channels keep running.
- Recovery at open from the harness's revisioned `session/load` view (turns, inputs with their milestone,
  committed messages, paged): missed replies restored by message id, interrupted turns settled, accepted untaken
  input left pending; opening never replays an interrupted turn or tool.
- Approvals routed to the prompt handlers of the first message the turn took (`approval_requested`,
  `approval/respond` with `allow_once` or `deny`).
- Restart after an unexpected loss with work outstanding: at most 3 within 60 s, then `failed` until `restart()`.
- `final` text by default, `stream` supported in the controller.

**Built differently from this spec, accepted** (triage rule, `../.plan-execution/plan.md`):

| This spec | Built |
| --- | --- |
| channel holds as leases for exclusive operations | channel suspension (`channel/suspend`, `resume`) and session `suspend`, `resume`, `stop`; holds only if a consumer operation needs one later |
| `channel/update` | `channel/create`, `edit`, `suspend`, `resume`, `delete`; a retired id can't be reopened; a delete finding pending work suspends the channel and reports `channel_busy` |
| reconciliation by turn position, watermark and item status | the revisioned load view by stable ids; bounded (paged) recovery of turns and inputs deferred |
| a cancellable start with no automatic limit | a 30 s startup deadline from spawn to the open response (configurable); the process is killed; no automatic retry, the next use tries again |
| requests wait, with `harness_unresponsive` after 30 s | a 30 s request timeout (configurable); a timed-out change stays pending for the next open |
| permissions as host-owned events with a host timeout; `kind:`, `command:` rules | approvals by request id, `allow_once` or `deny`, a harness-owned 10-minute timeout; harness policies are a `fallback` plus exact tool names |
| `startFresh` as a channel reset | unsupported: `conversationCapabilities.freshContext: false`, `startFresh` throws `UnsupportedError`; no context reset |
| events for an unloaded conversation load it | held in memory (2,000 per channel, oldest dropped) until a conversation attaches |
| a prompt to a suspended channel is held | refused (`channel_suspended`) |
| `abandonTurn` interrupts | it never stops provider work (the controller contract) |
| config stored by acp-client, `describe()` before start | the harness manages its config (decision 0016: inline, sidecar or saved); `config/validate` checks it; no acp-client override store |
| harness callbacks (functions, delegation, history) | consumer-registered tools through `functions/call` (the harness's tools-and-callbacks work, approved on its branch, with acp-client's host functions and `NativeFunctionContext`); calls carry their contributing `policyNames` (callback policy amendment, proposed); no delegation or history callbacks: delegation is acp-client's, through registered tools (orchestrator spec) |
| usage per call, pushed | pulled: `session/model-calls` with per-attempt usage; not yet forwarded to metering |

**Accepted limitations** (in addition to Limitations, below): the startup batch's transitions are composed, not one
storage transaction (a crash can leave a prefix applied; the host resends its newest desired state); a saved
submission whose start failed is dropped; an ambiguous push is repeated once; an unavailable or stale approval
answer returns false; turn ids reported to the session are `native-turn-<harness turn id>`; a native prompt's text
isn't written as a user record and `endedBy` isn't reported (the reviewed base's rules for backend-started turns).

## Remaining work: implementation plan

Written 2026-11-22. Six briefs, R1–R6; the rest of stage 2a is built (State after implementation). Each brief follows
`../.plan-execution/plan.md` (its code-quality and triage rules apply) and starts with a **grounding step**: the
implementer checks the brief's "code as it is" against the code at that moment and reports what moved or doesn't
exist before step 1. Gates use `bun run typecheck` and the full `bun test ./test` on a clean copy, output saved;
the baseline is the last approved native integration run (1,391 tests, 129 files, at `7133c5c`, plus the tools and
callbacks merge). No live harness runs.

| Brief | Depends on | State |
| --- | --- | --- |
| R1. Durable channel intents | nothing | ready |
| R2. The permission setting and matcher | nothing | ready |
| R3. Permissions as conversation events | R2 | ready |
| R4. ACP cancellable connect and `providerStart` | nothing | outline; written in full when started |
| R5. Native usage and billing-grade metering | nothing | outline |
| R6. Small gaps from the integration log | nothing | outline |

**Order:** R1 first. Then R2 and R3: the orchestrator waits on them. R4–R6 can run in parallel with the orchestrator.
Stage 2b gets its own plan later (Stages).

### Brief R1: durable channel intents

**Scope:** steps 0–4 (Durable channel intents). Must not touch: the harness, the wire protocol, the submission half of
the host records (a follow-up).

**The code as it is** (2026-11-22):

- `src/native/records.ts`: `NativeHostRecords`, with the channel half (`desire`, `pendingChange`, `pendingChanges`,
  `confirmChange`, versions that are the wire `changeId`) and the submission half; `createMemoryHostRecords` (the
  default) and `createFileHostRecords`. **The interface is synchronous;** persistence is asynchronous.
- `src/native/host.ts` (761 lines, over the ~400 guideline): reads `pendingChanges()` as the startup cutoff (around
  line 344), clears with `confirmChange` on an `applied` result (352), sends post-cutoff edits live (468).
- `src/agent/conversation-manager.ts`, `delete()` (around line 617): `nativeHost.changeChannel(id, { lifecycle:
  "retired" })`, then, separately, `persistence.conversations.delete(id, deletedAt)`.
- `src/persistence/backend.ts`: optional repositories with capability flags (`identity?`, `capabilities.identity`);
  `transaction(work)`. SQLite schema version 16 (`src/persistence/sqlite-schema.ts:5`).

0. **Grounding:** the above, plus how the host gets its records today (`AgentConfig.harness`), and a decision with a
   recommendation on the sync/async mismatch: make the channel half asynchronous, or keep an in-memory mirror loaded
   at host start and written through the repository. **Gate:** the grounding report, reviewed.
1. **The `channels?` repository** (`src/persistence/`, following `identity?`), with `capabilities.channels`: per
   channel, its id, the latest desired change (name, policy, lifecycle) and a version; operations to merge a desire
   (returning the new version), read one or all pending changes, and clear one only if the given version is still
   its newest. SQLite implementation, schema 17, an upgrade migration from 16. **Gate:** suite green; repository
   tests (merge, newest field wins, clear only the newest version); a test opening a version-16 database and
   upgrading it.
2. **Host records over the repository:** a `NativeHostRecords` channel half backed by `channels?`, used whenever the
   `Agent`'s backend has `capabilities.channels`; the memory records otherwise, unchanged. The host's delivery logic
   is reused unchanged. **Gate:** the existing `test/native` suite passes with the persistent records; host tests
   for an old acknowledgement not clearing a newer edit still pass.
3. **The delete and its intent in one transaction:** for a native conversation, `delete()` marks the conversation
   deleted and records `{ lifecycle: "retired" }` in one `transaction`; after the commit, a running host sends it
   live. Renames, policy changes and suspensions are recorded through the same repository. **Gate:** a delete whose
   intent write fails leaves the conversation in place (and the reverse); a running harness receives the retirement
   after the commit.
4. **Restart tests** (`test/native/`, real stdio harness): delete while the harness is stopped, restart acp-client
   (a new `Agent` over the same persistence), start the harness: the channel is retired before it can take work; a
   crash after the harness applied a retirement but before acp-client cleared it: resending is applied, nothing
   runs on the channel; a blocked retirement (pending input) stays pending and is reported blocked. **Gate:** each.

**Done:** report commits, test count and time, the sync/async decision, the schema change, `host.ts` and
`conversation-manager.ts` line counts before and after.
**Risks:** two places writing intents (sign: a change recorded in memory but not in the repository); one writer, the
repository, is the guard. `host.ts` growing further (extract the records adapter instead).

### Brief R2: the permission setting and matcher (ACP side)

**Scope:** steps 0–3 (Permissions: One permission setting, Matching an ACP request). No harness: native approvals
keep the harness's own policies. Must not touch: the harness's policy model; native approval routing.

**The code as it is** (read 2026-11-13; check in step 0): a request reaches the running prompt's
`onPermissionRequest` handler, built in `runPrompt`; without one, `defaultPermissionOutcome(request,
this.defaultPermission)` (`src/agent-session.ts`). `defaultPermission` is `"approve" | "cancel"`, default
`"cancel"`, passed down to the ACP client, which has its own `defaultOutcome` (`src/client.ts`). Both pick
`allow_once`, falling back to `allow_always` (`rules/11-13-RULES-permission-auto-approve.md`).

0. **Grounding.** **Gate:** the report.
1. **The neutral permission request** (`src/permissions/request.ts`): tool (name, kind, raw input), title, options with
   kinds; ACP's request becomes one producer; records keep their shape. **Gate:** suite green.
2. **The matcher** (`src/permissions/matcher.ts`): `permissions: { default, rules }`; rules `kind:<acp kind>` and
   `command:<exact command>` (normalized: unwrap `bash -lc "…"`, join argument lists; exact only, never a substring or
   prefix); the most restrictive match wins; no match → `default`; allow picks `allow_once`, else `allow_always`;
   deny picks `reject_once`. The same matcher evaluates the orchestrator's `worker:` rules (the prefix stripped).
   Tests per adapter's raw input shape (Codex, Claude, OpenCode, Grok fixtures), including commands that can't be
   normalized. **Gate:** matcher tests green.
3. **Replace `defaultPermission`** with the setting on `AgentConfig`, `CreateAgentConversationConfig` and
   `conversationDefaults` (`"approve"` → `{ default: "allow" }`, `"cancel"` → `{ default: "ask" }`), in both places it
   is read. An omitted setting defaults to ask. The Agent, conversation defaults, conversation, and runtime
   settings replace each other in that order. The optional `permissionRule(request) => level | undefined` wins
   over matching rules and the default. Only ask reaches a prompt handler. Until R3, an unattended ask is
   refused using the deny selection and recorded as denied. Native asks use the callback and default only. **Gate:** suite green; the A1
   permission snapshots unchanged. Changelog: the setting (breaking).

**Done:** report commits, test count and time, the normalization table per adapter, every place `defaultPermission`
was read and what replaced it.
**Risks:** a normalization rule matching too much (sign: a `command:` rule matching a command it shouldn't; exact
only).

### Brief R3: permissions as conversation events

**Scope:** steps 0–3 (Permissions). Covers ACP requests and native approvals alike.

**Built on the host's approval responder** (corrected 2026-11-22): the harness's operator controls work (decision
0022, in `alpha` since `713a76a`) built one host-level approval responder for all channels, which answers approvals
before they reach a conversation and closes each pending request with a notification. R3 was grounded on it and
built on top of it (it is one of the two native routes: its answers are `by: "handler"`, its closes resolve once).
**R3 is done:** gated at `fcd6f09` (1,509 tests), merged in `alpha` `4e88243`; its decisions are in its
changelog and `library/11-22-LOG-native-harness-integration.md`.

**The code as it is:** ACP requests as in R2. Native approvals arrive as the harness's `approval_requested` and are
answered with `approval/respond` (`allow_once` or `deny`) by the prompt handlers of the first message the turn took
(`src/native/host.ts`, `controller.ts`); the harness refuses after 10 minutes, or at once with no declared consumer.

0. **Grounding.** **Gate:** the report.
1. **The events:** `permission_requested { id, turnId, tool, title, options, expiresAt }` on the conversation's events
   (added to `AgentSessionEvent`) for every request, ACP or native, whoever answers it. `expiresAt` is present for
   consumer waits. `permission_resolved { id, outcome, by }` follows on close (`by`: handler, consumer, default,
   timeout, turn ended). The `permission` records
   unchanged. **Gate:** every request has exactly one resolved event, on both kinds of conversation.
2. **The answer and who decides:** `conversation.answerPermission(id, optionId)` returning `{ accepted }` (false when
   already resolved); `answersPermissions` and `permissionTimeoutMs` (default 5 minutes, inside the harness's 10,
   counted from receipt) on `CreateAgentConversationConfig` and `conversationDefaults`. Final policy levels apply
   immediately. For ask, use the turn's first permission handler, or wait up to the deadline if
   `answersPermissions` is true. An unattended ask is refused immediately. For native, the answer maps to `allow_once` or
   `deny`. **Gate:** an answer through the method; the timeout; no answerer; a turn ending with a request open; the
   handler shortcut (event still emitted, resolved `by: "handler"`, a later `answerPermission` not accepted); a native
   approval answered through the method over a real stdio harness.
3. **Changelog:** the two events, `answerPermission`, the two options. **Gate:** reviewed.

**Done:** report commits and each case.
**Risks:** a request left open forever (sign: a `permission_requested` with no `permission_resolved`).

### Brief R4 (outline): ACP cancellable connect and `providerStart`

The original N1 (in this file's history), ACP only: a fixture agent that never answers the handshake or the session;
the connection attempt reachable by `stop()`; the pending calls raced against the connection closing; no late
install on any connecting path (`start`, `startFresh`, `reconnect`, `setMode`, handoff targets); one attempt at a
time; `ConnectionCancelledError`; then `providerStart: "on_open" | "on_first_use"` (Cancellable connect, Lazy start
for ACP conversations too).

### Brief R5 (outline): native usage and billing-grade metering

The native inference source implementing `InferenceSource`, keyed `<Agent id>/<channel id>`, fed from the harness's
model-call records (`session/model-calls`, per-attempt usage) read at each turn's end; calls between turns on a
channel through `drainForeign`; the `native-harness@1` certification, looked up by adapter kind, checked at open
(Billing-grade metering). **Gate to define:** a tool-using turn's metering matches the harness's model-call records
exactly.

### Brief R6 (outline): small gaps from the integration log

Confirm withdrawal through the harness once a push was sent, including across reopen. Forward `items_receipt`
beyond `receiptOf` and verify consumer `stream` text over real stdio. Keep a reopen regression for backend
supervision, which already disables the client stall clock.

Follow-ups, not scheduled: message submissions surviving an acp-client restart; reconciling turns that ended while
no acp-client process existed; bounded recovery pages for turns and inputs; acp-client-side `agent.harness.export()`
and `import()`; host controls beyond `agent.nativeHarness` (`start`, `stop`, `state`).

## Why the library needs a harness of its own

The 10-17 note (`../../9-22+/10-17-NOTE-model-call-controller.md`) proposed a controller that calls a model API with
no harness. It grew into a harness of our own, for reasons that show from acp-client's side:

- **Resources.** Every conversation owns a harness process (hundreds of MB). Many conversations, few processes is the
  pool (`11-11-SPEC-orchestrator.md`); the many conversations need a backend that isn't a process each.
- **One agent across conversations.** The checkpoint-backed identity (`src/identity/checkpoint-backed.ts`) copied raw
  messages from other conversations into a preamble (`maxContextChars` 32,000, `maxSourceChars` 8,000) and proved
  unreliable.
- **Control.** Through ACP the system prompt goes in as a first prompt, some models refuse it, and the harness's own
  prompt can override ours; context, compaction and tool descriptions aren't ours. With our own loop they are; the
  tuning harness prompts gave for free is ours to write.
- **Talking to work needs tools,** and a model calling tools in a loop is a harness. Building inside an existing
  harness is impossible (no API inside their loop).

Rejected: a plain HTTP controller with the model client as a library layer; the harness in acp-client's process (it
breaks isolation, below); speaking ACP (it has no agent-started turns, no injection into a running turn, no policy per
prompt, no non-prompt items, no member identity calls; the core of the design would live in extensions); one harness
per conversation.

## Isolation: the harness runs as its own process

Today an ACP conversation's whole harness runs as its own process started through the launcher (`src/launcher.ts`,
`AcpLauncher.prepare` → command, cwd, complete env): its loop, credentials, session files and every operation it
performs live in the agent's environment (a container, say), while acp-client may run elsewhere. The native harness
gives the same guarantee, from v1:

- **One `Agent` is one harness session** (one entity), served by one process: every native conversation of the
  `Agent` is a channel of that session, multiplexed over one connection (Sessions and channels, below).
- **Started through the launcher,** generalized from `AcpLauncher` to a `ProcessLauncher` (same `prepare` shape; the
  `kind` gains `"native-harness"`), so `docker exec`, cwd and env work unchanged; the default is the one conversations
  already use (`conversationDefaults.launcher`, `src/agent.ts:229`). `AcpLauncher` stays as an alias.
- **`harness serve --stdio`:** the harness's server mode. Its protocol is the harness's public API made
  serializable: JSON-RPC over stdio, defined and versioned in its own spec (`../11-12-SPEC-harness-protocol.md`),
  with the client exported from `src/native-harness/client.ts`. acp-client doesn't write protocol code; it launches
  the process and uses the client.
- **Everything the agent does runs there:** model calls (API keys in that environment), `http` and `command` tools,
  MCP servers, the session's files.
- **Callbacks from the harness to the host,** like ACP's fs and terminal requests to the client: function tools, the
  delegation backend (the orchestrator stays in acp-client), history sources, and permission requests. Identity for
  ACP conversations goes the other way: acp-client asks the harness (`member/prepare`, `member/delivered`).
- **In-process transport** exists too (same client interface), for tests, the standalone CLI and trusted local use;
  with acp-client the process is the default. It passes data the way the protocol would: copies, never shared
  objects, so both clients behave the same and tests on one hold for the other. It gives up isolation (the agent's
  tools, keys and files run in acp-client's process) and a harness crash takes acp-client down; what it gains is no
  process start and no serialization of large payloads. It isn't faster per request in any way that matters (stdio
  costs well under a millisecond against model calls of seconds), and under load a separate process is better: it
  has its own thread, so the harness's CPU work doesn't slow acp-client's, nor the reverse.
- **One process for many conversations** means a crash affects all of them: the host restarts the process
  (bounded retries; Process lifecycle, below), each native conversation's running turn is settled by reconciliation
  after the restart (finished if it had ended, failed if it was still running), and the orchestrator's restart rules
  apply to workers it was running. For the same reason, nothing a single conversation
  does stops the process: a conversation's `stop` and `forceStop` act on its channel only.

## What acp-client sees

```
AgentConversation ── AgentSession ── NativeController ── HarnessClient ══ stdio ══ harness serve
                                          │ translation only                   (agent's environment)
                                          └─ one NativeHarnessHost per Agent: launches, holds the client,
                                             serves callbacks (functions, delegation, history)
```

### Sessions and channels in acp-client

A harness session is the entity; a channel is one line into it (`../harness/11-11-SPEC-harness-v1.md`, Sessions and
channels). In acp-client:

| acp-client | Harness |
| --- | --- |
| an `Agent` with a native harness configured | one session, created on the harness's first start and loaded afterwards. Its id is the `Agent`'s own stable id (`agent_identity.agent_session_id`), so acp-client stores nothing to find it |
| a native `AgentConversation` (`agc-…`) | a channel of that session; the channel id is the conversation id, passed through. Channels always exist: there is no "open" step a conversation must take before the harness can use it |
| the conversation's provider-session row (`provider_sessions`) | `internal_session_id` = the harness session id = the `Agent`'s id, the same for every native conversation of the `Agent` (the index on it isn't unique); the channel id in the row's metadata |
| a cleared transcript or a handoff into native | a fresh context on the same channel (`channel.reset()`), the old row deactivated, a new one active |
| deleting the conversation | closing the channel; its timeline events stay (they are the entity's history) |
| participants (`ParticipantRef { id, kind, name }`, shared by all of an `Agent`'s conversations) | the session's participant registry: `id` → id, `name` → label, `kind` → person, agent or other; sent at start and with `participants/update` when one is added or changes; items name their sender by id; the same id in two conversations is the same person |
| the conversation's `policy` (stored, current value only) | the channel's policy |
| the conversation's `title` (set at creation; `conversation.setTitle()` added) | the channel's label, shown to the agent |
| model settings changed on the conversation (`setConfig`: model, reasoning, temperature) | the channel's settings (`channel/update`), overriding the session's for that channel only |
| what the conversation's consumer wants to receive, and what acp-client persists | the channel's subscription (Subscriptions, below) |
| an ACP conversation, when a harness is configured | a managed member channel (`member/register`): its messages and summaries are reported, and it receives what the harness prepares |

**One session id, many conversations.** Like one phone number with many extensions: the session id says which agent,
the channel id says which line. Code that assumes one conversation per `internal_session_id` must not run for native
conversations or must look up by session id and channel id together: adoption and transcript import, provider-session
delete, `listSessions` (all absent for native, by capability), and per-session metering queries
(`metering_records_internal_session_idx`), which for native aggregate the whole entity.

**Where the session lives:**

- **In the harness home,** which the consumer can set (`harness.home`); by default a home inside acp-client's own
  data location (`<persistence root>/harness/`). The harness's own default, standalone, is `~/.harness/`. The path is
  passed to `harness serve`, so it is a path in the harness's environment.
- **No sync in v1.** acp-client can't tell whether the harness runs isolated (the launcher is opaque), so it keeps no
  copy. A path the harness can't reach fails; an isolated harness on an ephemeral home loses the entity when its
  environment goes away unless the consumer mounts a durable volume. Both are the consumer's to manage.
- **Manual export and import:** `agent.harness.export()` returns the whole session as a bundle (`session/export`;
  it starts the process if needed). `agent.harness.import(bundle)` restores a session into a home that doesn't have
  it yet, renamed to the `Agent`'s id; importing where the session already exists fails, so a live entity is never
  overwritten by accident. Restoring after a lost container (a fresh volume) works naturally; replacing an existing
  entity means deleting it first, explicitly. A consumer may export on close.
- Continuous copies, delegated writing and periodic export are in `../harness/todos/11-12-TODO-session-sync-and-backup.md`.
- **The config** belongs to the session, and acp-client holds it while hosting (Configuration known before start,
  below): the `Agent` config's `harness.config` is the starting point, changes made through the API are stored by
  acp-client as overrides on top of it, and the result is sent each time the harness starts. Edits made with the
  standalone `harness config` command are overwritten the next time acp-client starts that session.
- **The session is locked** while acp-client has it open; another host (the standalone CLI) can't open it meanwhile.
  A lock left by a crashed process is reclaimed by the harness (the lock records the process id); acp-client only
  reports "locked by another host".

### Sender and policy

Three layers, first match wins: the message, the channel, the session.

```ts
const conv = await agent.conversations.create({ adapterId: "main", policy: "owner", title: "Owner, private chat" });
await conv.prompt({ text: "hi", participantId: "bob", policy: "trusted" }); // this message only
await conv.setPolicy("guest");                                               // the channel from now on
```

- **Message:** an optional `policy` on `prompt`, for that message only.
- **Channel:** the conversation's `policy`, set at creation (else seeded from the native adapter's `defaultPolicy`)
  and changed with `setPolicy`. Stored in the `channels?` repository (Code plan, Storage), current value only (no history), so
  the consumer sets it once and acp-client can send it to the harness even if the harness isn't running when it is
  set (Channel changes, below). A change applies from the next item; it is not an exclusive operation.
- **Session:** the harness config's `defaultPolicy`.
- **Only the consumer's code sets policies;** nothing reads them from message text. Names are checked when they are
  set, against the stored config through `describe` (below), so an unknown name fails at once, even before the
  harness runs; the harness checks again on use.
- **Recorded:** the user-message record notes the policy that applied (one metadata field), so "why did the agent
  refuse that?" has an answer. Nothing else is versioned.
- **Senders** are participants as they exist today (`resolveParticipant`, `src/agent/persisted-lifecycle.ts:387`),
  passed through unchanged; `user:default` passes as a sender with no name. No notes and no per-participant policy
  for now; if testing shows the agent needs more about people, participants are where it goes.
- **ACP conversations** get a `policy` too: the scope their messages carry when reported to the timeline, and what
  identity they receive as member channels.

### Adapters

`Adapter` stays what it is: the `HarnessController`'s adapter, an external harness command
(`{ command, ptyCommand?, cancelGraceMs?, displayName? }`, `src/adapters.ts`; validated in
`src/agent-adapter-registry.ts`; exported and used by agents-core). The native adapter is a separate type:

```ts
interface NativeAdapter {
  kind: "native";            // a conversation on this adapter is a channel of the Agent's harness session
  defaultPolicy?: string;    // seeds a new channel's policy when the conversation sets none
  displayName?: string;
}
type AgentAdapter = Adapter | NativeAdapter;   // what Agent configs take

interface AgentHarnessConfig {                 // AgentConfig.harness: one per Agent, because one Agent is one entity
  config: string | NativeHarnessConfig;        // path or the JSON object; the base of the effective config, every start
  home?: string;                               // the harness home, a path in the harness's environment
  command?: string[];                          // how to start `harness serve --stdio`; defaults to the package bin
  launcher?: ProcessLauncher;                  // else conversationDefaults.launcher
  idleStopMs?: number;                         // stop the process after this long idle; off by default
}
```

The harness itself is configured on the `Agent`, not on the adapter: two native adapters with different harness
configs would be two entities in one `Agent`. Native adapters differ only in channel defaults.

`AgentConfig.adapters` takes `AgentAdapter`; the registry stores either and validates each with its own rules. A
conversation's controller is chosen by the adapter's type. Existing code passing `Adapter` keeps working unchanged.

### The `NativeController`

> **2026-11-21:** built as `src/native/controller.ts`. Differences: `startFresh` unsupported (`freshContext: false`); `abandonTurn` doesn't interrupt; the `capabilities` getter change wasn't made. See State after implementation.

Implements the `ConversationController` interface (`11-11-SPEC-controller-interface.md`) over the harness client:

| Controller member | Native |
| --- | --- |
| `start` / `startFresh` | cheap: attach the conversation to its channel **without** starting the process (Process lifecycle). `startFresh` also marks the channel for a reset, applied as a channel change. Result: `{ sessionId: <the Agent's id>, resumed }`, where `resumed` comes from acp-client's own records (true when the conversation has had turns), so the harness isn't needed for it. `isConnected` is true unless the host is in the failed state |
| `send` | push each message as an item on the channel (its id is the message id), with sender, policy and a delivery hint; resolves when the harness has stored it durably, which ends the message's queue operation; a push that gets no answer waits like any request to the running harness (A harness that doesn't answer, below), and after a restart is sent again with the same id, which is safe (the harness ignores a repeat); promises no turn |
| `subscribeTurns` | the harness's `turn_started` (with the items it took) and `turn_took` (items folded into a turn already running); never an end of turn (the end is the prepared turn's `prompt()`) |
| `prepareTurn` | a prepared turn whose `prompt()` replays the turn's held output, usage and supervision signals, then streams the rest into the session's handlers and resolves at the harness's end of turn; ignores the content's input (the harness built the context) |
| `abandonTurn` | drops what is held for the turn; interrupts the channel's turn if it is still running |
| `cancel` | `channel/interrupt` for the channel's running turn |
| `forceStop` | interrupts the channel and gives up on its turn locally: open prepared turns reject. Never stops the shared process; only the host restarts it, on a crash, or the consumer through `agent.harness.restart()` |
| `stop` | the conversation is done with its channel for now; the process keeps running for the others |
| `subscribeOutput` | supervision signals only, as for ACP (the stream goes to the turn's handlers). The harness's `progress` events feed stall detection by stage, as today's activity does: `model` counts as output; `tool` counts as a tool running (the tool-time limit still applies); `waiting` doesn't reset the clock. So a long silent turn stays alive, and a turn stuck waiting is still judged stalled (to be checked in the robustness tests) |
| `configOptions` / `setConfig` | model, reasoning, temperature as `ConfigOption`s, known before start from the stored config and `describe`; `setConfig` stores the channel's settings and sends them (Channel changes, below) |
| `subscribeUsageUpdate` | usage events, one per model call, with their purpose |
| `conversationCapabilities` | `nativeSteering: true`; `backend` filled from the config at once (the model's media; no load, fork or session listing); the optional methods (modes, bridge, reconnect, authenticate, `listSessions`, `prepareInternalPrompt`) are absent |

- **The internal event model stays.** Messages, tool calls, usage and permissions cover the native side; the record
  kind `protocol` is generic enough for model-call details.
- **Stale supervision fits unchanged,** per turn: each prepared turn carries its own output signals and cancel, so
  supervising a held turn never sees or cancels the next one (`supervisedPrompt`, `src/agent-session.ts:4037`;
  controller-interface spec).
- **Native conversations are `Agent`-only** (no detached `AgentSession`, no `SessionManager`).
- **Breaking change in stage 2a:** the public `capabilities` getter (the raw ACP shape) becomes `Capabilities | null`,
  `null` for native conversations; consumers read `conversationCapabilities` for both.

### Process lifecycle

> **2026-11-21:** built in `src/native/host.ts`, with a 30 s startup deadline and a 30 s request timeout instead of the cancellable waits and `harness_unresponsive` below, and recovery from the harness's revisioned load view instead of the watermark and item-status design. `agent.harness.start/stop/state` as named here weren't built (`agent.nativeHarness`). See State after implementation.

The process is what costs (and, isolated, a container per agent); channels are cheap and always exist.

- **Opening a conversation starts nothing.** Today opening or creating any `Agent` conversation starts its provider:
  `AgentConversation.create` calls `session.start()`, which calls `controller.start()` (`src/agent-session.ts:867`,
  `:1093`; `src/agent/conversation-manager.ts:892`). For native, `start` only attaches the conversation to its
  channel, so opening or creating a native conversation never starts a process or a container.
- **Started lazily, on the first real need:** a message's `send`, an item pushed by the orchestrator or the consumer,
  an operation that needs the harness such as export. Starting happens inside that operation (the conversation is
  busy meanwhile, as when an ACP provider connects); start progress behaves as for ACP. `agent.harness.start()`
  starts it ahead of time for consumers who want to.
- **Started once, and owned by the host:** several conversations, the orchestrator or the consumer may need the
  process at the same moment; the host starts it once and the others wait for that start. A conversation owns only its
  wait: its `stop()` or close withdraws that wait (`ConnectionCancelledError`) and the start goes on for the others.
  The start itself is cancelled only by closing the `Agent` or by `agent.harness.stop()`, which cancels a start in
  progress, rejects every waiter and stops a running process. `agent.harness.state` (`stopped`, `starting` since a
  time, `running`, `failed`) lets a consumer's watchdog decide, since a start has no automatic time limit.
- **A harness that doesn't answer** (a push, a withdraw, a `channel/update`, any request to the running process): the
  request keeps waiting, cancellable by the waiting conversation's `stop()` or `forceStop`. After 30 s with no answer
  the host raises `harness_unresponsive` on the `Agent` and on the waiting conversations, cleared when the harness
  answers. Nothing restarts or fails automatically: a false alarm (a slow disk, a busy machine) would otherwise kill
  every channel's running turn. The consumer decides: wait, stop the conversation, or `agent.harness.restart()`;
  after a restart, pending requests are sent again with the same id and reconciliation says what the harness has.
- **`isBusy` and the queue are unchanged.** A native conversation is busy exactly while acp-client runs an operation
  for it, as with ACP: a turn being run and recorded (the first one also starts the process), an exclusive operation.
  A turn the harness starts on its own makes it busy while that turn runs, which is real activity. Nothing else (a
  stored setting, a report, the process running) makes a conversation busy, so idle eviction stays the consumer's
  concern, as today.
- **Optionally stopped when idle:** `harness.idleStopMs` (off by default). Idle means both sides agree: acp-client
  has no turn running or held, no pending permission request and no channel held, and the harness, asked before the
  stop (`session/idle`), has no turn running and nothing in its inboxes. The next activity starts it again (started
  once, as above, also when it races the stop). The harness home must be durable for this (no sync in v1; the
  consumer mounts it).
- **Stopped with the `Agent`.** Not when its last native conversation closes.
- **Reconciliation at every start.** `session/load` carries `since`: a position, not a time (clocks differ across
  containers). The harness numbers every turn with a session-wide position, assigned when the turn starts.
  acp-client stores a **contiguous watermark**: the highest position W such that every turn up to W is finished
  (in the `channels?` repository, Code plan), and sends it. Not "the highest finished": turns on different channels finish
  out of order, and a turn still being recorded must not fall below `since`. A long-running turn holds W back, so a
  restart may return turns already finished; harmless, since finishing is keyed by turn id. With no stored position (a fresh
  database), acp-client takes the harness's current position without reconciling: nothing of its own is pending.
  `session/load` returns each channel's turns after that position and its waiting items, and **the status of every
  item acp-client asks about**: acp-client sends the ids of its messages not yet settled (including those written but
  not yet acknowledged, below), and the harness answers each `waiting`, `taken` (with its turn), `dropped`,
  `withdrawn` or `unknown`. So a message dropped by an interrupt just before a crash settles cancelled, and a message
  the harness never stored fails, instead of either staying pending forever. Messages placed on a channel outside a
  turn (`message_participant`, stage 2b) carry positions in the same sequence and are returned after `since` too.
  acp-client compares them with its records and
  settles what it missed around a crash. **A turn that ended without acp-client finishing it goes through the normal
  turn path,** not a separate finishing step: if its prepared turn is still pending (only the harness crashed), its
  `prompt()` resolves from the turn record (the final assistant message, the remaining usage), and the session
  records, meters and completes it as if the end had arrived live; if nothing is pending (acp-client itself crashed),
  the `NativeController` reports the ended turn as `turn_started`, with the record as its cause, and a prepared turn
  whose `prompt()` replays the record, which the session runs like any harness-started turn. The session recognizes a
  turn id that already has records (in-progress ones written before a crash) and adds only what is missing, so running
  it twice does nothing and nothing is rewritten; its prompts settle. A turn `running_at_crash` settles as failed; a
  message still waiting stays pending (it will be taken). Fallback if replaying the record proves hard: fail the turn,
  but still write its metering from the record, so its cost is never lost. This is how state events stay reliable without acknowledging each
  one (protocol spec, Delivery).
- **Restarts on a crash:** bounded (3 within 60 s, with a pause between). **A crash alone settles nothing:** the
  harness may have ended a turn just before crashing, without its end reaching acp-client. Running turns stay pending
  through the restart (native supervision disables the client stall clock), and reconciliation gives each its outcome: ended → finished from its
  turn record; `running_at_crash` → failed (a message it had taken settles as failed). So a prompt settles once, from
  the turn's end or from reconciliation. A turn the consumer gave up on locally during the restart (`forceStop`, its
  prompt already rejected) is still recorded if reconciliation reports it ended (its messages and metering), but its
  prompt stays as settled. A message still waiting in the harness inbox survives the restart and is taken afterwards. When the retries run out the host is failed: pending turns fail, and native conversations'
  operations fail with `HarnessUnavailableError` until `agent.harness.restart()`. The consumer's way out during a
  restart that hangs is `forceStop` or `stop`, as for any cancellable wait.
- **Turns for conversations not loaded:** when the harness reports a turn on a channel whose conversation acp-client
  hasn't loaded in this process, acp-client loads it from persistence and records the turn there.
- **No background work in v1:** a stopped harness never needs to wake itself. Waking it, and a harness that starts
  cheaply and loads lazily, are in `../harness/todos/11-12-TODO-background-work-and-lazy-harness.md`.

### Lazy start for ACP conversations too

The same decoupling, as an option for ACP conversations: `conversationDefaults.providerStart: "on_open" |
"on_first_use"` (default `"on_open"`, today's behaviour; also settable per conversation at creation).

- **How:** with `"on_first_use"`, an `Agent` conversation's `start()` skips `controller.start()` and leaves the
  provider unconnected; the first operation's `ensureProvider()` (`src/agent-session.ts:3911`), which already
  reloads the recorded provider session or starts a fresh one, with continuation from acp-client's records when
  reloading fails, does the rest. The lazy path exists today for reconnects; this uses it on the first operation.
- **What changes for a consumer that opts in** (inherent to ACP: only the running harness knows these): model options
  and commands are empty until the first operation; the ACP `capabilities` getter throws until then; a settings
  change before the first prompt starts the provider (the settings operation calls `ensureProvider` first); errors
  found at open today (a bad command, authentication needed) appear at the first operation instead.
- **Only `Agent` conversations.** The managed path (`SessionManager`, which agents-core uses) keeps starting on open.
- **Adoption is unaffected:** it lists and replays provider sessions with its own client (`src/agent/adoption/`), and
  its follow-up summary goes through `ensureProvider`. Adoption stays ACP-only (the controller-interface spec gates
  it); for native conversations it doesn't exist. Importing an ACP session's history into a native channel (like a
  handoff into native) is a possible later feature, not v1.

### Cancellable connect (ACP and native)

> **2026-11-21:** the native part is replaced by the startup deadline; the ACP part is brief R4.

**The problem.** Bringing a provider up means creating its client, then waiting for the harness to answer the
handshake and the session (new or load), inside `bringUp` (`src/controller.ts:551`). Only when both answer is the
client stored as the controller's `current`. While those answers are pending, nothing `stop()` can reach holds the
client: `stop()` only stops `current`. A harness that never answers leaves the attempt waiting forever, the
conversation's queue behind it (later prompts, settings changes), and the harness process running, orphaned. Every
path that connects goes through `bringUp`: `start`, `startFresh`, `reconnect` (line 168), `setMode` (line 360) and
handoff targets. Today's behaviour, accepted for the controller-interface work; fixed here, because native's start
must be cancellable the same way.

**How it relates to stale detection.** The operation supervisor watches an operation already running (a turn, a recap,
an internal inference), from the moment the prompt goes to a connected provider; a stall cancels, waits the grace,
then force-stops, which works because the client is `current` by then. Connecting happens before that: the queue calls
`ensureProvider()` (`src/agent-session.ts:2283`) and only then runs the turn under the supervisor. So a harness that
never answers while connecting is outside stale detection, and even a supervisor's `forceStop` couldn't reach the
client being brought up. The two are complementary: stale detection gives up on a silent turn; this section makes a
connection attempt possible to give up on at all.

**The fix:**

- **The attempt is reachable:** the controller stores the attempt as soon as its client is created
  (`connecting = { client, cancelled }`).
- **`stop()` cancels it:** it marks the attempt cancelled and stops its client with the existing bounded teardown
  (SIGTERM, 500 ms, SIGKILL; `src/transport/acp-transport.ts:144`). Repeated `stop` calls are harmless.
- **The pending calls fail promptly:** the handshake and session calls are raced against the transport's "connection
  closed" signal (`acp-transport.ts:60`), so they fail as soon as the process is gone, whether or not the ACP library
  fails its own pending request.
- **A late answer can't install itself:** before installing a client, every path checks whether its attempt was
  cancelled or superseded; a cancelled attempt never installs and never emits `provider_reconnected`.
- **One attempt at a time:** a new attempt first cancels, or waits for, the previous one, so two connections never
  overlap.
- **A distinct error:** callers get `ConnectionCancelledError` (not a provider error); queued operations settle once,
  cleanly, and the conversation is free again; late rejections are observed, never left unhandled.
- **No automatic time limit,** for ACP or native (decided 2026-11-13). The library doesn't decide when a connection
  is too slow: cutting off a slow but working harness (a first-run download, a long session load, a cold container)
  is a risk, and connects hanging hasn't been seen in practice. A stuck connect waits until someone calls `stop()` or
  closes the conversation, which now cancels it cleanly. A consumer that wants a watchdog writes one (for example,
  stop a conversation that has been connecting for ten minutes), using the start progress events and `stop()`.

**To verify while building it:** whether the ACP library fails a pending request when the process dies (the race
covers it either way); and that killing a `docker exec` client may not stop the process inside a container, a
launcher concern that already exists for stopping a running conversation.

**Tests,** with an offline fixture agent that never answers the handshake, or never answers the session load: `stop()`
during each; a late answer after cancel; repeated `stop`; a failed reconnect; prompts queued behind a stuck connect
settling with the cancel error; a harness that ignores SIGTERM; every connecting path
(`start`, `startFresh`, `reconnect`, `setMode`, a handoff target).

### Configuration known before start

> **2026-11-21:** not built. The harness manages its own config (decision 0016) and validates it with `config/validate`; acp-client keeps no override store and no `describe()`. Revisit only if a consumer needs options before start.

With ACP, models and commands exist only inside the running harness, so a consumer must start it to learn them and
handle "initialized or not". With native the config is ours, so acp-client knows it without starting anything, and a
native conversation always looks ready.

- **acp-client stores the config:** the `Agent` config's `harness.config` is the starting point; changes through
  `agent.harness.updateConfig(patch)` are stored as overrides on top of it (`agent.harness.resetConfig()` drops them);
  `agent.harness.config()` reads the effective config. The effective config is sent each time the harness starts, and
  an update while it runs is also sent at once (`config/update`). Your code's config stays the base: a later change
  to it applies, under the stored overrides.
- **Channel settings** set through `setConfig` (model, reasoning, temperature) are stored per conversation and sent
  as channel changes (below). A config update or a channel setting sent while a turn runs applies from its next model
  call.
- **Models and reasoning options** come from the config, which lists the allowed models with what each supports
  (`../harness/11-11-SPEC-harness-v1.md`, Configuration).
- **Commands, capabilities, policy names and validation** come from `describe(config) → { configOptions, commands,
  capabilities, policies, errors }`, a pure function the harness exports (`src/native-harness/client.ts`). It runs in acp-client's process and launches
  nothing, so a bad config fails before any container starts.
- **The live description wins after start:** the protocol's version check at start catches a harness version that
  differs from the installed package; the running harness's own description then replaces the static one, and a
  change is emitted if they differ.
- **Cost:** the first message after a cold start waits for the process (and container) to start; consumers show
  progress through the start events.

### Subscriptions

> **2026-11-21:** built as the harness's `final` (default) or `stream` text and none, summary or full tool events. The `streaming` conversation option and the union with persistence weren't built.

The harness sends only what acp-client asks for (`../11-12-SPEC-harness-protocol.md`, Decisions 2). acp-client
subscribes each channel to **the union of what it persists and what the conversation's consumer wants**:

- **What the consumer wants:** a conversation option, `streaming: "stream" | "final"` (default `"stream"`, today's
  behaviour), with a default in `conversationDefaults`. With `"final"`, the conversation's events carry only complete
  assistant messages, no text deltas. For ACP conversations the option filters the events the consumer gets (an ACP
  harness sends everything regardless); for native it also reduces what crosses the wire.
- **Usage is always per model call for native,** whatever else is subscribed: metering needs each call.
- **What acp-client persists:** from the persistence policy. Persisting only chats needs `final` text and no tool or
  reasoning detail; persisting activity needs tool calls and reasoning at the matching level.
- **Always received,** whatever the subscription: turn boundaries, `message_completed` (the source of truth for the
  assistant record; deltas are a convenience), usage (per call, for metering), `progress` (liveness for stall
  detection), dropped messages and permission requests.
- **Changing it:** when the consumer's option or the persistence policy changes, acp-client sends the new subscription
  with `channel/update`; it applies at once.

### Channel changes

> **2026-11-21:** built (decision 0020, `changeId` versions). What remains is making the intents durable (Durable channel intents, below).

A channel's policy, label and settings, and its deletion, can change while the harness is stopped. They must be in
force before the harness runs any turn on that channel.

- **acp-client is the truth:** it stores each conversation's current policy, title and settings.
- **While the harness runs,** a change is sent at once (`channel/update`, carrying whatever changed: policy, label,
  settings, a reset, or `closed` for a delete).
- **While it is stopped,** the conversation is marked as having pending changes (a pending flag in the conversation's channel
  state). This is a queue of changes, coalesced: only the latest value of each field is sent, however many
  times it changed.
- **At start, the pending changes go inside the start call itself** (`session/load`, or `session/create` the first
  time): the harness applies them before it can start any turn, so no message or waiting item can run under an old
  policy. When the harness confirms, a conversation's flag is cleared **only if its stored state is still what was
  sent**; a change made while the start call was in flight keeps the flag and is sent at once with `channel/update`,
  since the harness is running by then. A reset resent after a crash is harmless (nothing ran on the channel in
  between), so it needs no id. Deleting a conversation while stopped closes its channel at
  that start, so a delete never starts a container on its own. A reset requested while stopped (`startFresh`) is a
  pending change too. In stage 2b, registering an ACP conversation as a member while the harness is stopped goes the
  same way.

### Durable channel intents

Decided 2026-11-21 (brief R1). **The gap:** the host keeps each channel's newest unconfirmed change in
acp-client's memory by default (`src/native/records.ts`; a file store exists only if configured), and
`ConversationManager.delete()` asks the host to retire the channel, then deletes the conversation from persistence
separately. If acp-client restarts before the next harness open (a deploy, a crash), the intent is gone: a
conversation deleted while the harness was stopped is gone from acp-client but its channel stays alive in the
harness, where a later turn can run on a channel nobody sees. A suspension or rename is lost the same way. A
separate file store wouldn't close it: the delete and the intent would still be two writes in two places.

**The rule:** a native conversation's change and its channel intent commit in **one acp-client transaction**, and
the host delivers durable intents through its existing path. No harness protocol change.

1. **A transaction-scoped channel repository:** an optional `channels?` repository on the persistence scope with a
   `capabilities.channels` flag (the pattern of `identity?`; `src/persistence/backend.ts`), holding per channel its
   id, the latest desired change (name, policy, lifecycle: open, suspended, retired) and a version. SQLite first;
   a schema version bump with an upgrade test on a database from the previous version. All intents go through it
   from the start, not only deletions.
2. **The delete and the intent together:** for a native conversation, `delete()` marks it deleted and records
   `{ lifecycle: "retired" }` in the same transaction; once committed, the conversation can disappear from the UI.
   With the harness stopped, the intent waits; with it running, the host applies it after the commit through the
   live channel API.
3. **Delivery reused:** at startup the host reads the durable intents and sends them with the open batch, as it
   does with the in-memory records today; it clears only the version the harness confirms. A blocked retirement
   (pending work or a checkpoint) stays pending and is reported as blocked.
4. **Tests of a real acp-client restart:** delete while the harness is down, restart acp-client, start the harness
   and check the channel is retired before it can take work; and a crash after the harness applied the retirement
   but before acp-client cleared the intent (resending is safe: retiring a retired id counts as applied).

**A backend without the repository** keeps today's behaviour (the in-memory host records) and the limitation is
documented; native isn't refused on it.

**Boundaries, accepted:** this makes an offline change durable and eventually applied. A harness that is already
running, or past its startup cutoff, can take work before the retirement arrives (the live delete then suspends a
busy channel and reports `channel_busy`); an immediate stop would need coordination like the dropped holds. Message
submissions don't survive an acp-client restart yet: whether to resend a message saved and never sent is a
different promise to the user, and a follow-up (Limitations).

### agents-core

agents-core runs on `SessionManager` and `AgentSession` (the managed path), not `Agent`. Native conversations and the
orchestrator are `Agent`-only by design, so agents-core gets them only after it moves to `Agent`. Its pinned 0.10.2
is unaffected.

### Turns the harness starts

> **2026-11-21:** built, with channel suspension instead of holds for exclusive operations, and approvals through the first message's handlers. Native admission and held usage below still apply; holds don't exist.

The harness decides when a native channel runs a turn: because of a message, a worker reply pushed by the
orchestrator, another channel (`trigger_response`), later its own background work. It reports each turn (`turn
started`, with the items it took, then the stream, then the end). The `NativeController` reports it as
`turn_started` with its cause (`11-11-SPEC-controller-interface.md`), and `AgentSession` runs it like any turn: it
records, meters and supervises it through `prepareTurn`, and emits it on the conversation's turn events. acp-client never schedules a native turn and the
harness never asks it for permission to run one (overview, decision 41). Exclusive operations hold the channel first
(below). The library enforces no spending limit (none exists today either); it measures every call (Billing-grade
metering), and a cap is deferred (`todos/11-13-TODO-spending-cap.md`).

- **A prompt's promise resolves with the turn that took its message.** The harness reports which items each turn took:
  at its start (`turn_started`), and as it folds more in (`turn_took`). A message folded into a running turn settles
  with that turn's result.
- **Steer or queue, through the existing system.** acp-client's queue and steering work as today. A steer message
  that arrives during a turn would normally make the steering controller cancel the turn and resend; for native the
  steering host pushes it to the harness instead (`delivery: "steer"`), which folds it into the running turn at its
  next model call; `message_delivered` is emitted when the harness reports that it took it (`turn_took`). Queued (non-steer) messages wait in acp-client's queue as today and are pushed when the queue
  reaches them (`delivery: "queue"`), which starts a turn. Items other than messages get a default per kind, set in
  the harness. The consumer sees the same meaning as with ACP. Pushing queued messages to the harness earlier, so they
  are durable sooner, is an option for later.
- **Interrupt and the harness inbox.** What an interrupt does to items waiting in the channel's inbox is the
  harness's decision (harness v1); when it drops messages it reports them (`messages_dropped { ids }`), and acp-client
  settles their prompts with the cancelled result, as for ACP.
- **Withdraw** of a message the harness already accepted asks the harness to remove it from the inbox; it succeeds
  only if the harness confirms the message wasn't taken yet. With no answer it waits like any request (A harness that
  doesn't answer); it never guesses. Withdraw is local only while the push **hasn't been sent**; once sent (even
  before its acknowledgement) it goes through the harness. Concurrent server dispatch can return `not_found`
  before the push is stored. That reply leaves withdrawal unresolved. If the harness reports `taken`, the
  prompt follows the turn.
- **Exclusive operations hold the channel first:** handing the conversation off out of native, stopping it, deleting
  it, and resetting it (a cleared transcript). Handoff out and reset wait for a running turn to end; stop and delete
  interrupt it. `setPolicy` and `setConfig` are not exclusive: they apply from the next item or model call. Every
  such operation must hold, and stage 2a tests each one. A hold is a **lease** (Nothing waits forever, below).
- **Native admission** (what the session's pre-turn checks mean when the harness already started the turn; overview,
  decision 41; controller-interface spec, Appendix A):
  - the metering preflight (which checks that usage can be measured, not money) is checked when the harness starts,
    not per turn: under `billing_required` an unconfirmed harness doesn't start (Billing-grade metering), so a turn
    the harness starts never meets a failing preflight;
  - a settings change applies from the next model call; it doesn't hold the channel;
  - **a persistence failure never holds anything.** A failed write is surfaced (an error event on the conversation,
    logged), the turn is recorded as far as possible ("completed by the backend, recording failed"), and the agent
    keeps working. acp-client's records may then have gaps while the harness's context stays complete (the two logs
    disagree, an accepted limitation; controller-interface spec, Appendix A). Holding until persistence recovers was
    rejected: if nothing writes again, nothing releases, and the agent is stuck;
  - acknowledged turns (the harness waiting for acp-client to finish recording before the next turn) are not adopted
    in v1.
- **Usage and supervision signals of a held turn** are held with its output and filed when the session runs the turn,
  under that turn's metering.
- Turns the harness starts carry no prompt handler; permissions reach the user as events instead (Permissions,
  below).

### Nothing waits forever

> **2026-11-21:** the native rows are now: startup, a 30 s deadline; requests to the harness, a 30 s timeout; approvals, the harness's 10 minutes (acp-client's 5 inside it once brief R3 lands); no holds. The ACP connect row stands until brief R4.

Anything that makes a channel or the agent wait must be bounded **or cancellable**, and a new wait must name which,
here. A stuck agent is a real failure, not a minor one. Cancellable means a call the consumer controls (`stop()`,
closing the conversation) ends the wait cleanly; the library adds automatic time limits only where the limit can't
cut off legitimate work.

| What waits | Its bound |
| --- | --- |
| A hold (exclusive operation) | a lease: it expires on its own after a set time (default 60 s) unless acp-client renews it while the operation runs; released when acp-client disconnects or the process restarts; acp-client releases it when the operation ends, success or failure |
| Starting the process (native) | cancellable: a conversation's `stop()` or close withdraws its own wait; closing the `Agent` or `agent.harness.stop()` cancels the start itself (Cancellable connect); no automatic time limit; the next activity tries again |
| A request to the running harness (push, withdraw, `channel/update`, …) | cancellable by the waiting conversation; `harness_unresponsive` raised after 30 s; no automatic restart or failure |
| A turn running when the harness crashed | the bounded restarts, then reconciliation settles it (or the failed state fails it); cancellable by `forceStop` or `stop` |
| Connecting an ACP provider | cancellable the same way; no automatic time limit (Cancellable connect) |
| A crashed process | bounded restarts, then the failed state with an explicit error, never a silent wait |
| A permission consumer wait | acp-client's `permissionTimeoutMs` (5 min, counted from client receipt), then refused. Native approvals also have the harness's ten-minute backstop |
| A held turn | only behind operations that are themselves bounded |
| An idle stop | only when both sides agree there is no work; never cuts off a turn |
| A persistence failure | waits for nothing: surfaced and recorded as far as possible |
| A withdraw through the harness | as any request to the running harness (above); never guessed |

### Robustness

Errors around persistence and message delivery exist today and will exist here. The model above is a first version,
made robust afterwards by an extensive end-to-end stress test across the library and the harness, in its own spec:
`../11-12-SPEC-end-to-end-robustness.md`, run once everything is built.

### Permissions

> **2026-11-21:** native approvals are built as `approval_requested` and `approval/respond` (`allow_once`, `deny`), routed to the first message's handlers. The ACP-side setting, the matcher and permissions as conversation events are brief R2 and 3; the harness's own policies are a `fallback` plus exact tool names, not the `kind:`/`command:` rules (those are acp-client's, for ACP requests and workers).

Before R3, a conversation answered permission requests with its prompt callback or the configured policy. The
conversation now also emits the request and its resolution. Agent-owned permission records retain their requested
and resolved shape.

```
harness: "may I send_email?"  →  acp-client  →  event: permission_requested { id, turnId, tool, title, options }
user answers                  →  conversation.answerPermission(id, optionId)  →  acp-client  →  harness continues
```

- **The request is an event** on the conversation, for every turn (prompted or started by the harness). Native: the
  harness's gate decides `ask` and sends `approval_requested` over the protocol; ACP: the harness's
  `session/request_permission`, as today.
- **The answer is a method,** `conversation.answerPermission(id, optionId)`, callable at any time while the request is
  open for a consumer answer. Await it for `{ accepted }`. A closed ID or an option outside the offered list
  returns false.
- **Every request closes with an event:** `permission_resolved { id, outcome, by }`, `by` being handler, consumer,
  default, timeout or `turn_ended`, so a UI can close its dialog. `turn_ended` means the turn's lifecycle
  closed the request, including force stop or conversation stop. Native host responder answers count as handler
  answers. The conversation emits the resolution in a microtask after closing the request,
  after all request listeners have been notified. Request events carry `expiresAt` only while routing
  to a consumer wait. When a local close leaves an unanswered native gate open, the conversation sends
  a denial. The configured host responder retains authority when only the conversation observer detaches.
- **The per-prompt handler stays as a shortcut:** if the running turn's prompt brought one, it is called and nothing
  waits on events (the request event is still emitted, and resolved `by: "handler"`). When a turn took several messages, the first message in its cause that brought a permission
  handler provides it, the rule steering's combined runs use today (`src/steering/combine.ts:23`). A message folded in
  mid-turn (`turn_took`) receives the rest of the turn's stream, but doesn't change its permission handler.
- **When nobody will answer:** a conversation says whether its consumer answers permissions (`answersPermissions:
  true` on `CreateAgentConversationConfig`, with a default in `conversationDefaults`). If so, acp-client waits up to
  `permissionTimeoutMs` (default 5 minutes), then refuses with `by: "timeout"`. An ask with no handler and no
  declared consumer is refused immediately with `by: "default"`, including when a rule selected ask over
  default allow. The consumer wait starts at ACP client or native host receipt. Native observations use the
  first receipt of the request ID on that host, which is preserved on replay. Prompt handlers keep their
  existing lifetime. The native harness has its own ten-minute timeout, including for the host responder.
- **A request in a held turn waits with the turn** (it reaches the consumer when the session runs the turn). For
  native the wait is short in practice: only while another operation on that conversation runs, and the long ones
  hold the channel first. **Known risk, open to change:** if waits turn out long (slow persistence, an operation we
  didn't anticipate), permission requests would bypass the wait and go out at once.
- **Forwarded worker requests** at Ask me arrive the same way: as `permission_requested` on the conversation that gave
  the work (marked with the worker), answered with the same method (`11-11-SPEC-orchestrator.md`, Permissions).
- **Records** are unchanged: requested and resolved, with the outcome.
- **One permission setting, everywhere.** The harness's policies use `permissions: { default, rules }` (rules by
  pattern; levels deny, ask, ask the agent, allow; `../harness/11-11-SPEC-harness-v1.md`, Policies). acp-client's own
  ACP conversations use the same shape, replacing today's `defaultPermission: "approve" | "cancel"` (a breaking
  change): `"approve"` becomes `default: "allow"`, `"cancel"` becomes `default: "ask"`. Omission defaults to ask. Ask the agent doesn't apply
  there (no agent above an ACP conversation).
- **Matching an ACP request.** An ACP permission request (`src/types.ts:245`) has no stable tool name: a tool call
  id, a free-text title, its options, and in the raw request the tool call's kind (read, edit, delete, move, search,
  execute, fetch, other) and raw input. Rules match two fields only:
  - `kind:<acp kind>`, for example `kind:read`;
  - `command:<exact command>` for execute requests, matched **exactly** after normalization (unwrapping
    `bash -lc "…"`, joining argument lists), never as a substring or prefix.

  When several rules match, the most restrictive level wins; when none matches, `default` applies. A command that
  can't be normalized matches no `command:` rule. Allow picks the request's `allow_once` option, falling back to
  `allow_always` only when there is no `allow_once`, as today (`rules/11-13-RULES-permission-auto-approve.md`: the
  fallback leaves a lasting grant in the harness, an escalation documented and kept). Deny picks `reject_once`
  when offered and cancels otherwise. Allow and deny are final. Ask goes to the prompt handler or, in R3, the
  event. An unattended ask uses the deny selection. Native asks use `permissionRule` and the default
  without ACP rule matching. A default of allow therefore approves native asks. Titles aren't matched, and MCP tools over ACP (kind `other`) can't be targeted yet.
- **The same matcher serves the orchestrator:** workers are ACP harnesses, so the policy's `worker:` rules are these
  rules with a prefix (`worker:command:bun test`, `worker:kind:read`). One matcher, tested per adapter's raw input
  shape, used in both places.
- **An optional function** for consumers who want more: `permissionRule(request) => level | undefined` in
  `conversationDefaults`, consulted before ACP rule matching and before the default on native requests.
  `undefined` means no opinion. Native supplies `tool.name` and the original argument string as
  `tool.rawInput`. The callback's return level is validated. Worker rules live in the harness's JSON config.

### Messages from another channel

When the agent, in one channel, uses `message_participant` on another, the harness reports a message on the target
channel outside any turn. acp-client records it on that conversation as an assistant message appended without a turn
(the existing shape of `appendAssistantMessage`, origin `out_of_band`), marked with the channel it came from, and emits
it on that conversation's events so the consumer shows it to that channel's user. `trigger_response` needs nothing
new: the target channel takes a turn of its own, reported like any harness-started turn. In v1 only native channels
of the same session are targets; ACP conversations can become targets as members in phase 2.

## Two logs of one native conversation

The harness keeps the context the model sees, in its store and format. The library keeps its records as an
observation and audit log, as for ACP. The library never rebuilds a native context from its records (continuation,
recovery and adoption are gated off by capability).

## Usage

Exact: each model call reports input, output and cached tokens (cost where the provider reports it), normalized by the
harness's model client, with a **purpose** (`turn`, `compaction`, later others), the channel and the running turn if
any. acp-client files each call by where it happened, not by its purpose:

- **inside a turn:** part of that turn's operation metering on the conversation, tagged with its purpose (compaction
  mid-turn is part of the turn's cost);
- **no turn running, on a channel** (compaction between turns): the metering engine's existing unallocated usage for
  that conversation (`InferenceSource.drainForeign`, `src/metering/engine.ts`);
- **no turn and no channel** (entity-level background work, later): an entity-level record in `agent_metering_records`
  (already used for internal inference without a conversation, `beginInternalInferenceMetering`), with the purpose as
  its kind.

A new kind of harness call needs only a new purpose name. The session also keeps its own usage ledger, for standalone
use. acp-client's own conversation summaries (checkpoints) stay acp-client's internal inference, now able to run on
the `http` runtime.

### Billing-grade metering

> **2026-11-21:** not built: usage isn't forwarded yet. The source is the harness's model-call records (`session/model-calls`), pulled, not pushed per call. brief R5.
> R5 adds persisted native metering evidence. Per-call usage events and native `TurnResult.usage` are deferred.
> The current wire supplies turn-owned calls. Between-turn accounting waits for a harness producer and
> a bounded pull and idle contract. R5 refuses native billing certification on the current wire.

The library knows native costs as precisely as it knows the certified OpenCode plugin's (decided 2026-11-13; this
brings the measurement part of `todos/11-12-TODO-billing-required-native.md` into stage 2a). A consumer enforces
limits outside, from the records and the per-call usage events; a cap enforced by the library is deferred
(`todos/11-13-TODO-spending-cap.md`).

- **An inference source fed by the harness's per-call usage,** implementing the existing `InferenceSource`
  interface (`src/metering/engine.ts:49`) as the OpenCode plugin's does (`src/metering/opencode/`): one inference per
  model call, with its tokens, its cost when the provider reports it (else priced by acp-client's catalog, as today)
  and its purpose. A tool-using turn's several calls are all counted.
- **Keyed per channel:** `drain` is keyed by the provider-session id, and every native conversation shares the
  `Agent`'s id, so the native source keys by `<Agent id>/<channel id>`, the id the neutral provider-session record
  already uses for native. One channel runs one turn at a time, and a held turn's usage reaches the source only when
  the session runs that turn, so at a turn's close the source holds only that turn's calls. No interface change;
  OpenCode untouched.
- **A certification entry,** `native-harness@1` in `src/metering/certification.ts`, whose supported versions are
  harness protocol versions; looked up by adapter **kind** (native adapter ids are the consumer's, e.g. `"main"`),
  not only by adapter id.
- **Checked at start, not per turn:** `billing_required` is checked statically at open (the installed harness
  package's version and `describe`) and confirmed at the start handshake. If the running harness can't confirm it,
  the start fails, so no turn (including one the harness would start on its own) can run unmetered.
- **Every call counted somewhere:** inside a turn, in that turn's metering; outside a turn, an entity-level record
  (Usage, above).

## The inbox

> **2026-11-21:** the record before the push is built as the host's input records (`src/native/records.ts`), in memory or a file; a native prompt's text isn't written as a user record yet (accepted).

A conversation's **inbox** is what waits to reach the agent in that conversation, other than the host's own prompt
calls: worker replies, failures, redirects, permission requests, items the consumer pushes. Where it lives depends
on who runs the conversation's loop:

- **Native conversations: the harness's.** An item is pushed onto the conversation's channel; the harness keeps it in
  that channel's inbox in its own store (so it survives a restart), starts a turn if the channel is idle, or puts it
  into the context at the next model call. acp-client stores nothing for items; the turn that takes one is recorded
  like any turn.
- **A native user message is recorded before it is pushed,** keyed by the message id (not by a turn), marked "not
  yet accepted", and confirmed when the harness acknowledges it; durable from then on; the turn that takes it links to
  it through its cause. Writing first closes the gap where the harness has stored a message and acp-client crashed
  before recording it: after the crash, reconciliation asks about unconfirmed messages (known to the harness →
  accepted; `unknown` → never stored, the message fails). So native messages don't share ACP's
  "durable only once its turn starts" (`findings/11-12-FINDING-acp-message-durability.md`), and `accepted` on the
  prompt handle resolves at that moment (for ACP, when queued).
- **ACP conversations: acp-client's out-of-band messages,** as today (`src/out-of-band-messages.ts`: records with
  `origin: out_of_band` plus the `out_of_band_delivery` cursor), delivered into the next prompt. ACP harnesses can't
  be woken by an item; a wake needs a prompt the consumer allows (later). For these, out-of-band records gain a kind
  and a sender in their metadata.
- **Live prompts and steering** go through the conversation's queue (`AgentConversationQueue`) and the steering
  controller (`src/steering/controller.ts`), as today.
- **Item kinds:** `worker_reply`, `worker_failed`, `worker_redirected`, `worker_interrupted`, `permission_request`
  (only a worker's request forwarded at the ask-the-agent level; requests for the user are events, Permissions
  above), consumer kinds. The harness renders each kind.
- **Native steering:** the steering controller cancels a running turn through `SteeringHost.cancelProviderTurn`. With
  `nativeSteering`, the native host pushes the steer item onto the channel instead; nothing is cancelled and
  `endedBy: "steer"` doesn't occur for native turns. Interrupt stays a separate action.
- **What comes out of a wake:** a turn the agent takes on its own produces events and records like any turn; it
  reaches a user only if the host delivers it.
- **The orchestrator's delivery port** is implemented on this.

## Identity becomes injection

The harness owns the entity (the timeline; harness design spec). How it keeps it doesn't matter to the library;
identity reaches ACP conversations by injection.

ACP conversations are **managed member channels** of the session (v1): registered when a harness is configured
(`member/register`, with the conversation's policy and title), their messages and summaries reported, and their
identity prepared by the harness. The harness's MCP server, through which members could read and write the identity
themselves, is phase 2.

**The existing interface already fits.** `AgentIdentityRuntime` (`src/identity.ts`):

| Method | Called | For the harness adapter |
| --- | --- | --- |
| `load(input)` | before every prompt, with participant and target provider context (`src/agent/persisted-lifecycle.ts:96`) | `member/prepare`: the digest since the member's position, as `promptPreamble`, plus a receipt |
| `update(input)` | after every committed batch of records (`src/agent/record-capture.ts:44`) | `report`: append the conversation's messages to the timeline |
| `delivered(receipt)` | once the provider has the prompt | `member/delivered`: advance the member's position |
| `synchronize` | optional | not needed |

So no new interface: `harnessIdentityRuntime(host)` implements `AgentIdentityRuntime`. Changes:

- **Native conversations are skipped** in `load` and `update` (the harness has them already).
- **With lazy start (stage 2b decision, recommended):** `update` reports lazily: acp-client keeps a report cursor per
  ACP conversation, and when the harness next starts it reports everything since, so saving records never starts the
  harness. `load` runs inside the prompt's own operation, as today, and starts the harness if needed (`prepare` needs
  it), adding start time to that prompt only. Neither changes `isBusy`.
- **While the harness runs,** each report is sent as its batch is committed. **Before `member/prepare`,** acp-client
  waits until every report already sent (from any ACP conversation of the `Agent`) is acknowledged, so a prompt's
  context reflects everything recorded before it in any conversation. Example: "my name is Bob" said in a Codex
  conversation is known to a Claude conversation prompted two seconds later. Part of the thinner identity's design,
  stage 2b.
- **MCP servers for members** are attached at session creation, not per prompt: a new optional
  `mcpServers(conversation)` on the runtime, read where `CreateAgentConversationConfig.mcpServers` is applied. Phase 2,
  with the harness's MCP server.
- **Summaries:** when the checkpoint coordinator (`src/checkpointing/coordinator.ts`) completes a checkpoint, the
  runtime reports it (`report(kind: "summary")`). A new optional `checkpointed(input)` hook on the runtime.
- **Receipts** change shape: `IdentityDeliveryReceipt` names source conversations and sequences; the harness's receipt
  is `{ member, context, through }`. Make the receipt opaque to the library (`unknown` carried back), which also
  retires `identity_delivery_cursors` for harness-backed identity.
- **Delivery is at least once:** a failed prompt is delivered again; a crash after the provider got it repeats a
  slice, harmlessly. acp-client stores nothing identity-related for harness-backed identity.
- **Deprecation.** With no harness, ACP conversations get no cross-conversation identity unless the consumer keeps
  `CheckpointBackedIdentityRuntime`, deprecated and removed in a breaking release.

## MCP for ACP conversations (phase 2)

The harness's MCP server (`./mcp-server`) gives ACP conversations identity tools as members, and later delegation
tools. One endpoint per member, scoped by a token. ACP requires stdio MCP; HTTP and SSE only where advertised (send
`mcpServers` only to agents that advertise them, as `68d7af0` did for `additionalDirectories`). With the harness in its
own process, a stdio bridge stub connects to it. Workers never get delegation tools by default. Approve the server's
tools by exact server and tool name.

## Configuration

```ts
new Agent({
  adapters: {
    main:   { kind: "native", defaultPolicy: "owner" },
    codex:  { command: ["codex-acp"] },                 // an Adapter, as today (or ADAPTERS.codex)
    claude: ADAPTERS.claude,
  },
  defaultAdapterId: "main",
  harness: { config: "./harness.json" },               // the entity; `home`, `command`, `launcher`, `idleStopMs` optional
  conversationDefaults: { launcher, cwd },             // as today; also starts the native harness
  persistence: { ... },
  functions: { crm_search: async (input) => { ... } }, // served to the harness for run.type "function" tools
  orchestrator: { workers: { adapterId: "codex", cwd: "/work", limit: 2 } },
  internalInference: {                                 // "http" when a model is configured, else "harness"
    runtime: "http",
    model: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", model: "..." },
  },
});
```

What the library provides to the harness, all through its protocol:

| The library | Through |
| --- | --- |
| Where the session lives | `harness.home` (a path in the harness's environment) |
| The configuration | the effective config (`harness.config` plus stored overrides), on every start and on each update |
| Function tools | callback `functions/call` for each name in `functions` |
| Workers for delegation | callback `delegation/*`, served by the orchestrator (its spec) |
| ACP transcripts for history tools | callback `history/*` over its records |
| Sender and policy | on each push (the message's sender and policy), plus each channel's stored policy; chosen by the consumer, never by the end user |

## Internal inference over HTTP

Checkpoints, summaries and recovery seeds are one prompt and one answer, today run in a disposable ACP session
(`src/internal-inference/runtime/harness-runtime.ts`, `disposable-session-env.ts`).

- **A new `http` runtime** implementing `InternalInferenceRuntime.run(request, signal, lifecycle)`: one model call,
  no process, structured output.
- **Its own minimal client.** Internal inference is one call with structured output: no tools, no streaming, no
  channels. acp-client keeps a small OpenAI-compatible client of its own for it instead of importing the harness's,
  so internal inference doesn't depend on the harness; the duplication is small. It runs in acp-client's process
  (internal inference is the library's own work, not the agent's), with its own model config and key
  (`internalInference.model`), since the harness's key lives in the harness's environment.
- **The lifecycle is ACP-shaped** (`stageChanged("creating_session" | "prompting")`, `sessionStarted({
  internalSessionId })`): the runtime reports `prompting` only and no session; records that expect an
  `internalSessionId` must accept none.
- Used when a valid key is configured; the disposable session stays as the fallback.

## Code plan

> **2026-11-21:** built so far: `src/native/host.ts`, `controller.ts`, `records.ts`. The rest of the list below is what the original plan named; Remaining work decides what gets built.

```
src/native/
  adapter.ts             NativeAdapter, AgentHarnessConfig, validation, AgentAdapter union helpers
  host.ts                NativeHarnessHost: one per Agent = one session; launches `harness serve`, holds the client,
                         restarts on crash, serves callbacks
  callbacks.ts           functions, history (→ records); routes `delegation/*` to the orchestrator (added by its spec)
  config-store.ts        stored config overrides; effective config; describe() for options, commands, capabilities
  lifecycle.ts           lazy start (started once), optional idle stop, bounded restart, failed state
  channel-changes.ts     pending channel changes (coalesced), sent at once or inside the start call
  native-controller.ts   ConversationController over the client; send ends at acceptance
  translate-events.ts    harness events → the agc update model
  steering-host.ts       native steering: push instead of cancel
  inbox-delivery.ts      pushing items onto native channels (the orchestrator's delivery port uses it)
  identity-runtime.ts    harnessIdentityRuntime (AgentIdentityRuntime)
  index.ts
src/permissions/matcher.ts   the ACP permission matcher (kind, exact normalized command), shared with the orchestrator
src/internal-inference/runtime/http-runtime.ts
src/internal-inference/runtime/openai-compatible.ts   the minimal client (one call, structured output, usage)
src/launcher.ts          AcpLauncher → ProcessLauncher (alias kept), kind "native-harness"
```

- **`src/native/` is the only place that imports the harness,** and only its entry points (`src/native-harness/`
  `index.ts`, `client.ts`, `testing.ts`); the harness never imports acp-client (harness project spec, Layout and
  Dependency rules). The acp-client core depends on contracts
  (`ConversationController`, `AgentIdentityRuntime`, `DeliveryPort`).
- **Touches existing code:** `src/agent.ts` and `src/agent/config.ts` (the `AgentAdapter` union, constructing the host,
  `functions`); `src/agent-adapter-registry.ts` (store either adapter type); the controller factory
  (`createController`, `src/agent-session.ts:733`, via the controller-interface work) chooses `NativeController` for a
  `NativeAdapter`; `src/out-of-band-messages.ts` (kind and sender in metadata); `src/identity.ts` (optional
  `mcpServers`, `checkpointed`; opaque receipt); the checkpoint coordinator (call `checkpointed`); the permission
  setting replacing `defaultPermission` (`src/agent/config.ts` and where `defaultPermission` is read in
  `src/agent-session.ts`, a replacement, not new code); `permission_requested`, `permission_resolved` and
  `answerPermission` on conversations (stage 2a); `src/permissions/request.ts` (the neutral request);
  `src/metering/native/` and `src/metering/certification.ts` (`native-harness@1`, lookup by adapter kind).
- **Storage, through the persistence backend, never straight to SQLite.** Persistence is `sqlite` or a consumer's
  `custom` backend (`AgentPersistenceConfig`), so native state follows the existing pattern of optional repositories
  with a capability flag (`identity?` with `capabilities.identity`, `internalInferences?`; `src/persistence/backend.ts`):
  an optional `channels?` repository (name provisional) with `capabilities.channels`, holding the config overrides,
  each conversation's channel state (policy, pending flag) and the reconciliation watermark; it also serves ACP
  conversations' policies in stage 2b. SQLite implements it (schema version 17, an upgrade migration from 16 in
  `src/persistence/sqlite-schema.ts`, tested on a version-16 database). A custom backend without it can't host native
  conversations: an `Agent` with a native adapter fails at construction with a clear error; ACP-only custom backends
  keep working, so nothing breaks. Channel settings reuse the conversation configuration persistence `setConfig`
  already uses for ACP. Native user records are keyed by message id and carry an acceptance state on the record
  itself (records are append-only with revisions, so confirming appends a revision; to verify in the grounding
  report).
- **`agent-session.ts` does not grow.** Steering already goes through `SteeringHost`; the controller choice is the
  factory; anything else needed there is extracted first.

## Stages

This spec is implemented in two stages, each against the matching part of harness v1
(`../harness/11-11-SPEC-harness-v1.md`, Two parts). End-to-end tests run through a real `harness serve` process with
the harness's scripted model (its test mode), so they need no provider key.

> **2026-11-22:** stage 2a's core is built (State after implementation); what remains is briefs R1–R6. The list
> below is the original design's.

**Stage 2a, with harness part 1: native conversations end to end.** The work (its plan: Implementation plan,
stage 2a):

- `NativeAdapter`, `AgentHarnessConfig` and the registry change; the `NativeHarnessHost` with the in-process
  transport; the `NativeController` passes the controller conformance suite on the harness's scripted model.
- Cancellable connect, for ACP and native: the attempt reachable by `stop()`, the pending calls raced against the
  connection closing, no late install, one attempt at a time, `ConnectionCancelledError`, no automatic time limit
  (Cancellable connect).
- The process transport and lifecycle: launch through the launcher; `start` that attaches without the process;
  lazy start on first need, started once, cancellable; optional idle stop with both sides agreeing; crash
  and bounded restart, settling held turns and taken messages; `HarnessUnavailableError`; a real `harness serve`
  process in tests; `harness.home`.
- `providerStart: "on_first_use"` for ACP conversations (opt-in; default unchanged).
- Channel changes: the pending flag (in the `channels?` repository), coalesced changes sent at once or inside the start call, deletes and
  resets while stopped.
- Holds as leases; persistence failures surfaced, never held; the bounds in Nothing waits forever.
- Configuration known before start: stored config and overrides, `describe` (with policy names), channel settings
  stored per conversation; `agent.harness.config()`, `updateConfig`, `resetConfig`.
- Subscriptions: the `streaming` option, the union with the persistence policy, `channel/update` on change;
  `message_completed` as the source of the assistant record; `progress` feeding stall detection.
- The participant registry: sent at start, `participants/update` when one is added or changes.
- Reconciliation at start: `since`, settling turns and prompts missed around a crash; pushes retried with the same id.
- Turns the harness starts reach `runTurn`, also for conversations not loaded; `turn_took` extends a cause; steer
  and queue hints; dropped messages settled; withdraw through the harness; held usage and signals; native steering
  behind `nativeSteering`; usage filed by purpose.
- Holds for the exclusive operations; the native admission rules.
- The native half of delivery: pushing items onto channels (the port the orchestrator will use).
- Native user records written before the push and confirmed at acceptance; `accepted` on the prompt handle.
- The host's controls: `agent.harness.start()`, `stop()`, `restart()`, `state`; `harness_unresponsive`.
- Billing-grade metering: the native inference source, `native-harness@1`, checked at start.
- `permission_resolved`, `expiresAt`, and acp-client owning the permission timeout.
- Permissions as events: `permission_requested`, `answerPermission`, `answersPermissions`, `permissionTimeoutMs`; the
  one permission setting replacing `defaultPermission`, with the ACP matcher and the optional function; the harness's
  `approval_requested` routed to the conversation; the first-message permission-handler rule.
- `setTitle`, `setPolicy` (stored in the `channels?` repository), per-channel settings through `setConfig`.
- From the controller-interface spec: a neutral provider-session record (native: the `Agent`'s id plus the channel
  id), the neutral permission request shape, the model-call record, opaque provider data on messages; the
  `capabilities` getter becoming `Capabilities | null`.
- `agent.harness.export()` and `import()` (import renames the session to the `Agent`'s id).

**Stage 2b: what needs more of the harness** (updated 2026-11-22).

- Identity for ACP conversations: `harnessIdentityRuntime` (`load`, `update`, `delivered`), the `checkpointed` hook,
  opaque receipts; reports flushed before `member/prepare`; the checkpoint-backed runtime wrapped as a deprecated
  source. Needs the harness's identity work (timeline, members).
- Messages between channels: the harness's channel messaging work; its first slice, external notices
  (`channel/notify`), is used by the orchestrator's way back.
- The `http` internal-inference runtime with its own minimal client (independent of the harness; any time).
- Built already: consumer-registered tools through `functions/call` (the harness's tools-and-callbacks work, with
  acp-client's host functions). History callbacks are not planned.

## Implementation plan, stage 2a

Replaced 2026-11-21. Stage 2a's core was built by the harness's acp-client integration work (State after
implementation); what is left is briefs R1–R6 (Remaining work: implementation plan, at the top). The original briefs N0–N11 are in this file's history
(up to `5e01135`).

## Acceptance

Revised 2026-11-22. **Built:** the stage 2a core is verified by Gates 1–3 of the harness's acp-client integration
(the evidence tables in its `11-20-LOG.md`, steps 4 and 5): shared startup, steering and approval, an isolated
`forceStop`, missed-reply recovery, lost push and open responses, `Agent` reopen and shutdown. **Remaining:** each
brief's gates are its acceptance, plus three end-to-end checks once R1, R3 and R5 are done:

- A native conversation deleted while the harness is stopped stays deleted across an acp-client restart: its channel
  is retired before the harness can take work on it.
- A permission request reaches the consumer as `permission_requested` and closes with one `permission_resolved`, for
  an ACP conversation and a native one alike; with no answerer, an unattended ask is refused at once.
- A tool-using native turn's metering matches the harness's model-call records exactly; `billing_required` accepts a
  native conversation whose harness confirms its certification.
- With no native adapter configured, behaviour is unchanged and the existing suite passes.

The original stage 2a list (holds, `harness_unresponsive`, the watermark, item status, `agent.harness.stop()`,
acp-client-side export) is in this file's history; what it covered is built differently (State after
implementation), dropped, or a follow-up.

**Stage 2b:**

- A fact told in one native conversation is known in another (timeline delivery).
- An ACP conversation with a harness configured receives a preamble from `load`, and its position advances only after
  `delivered`.
- A `function` tool runs through the callback; the history tools read acp-client's records.
- `message_participant` from one native conversation appears on the other conversation as an appended assistant
  message and on its events.
- Internal inference runs over `http` with a key, and over the disposable session without one.

## Limitations

Accepted for v1, not designed around (owner, 2026-11-13: edge cases that already existed before, or that can't leave
the agent or a channel stuck nor silently lose data in normal operation, are recorded here rather than solved).

- **Stopping a native conversation unloads it; it doesn't suspend its channel.** The harness may still run turns on
  that channel (a worker reply, another channel's trigger), which reload the conversation to record them. To make a
  channel quiet: delete it, or change its policy.
- **Usage between turns can be missed around a crash.** A model call outside a turn (a compaction between turns) whose
  usage hadn't reached acp-client when the harness crashed isn't recovered; the harness's own usage ledger still has
  it. Calls inside turns are recovered with their turn.
- **Concurrent spending overshoots.** Limits are the consumer's, outside the library (a cap is deferred,
  `todos/11-13-TODO-spending-cap.md`); two channels running at once can both pass a consumer's check.
- **The two logs can disagree.** After a persistence failure acp-client's records have gaps while the harness's
  context is complete (Native admission).
- **No sync of the harness home in v1.** An isolated harness on an ephemeral home loses the entity unless the consumer
  mounts a durable volume (Where the session lives).
- **Offline channel changes are eventually applied, not immediate.** A running harness can take work before a
  retirement or suspension arrives (Durable channel intents).
- **Deletes before the first open leave retired tombstones.** The harness creates and retires the channel
  in the same open batch. Each such deletion leaves one empty retired channel, which cannot take work.
- **The memory fallback loses pending channel intents on Agent restart.** Backends without
  `capabilities.channels` use host records. The default memory store is process-local, and the fallback
  writes the conversation deletion and its retirement intent separately.
- **Legacy rows and custom backends that omit controller kind rely on fallback detection.** Retirement
  uses the provider descriptor or a live conversation. An unused native channel can remain open after deletion
  following an Agent restart if neither identifies it.
- **Switching to a durable backend ignores pending file-store channel changes.** The host warns once when the
  configured file store has pending changes. Only changes that had yet to be delivered at upgrade are affected.
  The file store still supplies submissions when configured.
- **Message submissions don't survive an acp-client restart,** and turns that ended while no acp-client process
  existed aren't recorded in acp-client's records (the harness has them; the two logs disagree). Follow-ups.
- **Fixed time limits for native** (built, 2026-11-21): a 30 s startup deadline and a 30 s request timeout, both
  configurable, can cut off a slow but working harness. An ACP connect that never answers still waits until the
  consumer cancels it (brief R4).
- **Permission requests in a held turn** reach the consumer only when the session runs the turn, with the clock
  already running (Permissions).

## Open

- [ ] A spending cap enforced by the library: deferred (`todos/11-13-TODO-spending-cap.md`).
- [ ] Do Codex and Claude support HTTP MCP servers over ACP, or is the stdio bridge needed (phase 2)?
- [ ] Whether the consumer may wake an ACP conversation with an item (a prompt it allows), or ACP only gets next-prompt
      delivery.
