# Report: Brief B1, capabilities, the rename, the session on the interface (controller interface)

Spec: `../11-11-SPEC-controller-interface.md` (beta `5e01135`; Capabilities, The interface, Brief B1). Branch
`controller-interface`, on top of A2 (head at the start of B1: `09b7258`). Implementer: agentclad-1. Reviewer:
agentco-1, directly after each step (the shared log, `12-11-LOG-controller-interface.md`, has the entry for each step,
with its decisions and gaps).

**State: steps 1–4 done and each passed agentco-1's review; the full suite is 1,257 pass / 0 fail (two runs); the A1
snapshot is byte-identical to A2's; `agent-session.ts` is 4,634 lines (its size before B1).** B2 (turns the backend
starts, the fake controller, the conformance suite, the changelog) is not started.

## Owner decisions made at the start of B1 (2026-11-15, the user)

- The intermittent managed checkpoint failure (`internalSessionActivatedAt must not be after updatedAt`) is accepted as
  a known limitation for now. A todo records it: `.plan-execution/todos/errors/11-15-TODO-managed-checkpoint-activation-timestamp.md`
  (`5baff2d`). No source fix.
- `src/controller.ts` growing in A2 (756 → 825 lines) is accepted as an exception, because A2 step 3 required it. From
  B1 on, the plan's "large files don't grow" rule applies, so additions there are kept to a minimum and reported.

## Commits

| Commit | Step | Content |
| --- | --- | --- |
| `6079fbf` | 1 | `src/conversation-controller/capabilities.ts` (`ConversationCapabilities`, `BackendCapabilities`, `fromAcp`, `conversationCapabilitiesOf`, `mediaCapabilitiesOf`), `UnsupportedError`, `conversationCapabilities` on the controller and the session, three internal capability readers moved |
| `5baff2d` | | the checkpoint-failure todo (above) |
| `5731072` | 1, fix | `listSessions()` before the agent connects keeps throwing `NotConnectedError` (review finding) |
| `3de9a50` | 2 | `AgentController` → `HarnessController` (`implements ConversationController`), the interface completed, `AgentControllerStartEvent` → `ControllerStartEvent`, the old names kept as deprecated aliases |
| `5b311b5` | 3 | `AgentSession` on `ConversationController`, optional members behind guards, `harnessConnection()`, the factory, the new public exports |
| `a7dcdc0` | 3, fix | a controller without `reconnect` reaches the conversation's continuation rule; `agent-session.ts` back to its pre-B1 size (review findings) |
| `41a5059`, `dfad5f9` | 4 | the factory's tests (the factory itself landed in step 3); the test titles narrowed after review |

The A1 snapshot file is unchanged since A2 (`git diff 09b7258 HEAD -- test/conversation-turns/__snapshots__` is empty;
SHA-256 `47686d4ca0451cf8…`).

## Step 1: capabilities

- **Module:** `src/conversation-controller/capabilities.ts`. `fromAcp` maps an ACP `initialize` result to
  `BackendCapabilities`: `loadSession`, `forkSession` and `listSessions` from the agent's session capabilities;
  `media.file` is ACP's `embeddedContext`; `mcpServers.stdio` is always true (every ACP agent takes stdio servers);
  `acp` keeps the raw result.
- **`conversationCapabilities`** on `HarnessController` (a 3-line getter; the logic is in the module) and on
  `AgentSession`. `nativeSteering` is always false; `backend` is null before the agent answers `initialize` and in PTY
  mode (only `NotConnectedError` is tolerated; any other error propagates). The raw ACP `capabilities` keeps its shape
  and its throwing behaviour.
- **Readers moved** to the neutral backend capabilities: media in `run-turn.ts`, the session's listing in
  `AgentSession.listSessions`, provider-session listing in `provider-sessions.ts`. The provider-session delete check
  stays on the ACP client (the neutral type has no `delete`; the brief names only the media and listing readers).
