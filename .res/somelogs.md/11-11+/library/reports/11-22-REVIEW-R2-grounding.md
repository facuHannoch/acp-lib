# Review — R2 step 0 grounding

This review covers `2619e12` (`library/reports/11-22-REPORT-R2-grounding.md`) on `native-integration-r`, at
`a180301`. I read it through `git show` and the reviews worktree, which is at alpha `a180301`.

**Verdict: the grounding is accurate and complete. No blocking findings on it.** On the three behaviour points:

- **(1) Native:** I agree.
- **(2) Deny → `reject_once`:** I agree. The A1 snapshots don't change, but other records and tests do.
- **(3) Ask refuses in R2:** I agree.
- **The proposed precedence has a problem:** "handler > permissionRule > rules > default" contradicts the spec,
  and it would make rules ineffective whenever a handler exists. I propose a different order below, with an exact
  backward-compatible default. This needs a **spec-owner/user decision** before step 3.

## Grounding against my list

| My point | Report |
| --- | --- |
| `defaultPermissionOutcome` moved to `record-helpers.ts:67` | Yes (`:67–75`), and the call site is `recording.ts:183` inside the closure at `:161–200`, built by `run-turn.ts:126` |
| About 10 files | The 21-line inventory covers every match: 11 `src` files (`types`, `cli/managed` ×2, `cli/index`, `controller` ×2, `agent-session` ×5, both adoption files, internal-inference `harness-runtime`, `client` ×2, `recording` ×2, `context`, `record-helpers`) plus the historical log. I agree with the replacement for each. The three fail-closed internal clients (listing, deletion, headless inference) stay explicit `{ default: "deny" }`. That's right: none of them has an answerer. |
| Two fallback paths | Yes: `AcpClient.defaultOutcome` (`client.ts:1010–1024`) for a raw or handlerless client, and the recording closure for session turns. The recording closure always passes a handler, so the client fallback is only reached outside session turns. Both must use the same helper; the report moves the decision into `src/permissions/`. |

**Adapter evidence:**

- Codex and Claude are **backed by real captures**: archived `.wire.jsonl` files with `kind: "execute"` and
  `rawInput.command`. Claude has an earlier capture *without* `kind`, a useful no-match case.
- OpenCode and Grok are **taken from source**, and labelled as such.
- One request: pin the Grok source link to a commit or tag. It currently points at `main`, unlike the OpenCode
  link, which is pinned to `v1.18.34`. Otherwise the fixture can't be traced later.

**Normalization rules:** I agree with all of them. Match only when the request has the `execute` kind and
structured input. Join argument lists only when every token's boundaries survive. In practice: join with single
spaces only if no token contains whitespace, quotes or shell metacharacters; otherwise, no match. Unwrap a login
shell only when the whole command is that wrapper. Title-only commands, empty input, competing representations and
extra wrapper arguments get no match. Tests should cover a different executable, added arguments and operators
(`&&`, `;`, `|`) not inheriting an allow rule. Name the accepted wrappers exactly in step 2: `bash -lc` per the spec.
Include `/bin/bash` and `sh -c` only if a capture shows them.

**The neutral request:** keeping the public `PermissionRequest` unchanged in R2 is the right call. Records list
their fields explicitly, so they keep their shape. A pure match-to-level API serves the orchestrator, with option
selection kept separate.

## The three behaviour points

### (1) Native stays outside the ACP setting: agree

