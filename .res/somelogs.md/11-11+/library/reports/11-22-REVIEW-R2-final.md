# Review — R2 step 3 and the final review of R2 (permission setting and matcher)

This review covers step 3 (`0ef8da4` implementation and migration, `43db21a` raw ACP assertions, report `928f865`;
diff `ead74b8..928f865`) and R2 as a whole (steps 1–2 reviewed in `11-22-REVIEW-R2-steps1-2.md`). I read them
through `git diff`/`git show` and a clean `git archive 928f865` (`/tmp/clad2a-r2f.*`); I didn't check out the branch.

**Verdict: R2 is complete, and every decision you made is implemented. No blocking findings.**

- Both fallback paths share one decision module.
- No `defaultPermission` is left in `src`, apart from the historical log.
- The A1 snapshots are unchanged.
- The native path never consults rules, and a test covers it.

`43db21a` is *not* only the deny → `reject_once` assertions. It also carries the level-first assertion changes and
new validation tests. All of it is consistent with your decisions, but it's broader than described. There are four
small notes at the end.

## Each decision, checked

| Decision | Where | Holds |
| --- | --- | --- |
| Level first: `permissionRule`, then the most restrictive rule, then `default` | `permissions/policy.ts` `permissionLevel`: `override ?? (native ? settings.default : matchPermissionLevel(…))` | ✓ |
| Allow and deny are final; only ask reaches the handler | `answerPermissionLevel`: `if (level === "ask" && handler) return handler()`, otherwise the automatic selection | ✓. The test "allow and deny bypass the prompt handler" has a handler that throws "must not run" |
| Ask with no handler is refused (deny selection, recorded `denied`, temporary) | `answerPermissionLevel` maps `ask` to `deny` with no handler. `recording.ts` records `denied` when `level === "ask" && !handler`, even if the wire had to cancel | ✓ |
| An omitted setting is `{ default: "ask" }`; `cancel` → ask, `approve` → allow | `DEFAULT_PERMISSIONS = { default: "ask" }`. The CLI, internal clients, smoke tests and test configs are migrated | ✓ |
| Agent < `conversationDefaults` < runtime, whole-object replace | `inheritPermissionPolicy(...)`: `permissions = config?.permissions ?? permissions`, with no merging. Agent: `(config, conversationDefaults)`. Manager: `(defaults, create/open config, config.runtime)`. `permissionRule` is inherited the same way | ✓. The order is Agent < defaults < create/open field < runtime, as the changelog says |
| Rules validated when the configuration is read | `ownPermissions` checks: `default` is a level; `rules` is a plain object; keys are `kind:<one of the 10 ACP kinds>` or `command:<non-empty, no control characters>`; values are levels. It's called in `Agent.open` (Agent and defaults), `prepareStart` (create/open and runtime, before any durable write), the `AcpClient` constructor and the `AgentSession` config | ✓. The test rejects `kind:exectue`, `command:` and `worker:kind:read`, and the level `alow` |
| ACP deny selects `reject_once`, else cancel | `selectPermissionOutcome` | ✓ |
| Native: only `permissionRule` and the default; the handler for ask; deny → harness `deny`; docs | `permissionLevel(..., native)` skips the matcher. The native `APPROVAL_OPTIONS` deny option has kind `reject_once`, so a deny selects it and the controller sends harness `deny`. The changelog says "default allow approves native asks" | ✓. See the native test below |

## Both fallback paths share the decision code

- **The recording closure** (every session turn, ACP and native): `permissionLevel` + `answerPermissionLevel`, with
  the handler wrapped in `permissionWithAbort`. It registers itself in `recordingPermissionHandlers`.
- **`AcpClient.handlePermission`:** if the handler is a recording handler, it calls it directly, so the policy isn't
  applied twice. Otherwise, for a raw client or internal prompts, it uses the same `permissionLevel(request,
  this.config)` + `answerPermissionLevel`.
- `defaultOutcome` (client) and `defaultPermissionOutcome` (record-helpers) are **deleted**.
- The three internal fail-closed clients (adoption listing, provider deletion, headless inference) now pass an
  explicit deny.

## No `defaultPermission` left

`git grep defaultPermission 928f865 -- src` gives only `src/native-harness/.res/…/11-20-LOG.md:267`, the historical
log, which is kept as decided.

## The A1 snapshots are unchanged