- **`UnsupportedError`** in `src/errors.ts`.
- **Review fix (`5731072`):** my first version made `listSessions()` skip the agent half silently before the agent
  connected, where it used to throw `NotConnectedError`. An unknown backend is not an unsupported one, so the error is
  kept. Two regressions pin it (before-connect rejects with that error and message, as on the previous head; PTY mode
  returns the catalog half with no error).

## Step 2: the rename

- `AgentController` → `HarnessController` in place; `implements AgentClient, ConversationController`.
- **`ConversationController` completed** (`contracts.ts`) with the lifecycle, settings/usage and capability members
  and the optional members; new `UsageListener` type.
- `AgentControllerStartEvent` → `ControllerStartEvent` (the real type lives in `controller.ts`).
- **Deprecated aliases:** `AgentController` (a `const` and a `type`) and `AgentControllerStartEvent`, exported from
  `src/index.ts` next to `HarnessController` and `ControllerStartEvent`.
- **Renamed in** `agent-session.ts`, `conversation-turns/context.ts`, `harness-runtime.ts`, `repl/commands.ts`,
  `cli/index.ts`, `wire-log.ts` and the tests that used the class. `AgentControllerConfig` keeps its name (the brief
  renames only the class and the start event).
- **Error strings keep the old class name** ("AgentController is not started — call start() first"): callers and the A1
  snapshots match on them.
- **Deviation recorded for the spec owner:** `cancelGraceMs` is `number | undefined` in the interface; the spec says
  `number`. The getter returns the adapter's optional value and the supervisor defaults `undefined` to 30 s, so
  following the code is correct. `$AGENTS_COMMON_ARTIFACTS_DIR/errors/11-15-spec-cancelgracems-optional.md` (left for
  the spec owner; no behaviour change).

## Step 3: the session on the interface

- **Typed on the interface:** the session's controller field, `InternalPromptTarget`, `bindController`,
  `onControllerTurnEvent`, `supervisedPrompt` and the turn context (`context.ts`, `run-turn.ts`). `connection`
  returns `ConversationController`; `harnessConnection(): HarnessController | null` is new. The characterization
  watcher reaches the provider call through it (the interface has no `prompt`).
- **New modules:** `factory.ts` (`createController`; only Adapter → `HarnessController` exists in this spec) and
  `guards.ts` (below). The factory is listed under step 4 in the brief, but step 3's gate says "outside the factory",
  so it was created now; step 4 became its tests.
- **Public exports added** to `src/index.ts`: `UnsupportedError`, the interface and turn types, `UsageListener`, the
  capability types.
- **The gate:** `HarnessController` appears in `agent-session.ts` only in the `harnessConnection` signature, its
  import and comments, and not at all in `src/conversation-turns/`.

### Every guard, with the member it guards

| Member | Where | Guard | When unsupported |
| --- | --- | --- | --- |
| `subscribeAvailableCommands` | `bindController` | optional call `?.` | no subscription; no command events |
| `availableCommands` | `internalSessionCommands` (`availableCommandsOf`) | `?? []` (frozen empty list) | no commands |
| `currentMode` | the session's mode reads; `isDegradedController` | `?? previous`; derived `=== "degraded"` | not degraded; the mode isn't changed |
| `setMode` | public `AgentSession.setMode`; the queued mode switch (`requireMember`) | method present | `UnsupportedError`, thrown by the public call before anything is queued |
| `reconnect` | `ensureProvider` (`reloadProviderSession`) | method present | `ProviderSessionReloadUnsupportedError`: recovery treats it as a lost provider session, so the conversation's continuation rule applies (below) |
| `listSessions` | `AgentSession.listSessions` (`listAgentSessions`) | method present, not degraded, `backend.listSessions` | the agent half is empty; an unknown backend (not connected) still throws `NotConnectedError` as before |
| `bridge` | `AgentSession.bridge` (`requireMember`) | method present | `UnsupportedError` |
| `authenticate` | `AgentSession.authenticate` (`requireMember`) | method present | `UnsupportedError` |
| `prepareInternalPrompt` | `meteredInternalPrompt` (`requireMember`, before any operation is opened); the handoff's generated summary | method present | `UnsupportedError` before any metered or durable operation; a handoff with a generated summary skips the summary (`summary = ""`, as for "none") |
| raw ACP `capabilities` | `AgentSession.capabilities` (`acpCapabilitiesOf`, through `harnessConnection()`) | the controller is a `HarnessController` | `UnsupportedError`; for a harness the same value and errors as before |