- **Why not apply the setting to native:** a native `ask` comes from the **harness's own policy gate**. The
  harness has its own `allow` level for consumers who want automatic approval. If an ACP-side `default: "allow"`
  (or today's `"approve"`) auto-answered a native ask, the harness's choice to involve someone would be silently
  overridden. And ACP `kind:`/`command:` rules can't see native requests anyway: there's no ACP kind, and the
  arguments are a string. They'd fall through to `default`, so the setting would act as a blanket approver.
- **The brief also requires it:** "Must not touch: native approval routing".
- **Risk:** low. The native path was merged only with R1, and the opt-in is implicit.
- **What to do:** refuse an unattended native ask, document the removed opt-in in the changelog's breaking
  section, and point users at the harness policy's `allow` for the same effect.
- **Implementation note:** the recording closure is shared, so it needs an explicit "native request → handler, else
  refuse" branch, *before* the matcher, not a matcher that happens to fall through to `default`. Add a test: a
  native ask with `permissions: { default: "allow" }` and no handler is refused.

### (2) Deny selects `reject_once`: agree. The A1 snapshots don't change, but other records and tests do

- **The A1 snapshots: unchanged.** The only permission records in `characterization.test.ts.snap` (L1923–1977 and
  L14906–14960) come from "a permission request answered through the handler" and the immediate-permission case.
  Both are answered by a **handler** selecting `allow` (`approved`). The other `"outcome": "cancelled"` lines in the
  file are metering and turn outcomes, not permissions. The steer cases use `defaultPermission: "approve"`, which
  maps to `allow`, the same selection. So the brief's gate holds.
- **What changes:**
  - **The wire:** an automatic deny now answers `selected: reject_once` instead of `cancelled`. Per ACP, `cancelled`
    is meant for a prompt turn that was cancelled. A refusal should select the reject option, so this is more
    correct.
  - **What the agent does:** agents treat the two differently. Claude continues with "the user rejected this",
    where a cancelled answer can end the tool attempt differently. Consumers relying on the default refusal will
    see the agent keep going more often.
  - **Records:** the reducer records `denied` instead of `cancelled`.
  - **Tests:** `test/permissions.test.ts` asserts `{ outcome: "cancelled" }` for the default refusal (L68–89). The
    cases where `reject_once` is offered will change; the cases with no `reject_once` still cancel.
- **Recommendation:** accept. Update those assertions in their own commit, so the diff shows only cancelled →
  selected-reject. Put it in the changelog under breaking/behaviour.
- **Unchanged:** when there's no `reject_once`, it still cancels. The handler and abort paths are unchanged.

### (3) Ask refuses at once in R2: agree

There's no event answerer until R3. Waiting would stall the turn with nobody to answer it, so refusing straight away
(failing closed) is the only safe choice. Use the same selection as deny (`reject_once`, else cancel), so the record
reads `denied` and not `cancelled`. Document it as temporary: in R3 an ask goes to the event and waits up to
`permissionTimeoutMs` when `answersPermissions` is set.

## Precedence: the proposed order contradicts the spec

**What the report proposes:** handler > `permissionRule` > rules > `default`.

**What the spec says:** the level is computed first ("the most restrictive level wins; when none matches, `default`
applies"), and then:

- allow picks `allow_once`;
- deny picks `reject_once`;
- **"ask goes to the handler or the event"**;
- "The per-prompt handler stays as a shortcut" describes how an *ask* is answered.

So under the spec, a `command:rm -rf … → deny` rule (or `permissionRule` returning deny) is final, even if the
prompt brought a handler. Putting the handler first would make every rule ineffective as soon as a consumer passes
`onPermissionRequest`, which is the most common setup.

**The catch with the spec order:** if `default: "deny"` (the brief's mapping of today's default `"cancel"`) is
applied before the handler, a handler would *never be called* under the default configuration. Every consumer that
answers permissions through `onPermissionRequest` today would break.

**Recommendation, which keeps today's behaviour exactly and follows the spec:**

1. **Compute the level:** `permissionRule(request)`, then the most restrictive matching rule, then `default`.
2. **`allow` and `deny` are final** (an automatic selection). **`ask`** goes to the turn's handler if there is one.
   Otherwise, in R2, it refuses as in (3); in R3 it goes to the event.
3. **When `permissions` is omitted, the default is `{ default: "ask" }`.** With today's two cases:
   - no handler: ask refuses, which is today's "cancel" default;
   - handler: the handler decides, which is today's behaviour.

   So omitting the setting behaves exactly as today.
4. **Migration:**
   - `"approve"` → `{ default: "allow" }`, as in the spec. The only change is that a handler is no longer consulted
     for unmatched requests when allow is set. Today "approve" with a handler still calls the handler. Document it.
   - `"cancel"` → **`{ default: "ask" }`** reproduces today exactly: the handler if there is one, otherwise refuse.
     The spec says `"cancel"` → `default: "deny"`, which additionally stops calling handlers. Explicit `"cancel"`
     with a handler is rare, but it's the spec owner's call. I'd change the spec's mapping to `ask`, or keep `deny`
     and document it.

This is a **spec-owner/user decision**, because it changes the spec's stated mapping and fixes the
handler-versus-rules order. It should be settled before step 3. Step 2's matcher is a pure function, so it isn't
affected.

**Config precedence:** Agent `permissions` < `conversationDefaults` < `runtime.permissions`, with a top-level
create field winning last if it's exposed, and each override replacing the whole object. I agree. It's simple and
predictable, but document that an override replaces the inherited rules and doesn't merge with them. `permissionRule`
on runtime defaults, with `undefined` falling through, is fine.

## Baseline

cod2a's baseline (`permissions.test.ts` + characterization, 46 tests, 35 snapshots, hash unchanged) stands. I didn't
rerun it, since step 0 changes no code.
