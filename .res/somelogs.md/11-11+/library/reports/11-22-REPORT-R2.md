# R2 ACP permission requests and matching

Steps 1 and 2 follow the [grounding report](11-22-REPORT-R2-grounding.md). The configuration replacement and handler precedence are step 3.

## Step 1. Neutral request projection

Commit `ccfc32f` defines the protocol-neutral tool, title, and option types in `src/permissions/request.ts`. The ACP adapter builds the tool view from wire kind and raw input, and retains the existing callback's tool call ID, title, options and original packet. ACP provides no stable tool name. Where a packet supplies neither kind nor raw input, the callback has no additional tool property. The recording path still serializes the original record fields. Native approvals keep their existing routing and policy.

The first trial exposed an empty tool property in all three A1 handler callback snapshots. The step 1 commit was corrected to omit it for packets without tool data. [Snapshot finding](../../../../../.agents/.artifacts/common/errors/11-22-r2-empty-permission-tool-snapshots.md)

The clean gate passed typecheck and **1,464 tests across 132 files** in 91.65 s. All 35 A1 snapshots passed and the snapshot SHA-256 matched the grounding run. Logs are at `/tmp/acp-r2-step1-gate.UKXUFa/typecheck.log` and `/tmp/acp-r2-step1-gate.UKXUFa/full.log`.

| File | Before R2 | After step 2 |
| --- | ---: | ---: |
| `src/client.ts` | 1,092 | 1,077 |
| `src/agent-session.ts` | 4,567 | 4,567 |

## Step 2. Exact rule matching

Commit `7c8c18e` adds `matchPermissionLevel` in `src/permissions/matcher.ts` and the separate `selectPermissionOutcome` in `src/permissions/outcome.ts`. The matcher is pure and accepts a neutral tool view, including requests with no tool metadata. It looks for an exact `kind:` entry and, for execute requests only, an exact normalized `command:` entry. Among matches, `deny` takes precedence over `ask`, which takes precedence over `allow`. The configured default applies only if neither rule matches. The matcher can read an already selected worker rule map after the orchestrator strips the `worker:` prefix. Worker routing and the worker-only ask-the-agent level stay with the orchestrator work.

The only wrappers that are unwrapped are the full shell strings `bash -lc '…'` and `bash -lc "…"`, and the exact three-element argv `["bash", "-lc", command]`, which also works as `{ command: "bash", args: ["-lc", command] }`. Outer shell expansion or escapes in the double-quoted form are refused. A malformed or compound `bash -lc` expression has no command match. Other executables or flags receive no wrapper normalization. A plain single-line command compares verbatim. The matcher supports direct argv and the structured `argv`, `command`, and `command` plus `args` forms. It joins only tokens whose boundaries can be preserved, and ambiguous or conflicting inputs have no command match. It never extracts commands from display titles.

| Fixture | Provenance and checks |
| --- | --- |
| Codex | Capture-backed execute shape with `{ command, cwd }` and no title. |
| Claude | Capture-backed execute shape with `{ command, description }`. The older variant has no ACP kind and matches no command rule. |
| OpenCode | Source-derived execute shape with shell metadata and cwd, based on the [v1.18.34 permission adapter](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/acp/permission.ts). |
| Grok | Source-derived execute shape with a raw command that still includes the leading `cd` omitted from the title. [Grok permission producer pinned to 37949780c144e37df692e3d669051a21fec24f20](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs#L1562-L1572). |

Option selection prefers `allow_once` over `allow_always`, uses only `reject_once` for deny, and falls back to cancellation when no appropriate option is offered. It leaves ask unresolved for the caller. Step 2 does not install the matcher in either runtime decision path.

The clean gate passed typecheck, all **10 focused matcher tests**, and **1,474 tests across 133 files** in 95.54 s. All 35 A1 snapshots passed and the snapshot file matched the grounding SHA-256. Logs are at `/tmp/acp-r2-step2-gate.sMcl1p/typecheck.log`, `/tmp/acp-r2-step2-gate.sMcl1p/matcher.log`, and `/tmp/acp-r2-step2-gate.sMcl1p/full.log`.

## Alpha integration

Merge commit `e87907f` brings alpha `29715a3` into `native-integration-r` after the step 2 gate. It brings in worker delivery alongside R1. The merge was clean.

A clean archive of the merge passed typecheck and **1,484 tests across 136 files** in 91.56 s. All 35 A1 snapshots passed, and the snapshot file matched the grounding SHA-256. Logs are at `/tmp/acp-r2-alpha-gate.Oxnieu/typecheck.log` and `/tmp/acp-r2-alpha-gate.Oxnieu/full.log`.

Step 3 awaits the precedence decision and coordinator release.