No `__snapshots__` changed in `ead74b8..928f865`, and the characterization hash is `fbc6ec2c…` on the archive. The A1
permission cases are handler-approved asks: under the new default `ask`, the handler is still called.

## `43db21a`: broader than deny → `reject_once`

It changes only `test/permissions.test.ts`, which is the raw `AcpClient` path:

- **Deny → `reject_once`:**
  - "deny selects reject_once and cancels when it is unavailable";
  - the omitted setting refusing with `reject`.
- **Level-first, which is more than reject_once:**
  - "wins over defaultPermission" (the old rule that a handler beats `approve`) became "allow and deny bypass the
    prompt handler";
  - "may cancel even when the default would approve" became "may cancel an ask".
- **New tests:** `permissionRule` returning ask before rules and the default; configuration validation.
- **Renames:** `defaultPermission: approve` → `default allow`.
- **Removed:** the old "cancel never selects even when allow is offered" assertion. It's replaced by the
  empty-options cancel case, and allow-first under deny now selects reject.

All of these match your decisions. But the commit is a deny + level-first + validation update, not only
deny → `reject_once`. Recorded-turn and native assertions are in `0ef8da4` (`agent-owner`, `steering`,
`characterization` config, `checkpoint`).

## The native path doesn't consult rules: confirmed by test

`checkpoint.test.ts` "native asks use the default and override callback without ACP rules" uses:

- a harness policy where `record` is `ask`;
- the Agent `permissions: { default: "allow", rules: { "kind:execute": "deny" } }`;
- a prompt handler that always answers `deny`.

What it checks:

1. **Approved.** The tool ran (`effects == ["ran"]`), so the `kind:execute` deny rule wasn't consulted. The handler
   wasn't called either, because allow is final.
2. **A `permissionRule` returning deny refuses it.** The effect isn't repeated. The rule saw
   `request.tool.name === "record"`, so the neutral view carries the native tool name. The handler was never
   called (`handlers === 0`).

## Gates I ran

On the `928f865` archive:

- typecheck clean;
- permissions, matcher, `test/conversation-turns`, agent-owner, steering, native checkpoint and internal-inference
  harness-runtime: **236 pass, 0 fail**, 35 snapshots;
- snapshot hash unchanged.

I didn't run the full suite. cod2a's gate: 1,488 tests in 136 files, green.

## R2 as a whole

- **Brief Done:** the report lists commits per step, test counts and times (1,464, 1,474, 1,484 after the alpha
  merge, 1,488), the normalization rules, and every place `defaultPermission` was read with its replacement. ✓
- **Must-not-touch:** the harness policy model and native approval routing are unchanged. Native only gained `tool`
  on its callback request, and its decision skips the matcher. ✓
- **Spec text:** the spec already has the decided mapping (`cancel` → `ask`), the omitted default, the precedence,
  the temporary R2 refusal, native using only the default, and "default allow approves native asks". ✓
- **Changelog:** a "Breaking permission configuration" section covers the replacement and migration, the omitted
  default, the inheritance and whole-object replace, `permissionRule`, the command-vs-kind note, validation, allow
  and deny being final, the temporary refusal of an unattended ask, ACP deny → `reject_once`, callback `tool`, and
  native behaviour. ✓

## Notes (none blocking)

1. **Native is detected through `conversationCapabilities.nativeSteering`** (`recording.ts`). That holds today
   (true only for `NativeController`), but it's a stand-in. A future ACP controller that advertises native steering
   would silently skip `kind:`/`command:` rules. An explicit flag, such as a `nativeApprovals` capability or the
   controller kind, would be clearer.
2. **`permissionRule` return values aren't validated.** A typo like `"allowed"` falls through to the deny selection,
   so it fails closed, but silently. Consider throwing, or logging, on a value that isn't a level.
3. **Inconsistent records for "no `reject_once` offered":** an *automatic deny* records `cancelled` (through
   `permissionRecordOutcome`), while an *unattended ask* records `denied`. Both are policy refusals. Recording both
   as `denied` would be more consistent. It's minor, and R3 can settle it.
4. **`permissionRule` and native:** `permissionRule` sees native requests too (by design). Its documentation should
   say that it receives native requests with `tool.name` and a string `rawInput`, so a consumer's rule written for
   ACP shapes doesn't misjudge them.