`requireMember` returns the method bound to its controller, so the receiver is preserved.

### Review fix: a missing `reconnect` and the continuation rule (`a7dcdc0`)

- **The finding (agentco-1):** with `reconnect` absent, my `UnsupportedError` reached `continueWithoutProviderSession`,
  which rejects any error that isn't a recognized "missing provider session" as `provider_session_load_failed` before
  the continuation strategies run. So the spec's "recovery paths skip it (gated with continuation)" wasn't met, and my
  test pinned only a rejection.
- **The fix:** `reloadProviderSession` throws `ProviderSessionReloadUnsupportedError` (an `UnsupportedError`, in
  `errors.ts`), and `isMissingProviderSessionError` (`checkpointing/recovery.ts`, +2 lines and an import) returns true
  for it ahead of any caller-supplied classifier, because it is our condition and not a provider failure. Both the
  non-owner path and the Agent-owned `recoverInPlace` path then treat it as a session the provider no longer has.
  Behaviour for every other error is unchanged. `recovery.ts` is not named in the brief's must-not-touch list.
- **Tests (`reload-unsupported.test.ts`, 6),** on a real controller with only `reconnect` hidden and the real
  `reconnect` spied (never called):
  - detached default rule: a fresh session, the prompt completes;
  - detached `onFailure: "error"`: `provider_session_missing` and a `continuation_unavailable` blocker;
  - managed with a `new_from_transcript` strategy: the builder runs once and the prompt completes on a recovered
    session;
  - managed with only the load strategy and history: `ContinuationUnavailableError`;
  - Agent-owned with recovery configured: recovered in place from the checkpoint;
  - the classifier unit test.
- **Limit:** with the Agent-owned default policy (`onLoadFailure` not `recover`) the result is the structured error,
  exactly as for a real lost session; only the `recover` policy recovers.
- **Size:** the guards were moved out of the session into `guards.ts`; `agent-session.ts` went back from 4,668 to its
  pre-B1 size.

## Step 4: the factory

`createController` (step 3) builds every controller the session creates: at open and for a handoff's target (both
through the session's private `createController`). The tests (`factory.test.ts`, 5):
- an adapter gives a configured `HarnessController`; each call makes a new one;
- a handoff replaces the live controller with a new factory-built `HarnessController` (same adapter id) that the
  conversation keeps prompting;
