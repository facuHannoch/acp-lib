# Controller interface verification — B1 capabilities, rename and seams

Reviewed [B1](../11-11-SPEC-controller-interface.md#brief-b1-capabilities-the-rename-the-session-on-the-interface), [Capabilities](../11-11-SPEC-controller-interface.md#capabilities), [Seams and files](../11-11-SPEC-controller-interface.md#seams-and-files), and the [original report](11-15-REPORT-B1.md). Verification started at `c6c6a00` on `controller-interface-verify`; its source and tests match `d11cd18`.

## Gate

A clean `git archive c6c6a00` copy at `/tmp/acp-b1-verify.TZBGT5` used the main checkout's linked `node_modules` and Bun 1.3.14. The offline fixture checks ran outside the sandbox with approval.

| Check | Result | Saved output |
| --- | --- | --- |
| `bun run typecheck` | Clean, exit 0 | `/tmp/acp-b1-verify.TZBGT5.typecheck.log` |
| `bun test ./test` | **1,402 passed, 0 failed, 131 files, 35 snapshots, 181.49 s** | `/tmp/acp-b1-verify.TZBGT5.test.log` |
| Snapshot SHA-256 | `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d` before and after the suite | `/tmp/acp-b1-verify.TZBGT5.snapshot-check.log` |
| Capability refresh and native guard probe | Exit 0, with the behaviors below | `/tmp/acp-b1-verify.TZBGT5.probe.log` |

The bridge, operation-lifecycle and checkpoint strategy tests passed in this run. The first full run was green, so there was no rerun. The A1 capability case passed against its existing snapshot.

## Steps 1–2 — Capabilities and rename

- [capabilities.ts](../../../../../src/conversation-controller/capabilities.ts) L48–77 maps ACP initialize data through `fromAcp`: load, fork, listing, media (file from `embeddedContext`), MCP (stdio always true), and the raw ACP object. `HarnessController.conversationCapabilities` calls it through the active ACP client, advertises no native steering, and reports an unknown backend before initialization and in PTY mode. Only `NotConnectedError` is swallowed by the neutral reader. The adjacent raw `capabilities` getter still uses `requireAcp()`, preserving the ACP value and errors.
- The named internal readers moved: [run-turn.ts](../../../../../src/conversation-turns/run-turn.ts) L63–68 maps `conversationCapabilities.backend` to media capabilities; session listing uses `listAgentSessions`; [provider-sessions.ts](../../../../../src/agent/adoption/provider-sessions.ts) L47–56 uses `fromAcp(client.capabilities).listSessions` on its temporary ACP client. Low-level ACP checks in `AcpClient`, provider-session deletion (no neutral delete flag), and the ACP-specific REPL still use raw capabilities. The REPL receives the concrete controller directly from the CLI, rather than via a session escape hatch as the spec describes.
- [errors.ts](../../../../../src/errors.ts) defines and [index.ts](../../../../../src/index.ts) exports `UnsupportedError`. [controller.ts](../../../../../src/controller.ts) L131 declares `HarnessController implements AgentClient, ConversationController`; L90 defines the renamed `ControllerStartEvent`. L780–785 keeps deprecated `AgentController` in both value and type positions and `AgentControllerStartEvent` as a type alias. The root exports both names and the new names. `AgentControllerConfig` retains its original name.

## Steps 3–4 — Session seams and factory

| Spec seam | Current code |
| --- | --- |
| Controller field | [agent-session.ts](../../../../../src/agent-session.ts) L469 declares `ConversationController`. |
| Startup | Required interface `start` / `startFresh`; session start progress uses `ControllerStartEvent`. Older session signatures spelling `ConnectResult` use the same type as `StartResult`. |
| Creation | L704–728 delegates to [factory.ts](../../../../../src/conversation-controller/factory.ts), returning `ConversationController`. |
| Binding | L731–747 takes the interface and subscribes to connection, commands if present, usage, and turns. |
| Dispatch | L2301–2353 calls interface dispatch; ACP reports synchronous start, while B2 routes backend-reported turns through queue items. |
| Turn execution | L3417–3428 delegates to `runTurn` using [context.ts](../../../../../src/conversation-turns/context.ts) and its interface getter; `prepareTurn` under the supervisor at run-turn L139–151. |
| Handoff target | L2539 declares the interface; L2624 builds through the same factory; L2764–2769 installs and binds the new controller. |
| Mode switch | L3297–3335 invokes interface `setMode` through a guard; the harness replaces its ACP/PTY leaf, while the session keeps the same controller instance. |
| Internal prompts | L281 and L3780–3822 use the interface for the target and call guarded `prepareInternalPrompt`. |
| Supervision | L3726–3753 takes `ConversationController` for options and `SupervisedProvider` for execution. |
| Capability reads | L4088–4092 exposes both getters. The neutral getter reads the current controller on access, with no session cache. |
| Public escape hatch | L1916–1920 returns `ConversationController`; `harnessConnection(): HarnessController \| null` narrows with `harnessControllerOf`. |

The harness derives neutral capabilities from the active ACP client after start and reconnect. `HarnessController.setMode` replaces the client and ACP reference, so the same controller reports the new mode's capabilities. Handoff installs the target before subsequent capability reads. An offline probe saw listing unsupported after starting the echo fixture, an unknown backend in PTY, listing unsupported again after switching back, and listing supported after handoff to the lifecycle fixture. It verified that the handoff replaced the controller instance.

`src/index.ts` exports `ConversationController`, `ConversationCapabilities`, `BackendCapabilities`, `PreparedTurn`, `StartResult`, `ItemRef`, `TurnCause`, `TurnContent`, `TurnEvent`, `TurnRun`, `TurnStarted`, `TurnTook` and `UsageListener`, in addition to the controller names and error. The `rg -n '\\bHarnessController\\b' src/agent-session.ts src/conversation-turns` scan finds the escape-hatch type, its import and two comments in the session, and zero matches in turn code. The factory and narrowing helper are in `src/conversation-controller/`. No session or turn directly constructs a controller.

## Guard inventory

| Member or capability | Guard and fallback |
| --- | --- |
| `prepareInternalPrompt` | Method presence in generated handoffs (missing method skips summary generation). The internal prompt itself uses bound `requireMember` before its metering or transcript work. |
| `availableCommands` | `availableCommandsOf` returns a frozen empty list when absent. |
| `subscribeAvailableCommands` | Optional invocation in `bindController`. No subscription when absent. The callback receives the command list in code; the Interface example uses a zero-argument callback. |
| `currentMode` | `isDegradedController` tests for `"degraded"`; session reads fall back to the existing or requested mode. |
| `setMode` | `requireMember` before queuing and again at execution. Unsupported yields `UnsupportedError`. |
| `bridge` | Bound `requireMember`. The harness bridges the live PTY in degraded mode and a separate temporary PTY in normal mode. |
| `reconnect` | `reloadProviderSession` requires the method. Its typed absence error reaches the existing missing-session continuation rule. |
| `listSessions` | `listAgentSessions` requires both method presence and `backend.listSessions`; excludes PTY. Unknown ACP state still throws the old `NotConnectedError`; unsupported agent listing contributes no entries. |
| `authenticate` | Bound `requireMember`; the harness also requires an active ACP connection. |
| ACP load/replay and fork | These operations are outside the neutral interface. `AcpClient` enforces the corresponding raw flag; unsupported startup load takes the continuation path. The session's reload gate uses method presence and the provider result. The neutral `loadSession` and `forkSession` flags are advertised, and the session does not read them to drive these ACP paths directly as the guard table suggests. |
| Media | The ACP turn's owned preparation maps `backend.media`; PTY follows the existing degraded rule. The later native send path differs, below. |
| Raw ACP compatibility getter | `acpCapabilitiesOf` narrows through `harnessControllerOf` (same check used by `harnessConnection()`), then delegates to the harness. It throws `UnsupportedError` for other controllers. |
| Native fresh context and supervision | `requireFreshContext` guards explicit fresh-provider restart before force-stop; native `startFresh` also rejects. `stallLimitsFor` honors `supervision: "backend"` by disabling host output-silence deadlines. |

## Drift since B1

B1's factory created only `HarnessController`. It now chooses `NativeController` when given an explicit host/channel binding. The native controller implements the same core interface and omits the ACP optional members, so the same presence guards apply. It reports `nativeSteering: true`, `freshContext: false`, `supervision: "backend"`, and no load/fork/listing or media/MCP support. Its media flags are currently all false, rather than inferred from model configuration. The raw getter still throws for native, where the controller-interface spec describes a nullable return in stage 2a. The [native integration spec](../11-11-SPEC-native-harness-integration.md) explicitly tracks the nullable getter as remaining work.

Two later native guard gaps were reproduced using the scripted fixture:

- **Media is silently omitted.** A native conversation completed a public prompt containing text and a file part. The harness submission contained only the text. The ACP media gate runs in the session-scheduled turn preparation and the native send path sends only text, without refusing the unsupported part. This meets the plan's silent data loss triage criterion and needs a native source fix. [Error note](../../../../../.agents/.artifacts/common/errors/11-22-b1-native-prompt-drops-media.md)
- **Fresh context refusal happens after writes on the public native handoff path.** The probe requested a same-adapter handoff with no continuation. It observed two reset action records and both `handoff_started` and `handoff_failed` before the unsupported fresh-context error. The factory carries the native binding into the target, whose `startFresh` rejects; the handoff had already started durable work. This differs from the spec's side-effect-free refusal rule. The probe found no successful reset or stuck channel. [Error note](../../../../../.agents/.artifacts/common/errors/11-22-b1-native-handoff-records-before-refusal.md)

These are findings against the later native integration. Source authorization is needed before changing those paths. The temporary probe did not use a live provider.

## Historical commits and verification scope

Historical B1 commits: `6079fbf` and `5731072` (mapping and listing compatibility), `3de9a50` (rename), `5b311b5` and `a7dcdc0` (interface, factory and recovery guard), `41a5059` and `dfad5f9` (factory tests). The optional `cancelGraceMs` difference in the original report is resolved in the current spec. `agent-session.ts` remained at 4,634 lines in B1 and is now **4,641**, below the 5,022 limit. `controller.ts` is still 840 lines; its B1 increase was accepted in the original report.

No source, test, or snapshot edits in this verification. B1's historical snapshot diff from `09b7258` to `dfad5f9` is empty. The later mixed-cause snapshot change is `8b4b4f3`, outside B1.
