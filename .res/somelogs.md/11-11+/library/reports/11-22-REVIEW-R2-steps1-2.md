# Review — R2 steps 1 and 2: the neutral request and the matcher

This review covers step 1 (`ccfc32f`) and step 2 (`7c8c18e`) on `native-integration-r` (diff `2619e12..7c8c18e`). I
read them through `git diff`/`git show` and a clean `git archive 7c8c18e` (`/tmp/clad2a-m.*`); I didn't check out the
branch. I wrote my own adversarial probe of the matcher (`probe/m.ts` in that archive).

**Verdict: no blocking findings.**

- The neutral view adds one optional field and changes no record or snapshot.
- It can be built for native without the ACP matcher.
- Normalization accepts exactly the named forms: **40 of 40 bypass attempts were refused.**
- The reduction picks the most restrictive level.
- The fixtures are labelled.

Two notes for step 3: validate rule levels at configuration time, and document the most-restrictive consequence.

## Step 1: the neutral request

- **Layout.** `src/permissions/request.ts` defines `PermissionOption`, `PermissionTool { name?, kind?, rawInput? }` and
  `NeutralPermissionRequest { tool, title?, options }`. It has no ACP or transport imports. `src/permissions/acp.ts`
  is the ACP producer that replaced the mapper in `client.ts`.
- **The callback shape.** The public `PermissionRequest` gains only an optional `tool`. It's added only when ACP
  supplies `kind` or `rawInput`. cod2a's amendment omits it otherwise, so handler callbacks for the fixture
  requests (which have neither) are byte-identical. `toolCallId`, `title`, `options` and `raw` are unchanged.
  `PermissionOptionKind` moved and is re-exported.
- **What callers see.** Real adapters that do send `kind`/`rawInput` will now include `tool` in their handler
  callbacks. That's additive and optional in the type, so nothing breaks. Worth one changelog line.
- **Records and snapshots are unchanged.** The recording closure lists the record's request fields explicitly
  (`toolCallId`, `title`, `options`, `raw`), so `tool` never reaches a record. No `__snapshots__` changed in
  `2619e12..7c8c18e`, and the characterization hash is still `fbc6ec2c…`.
- **It can be built for native without the matcher.** `request.ts` has no ACP dependency, and `matchPermissionLevel`
  takes a `Partial<Pick<…, "tool">>`. A native producer can build `{ tool: { name, rawInput: argumentsString },
  options }` from the approval event and never call the matcher. Native routing is untouched in these commits.

## Step 2: the matcher

`matchPermissionLevel(request, settings)` is pure: it maps a request to a level. `selectPermissionOutcome(level,
options)` in `outcome.ts` is separate:

- allow → `allow_once`, else `allow_always`, else cancel;
- deny → `reject_once`, else cancel;
- ask → `undefined`, left for the caller to route.

That's the API shape the orchestrator needs.

### Normalization: my bypass probe

The rule set was `{ "command:bun test": "allow" }` with `default: "deny"`, and `kind: "execute"`.

**Allowed (6):** a plain string `{command:"bun test"}`; argv `["bun","test"]`; `{command:"bun", args:["test"]}`;
`bash -lc 'bun test'`; `bash -lc "bun test"`; argv `["bash","-lc","bun test"]`.

**Refused, falling to `default` (40):**

| Group | Cases |
| --- | --- |
| Extra arguments and prefixes | `--watch` added; `bun testx`; `/usr/bin/bun test`; `FOO=1 bun test` |
| Shell operators | `&&`, `;`, `\|`, `$(…)`, backticks, a newline |
| Whitespace and look-alikes | leading or trailing space, a tab, a Cyrillic `е` look-alike |
| Wrapped compounds | `bash -lc 'bun test; rm -rf /'`; `bash -lc 'bun test' && rm -rf /`; `bash -lc 'bun test'\''x'` |
| Double-quote expansion | `$HOME` or a backslash inside `bash -lc "…"` |
| Other wrappers | `bash -c`, `sh -lc`, `/bin/bash -lc`, `bash -l -c`, nested `bash -lc 'bash -lc "…"'` |
| Unsafe argv | an extra argument after the wrapper; `;`, space, quote or empty tokens; an env-assignment executable |
| Ambiguous objects | `command` together with `argv`; `args` that isn't an array |
| No usable command | a number; no input (title only) |

**How it refuses:**

- Unwrapped strings are compared **exactly**, so operators and extra arguments can never match a shorter rule.
- Only `bash -lc '…'`/`"…"` are unwrapped. The double-quoted form refuses `$`, backticks, `\` and `"` because they
  would be expanded by the outer shell.
- Any other string that starts with `bash -lc` gives no command at all.
- argv joins only tokens matching `[A-Za-z0-9_./:@%+=,-]+`, and the executable can't contain `=`.
- Nested wrappers aren't unwrapped recursively, so they only match an exact rule for the literal inner text. That's
  conservative, and fine.

### Most-restrictive reduction

There are at most two candidates: `kind:<k>` and, for `execute`, `command:<normalized>`. The function returns the one
with the lower weight (`deny` < `ask` < `allow`), and falls back to `default` when neither matches. `Object.hasOwn`
makes rule lookup prototype-safe; `kind:__proto__` gave `default`.

| Case | Result |
| --- | --- |
| kind allow + command deny | deny ✓ |
| kind deny + command allow | deny ✓ |
| kind ask + command allow | ask ✓ |
| A command rule with no kind | default ✓ (execute only) |
| A command rule on `edit` | default ✓ |

**For step 3 docs:** the consequence is that a `command:` allow can't override a stricter `kind:execute` rule. To
allow specific commands only, the user leaves `kind:execute` unset, or sets it to `ask`, and relies on `default`.
That follows the spec, but it should be stated.

**For step 3 validation:** levels aren't checked at runtime. A typo like `"allowed"` makes the weight `undefined`,
and the function can then return an invalid level. `selectPermissionOutcome` would treat it as deny (it isn't
`allow` or `ask`), so it happens to fail closed. Validate `permissions.rules` values, and the rule key prefixes
(`kind:`/`command:`), when the configuration is read in step 3, and reject unknown ones.

### Fixtures

`test/fixtures/permission-requests.ts` labels every packet:

- **capture-backed**, with the `.wire.jsonl` path: Codex execute; Claude execute; Claude without `kind` (which must
  not get a command match);
- **source-derived:** OpenCode `v1.18.34`, and Grok **pinned to `37949780…`**.

The Grok case, with `cd /workspace && bun test`, correctly does *not* match a `bun test` rule.

## Gates I ran

On the `7c8c18e` archive:

- typecheck clean;
- `permission-matcher.test.ts` + `permissions.test.ts` + characterization: 57 pass, 0 fail, 35 snapshots;
- snapshot hash unchanged.

I didn't run the full suite. cod2a's step 2 gate was still running when core-p sent this.