- two text scans: direct construction in `src/` appears only in the factory, `harness-runtime.ts` and `cli/index.ts`
  (the spec's direct users, named so a new one elsewhere fails), and not in the session or the turn code.
  **The scan is a narrow guard, not a proof:** an alias, other syntax or a type reference isn't matched. The "no
  concrete controller type" gate is covered by the grep above and the review's inspection.
- `harness-runtime.ts` (internal inference) and the low-level CLI still construct a controller directly; agentco-1
  agreed that the spec's factory scope is session creation and handoff targets.

## Gate

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean; test files (including `test/conversation-controller/`) clean under the temporary tsconfig; `git diff --check` clean |
| full suite `bun test`, two runs on the head before this report | **1,257 pass, 0 fail; 121 files; 35 snapshots**, exit 0; 95.1 s and 94.8 s |
| focused (`test/conversation-turns` + `test/conversation-controller`), three runs | 160 pass each; snapshot SHA unchanged |
| A1 snapshot | byte-identical to A2's (SHA-256 `47686d4ca0451cf8…`); the A1 capability case unchanged |
| test count | 1,215 at the A2 gate → 1,257 (+42: capabilities 12, rename 6, session-interface 13, reload-unsupported 6, factory 5) |
| line counts | `agent-session.ts` 4,634 → 4,634 (limit < 5,022); `controller.ts` 825 → 840 (+15: the capability getter and its import, the interface import, the three deprecated aliases and their comments; the rename is line-neutral). **Not covered by the A2 exception; escalated, see Open questions**; `contracts.ts` 131 → 174; new: `capabilities.ts` 72, `guards.ts` 69, `factory.ts` 11 |
| `HarnessController` in the session and the turn code | only the `harnessConnection` signature, its import and comments |
| `src/` changed since A2 | 17 files, +340/−78 |

Mutation checks were run for each step (in the shared log): removing each guard, the alias, the error-string
preservation, the classifier branch and the factory's adapter id each fail their targeted tests.

## Deviations from the spec, and decisions

- **`cancelGraceMs` is `number | undefined`** (above; left for the spec owner).
- **The factory landed in step 3** rather than step 4 (the gate for step 3 needed it).
- **`isDegraded` has no interface member;** the session derives it from the optional `currentMode` (an absent mode means
  not degraded).
- **A controller without `reconnect`** is handled as a lost provider session (a typed error the classifier
  recognizes), which reads the spec's "recovery paths skip it (gated with continuation)" as "the continuation rule
  decides".
- **A handoff with a generated summary** skips the summary when the controller has no `prepareInternalPrompt`
  (`summary = ""`, like "none").
- **`session.capabilities`** throws `UnsupportedError` for a non-harness controller; the spec turns it into
  `Capabilities | null` in stage 2a.
- **`controller.ts` grew 15 lines in B1 (825 → 840).** The owner's decision above accepts A2's growth and says the no-growth rule applies from B1, so **this growth is not covered by that exception**. It is the smallest I found for the required members (the `conversationCapabilities` getter, which the interface requires on the class, and the deprecated aliases the brief requires), but I am not treating it as accepted: it is escalated for owner disposition (Open questions).

## Limits

- **No real second backend yet.** Every absent-member path runs on a real `HarnessController` wrapped to hide members
  (a plain object with only the core members, or a proxy hiding one), not on the B2 fake controller. B2's conformance
  suite is where a core-only controller is exercised end to end.
- **Capabilities are read live,** not cached: "re-read after start, a mode switch and a handoff" holds by construction;
  no test changes the reported capabilities across a handoff.
- **The alias is a `const` plus a `type`.** A consumer using `typeof AgentController` or declaration merging was not
  examined.
- **The text scans in the factory tests** are narrow guards (above).
- **Checkpoint failure:** `CheckpointValidationError: internalSessionActivatedAt must not be after updatedAt` did not
  occur in any of B1's full-suite or focused runs; it remains an accepted limitation (the owner's
  decision above).
- **Docs and changelog:** the README and docs still say `AgentController` (valid through the alias); the changelog is
  completed in B2, as the brief says.

## Open questions

1. **For the spec owner:** correct the spec's `cancelGraceMs: number` to `number | undefined`, or define the default
   (30 s) in the interface (error file above).
2. **Answered (owner, 2026-11-15): option (a), accepted as the minimum for the required members; B2 released.** Original text: **`src/controller.ts` grew 15 lines in B1 (825 → 840), against the plan's no-growth rule.**
   Not covered by the A2 exception. Where the 15 lines are: the `conversationCapabilities` getter and its import (about 4), the
   `ConversationController` import and `implements` (about 3), the three deprecated aliases with their comments
   (about 7), the rest in the start-event rename. Options:
   - **(a)** accept it as the minimum for members the brief requires;
   - **(b)** move the deprecated aliases to a new module (`src/conversation-controller/aliases.ts`, exported from
     `src/index.ts`; the public API is unchanged, but `AgentController` would no longer be importable from
     `src/controller.ts` itself), which brings the growth to about +8; the getter and the interface import must
     stay on the class;
   - **(c)** another extraction the owner prefers.
   I recommend (a), because (b) leaves growth anyway and changes an import path, but this is the owner's call. B2 waited on
   this disposition.
