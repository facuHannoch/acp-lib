# Review — the two native source fixes

This review covers `f30f3e3..9016c0c` on `controller-interface-verify`:

- `6f4c6c6`: media preflight in `src/native/controller.ts`;
- `9bfaf27`: refusal of a fresh handoff, plus the new `src/handoff-options.ts`;
- the report at `9016c0c`.

I read them through `git diff` and `git archive`, and didn't check out the branch.

**Verdict: no blocking findings.** Both gaps are closed. The refusals happen before anything is sent, emitted or
written. ACP is unaffected. The tests assert absence, and they fail on the old source. There's one non-blocking
note for M2, below.

## (1) Media preflight (`native/controller.ts` `send`)

- **It checks the flags, not a hard-coded "no media".** `requireMedia(kind)` reads
  `this.conversationCapabilities.backend.media[kind]`. When M2 sets `image: true`, images pass with no further
  change here.
- **It covers every part and attachment of every message.** The first loop goes through all `run.messages`: each
  `messageParts` entry with `isMediaPart` (everything except `text` and `pasted`), and each attachment by
  `mediaKind(mimeType)`. The second loop pushes only after the first loop finishes. So a refusal anywhere in the run
  means no `push` at all.
- **It maps kinds the same way as the shared media code.** `image/svg+xml` counts as `file`, matching
  `media/parts.ts:61/95` and `media/acp.ts:78`. Link-mode parts are refused too, while ACP lets links through without
  a capability. That's stricter, and correct: native `send` would have dropped them as well.
- **Queued and steered paths are both tested.** `test/native/checkpoint.test.ts` "queued and steered prompts with
  file parts are refused before push, and text still runs":
  - with a first turn held, it sends a queued and a steered file prompt;
  - both reject with `UnsupportedError`;
  - `push` ids stay `[first]`, and become `[first, next]` once a later text prompt runs.
- **A later message's attachment is caught before anything is pushed.** `controller.test.ts` "preflights a later
  message's attachment…": m1 is text and m2 has an audio attachment. The test asserts `pushes.length === 0`
  synchronously, that it rejects with "does not support audio input", and that no submissions were saved.

**Non-blocking note for M2.** `send` still pushes only `message.text`. Once `image: true`, the preflight will let an
image through, and the image will again be dropped without anyone being told. That's the same loss this fix closed.
M2 has to forward the parts in the same change that turns on the flag. Alternatively, the preflight could refuse
all media until the push carries parts. Suggest a one-line comment at the preflight, or an M2 spec note, so the flag
doesn't get turned on by itself.

## (2) Handoff refusal (`agent-session.ts` `runHandoff`)

- **It's the first thing `runHandoff` does.** `requireFreshContext(this.controller, "a same-adapter handoff")` runs
  before `ensureProvider()`, `handoff_started`, `recordNativeAction` and any transcript write.
- **The caller gets a bare `UnsupportedError`.** My probe now sees `name: "UnsupportedError"`, where it used to see
  `AgentSessionHandoffError` wrapping it.
- **It applies only to a same adapter whose controller can't start fresh.** The condition is
  `targetAdapterId === fromAdapterId`, and `requireFreshContext` throws only on `freshContext === false`.
- **ACP doesn't change.** `ConversationCapabilities.freshContext` is typed `?: false` (`capabilities.ts:24`), and
  `HarnessController` never sets it. So the guard can't fire for ACP, connected or not. That's why it's safe to run
  before `ensureProvider()`.
- **Cross-adapter switches skip the guard.** As before, they go on to the factory.
- One consequence: a native cross-adapter switch still reaches the target's `startFresh` after it has started writes.
  I said in the B1 review that I hadn't checked that path. It's out of scope here and accepted as is.

## (3) `handoff-options.ts` is a pure extraction

The diff removes `ownHandoffOptions` from `agent-session.ts` and adds the same body, character for character, in
`src/handoff-options.ts`, with one import and the call site unchanged. It has one concern and changes nothing.
`agent-session.ts` goes from 4,641 to 4,604 lines.

## (4) The tests assert absence and fail on the old code: confirmed

- **Old source, new tests.** I made a copy of the `9016c0c` archive with `src/` replaced by `f30f3e3`'s
  (`/tmp/clad2a-nf-oldsrc.Z6fg`). All three new tests fail there (0 pass, 3 fail). On `9016c0c` all three pass.
- **My B1 probe**, rerun on `9016c0c` (`/tmp/clad2a-nf.aiqw/test/zz-probe/b1-probe.test.ts`):
  - media: rejects with `UnsupportedError: a native conversation does not support file input`, and `pushes []`;
  - handoff: rejects with a bare `UnsupportedError`, no `handoff_*` events, no new records, and the next prompt
    `completed`.

  Before the fix, the same probe showed text-only submission, and records plus events before the refusal.
- **Regression checks:**
  - `bun run typecheck` passes.
  - Every test file that calls `handoff(` (11 files) plus `test/native/`: 239 pass, 0 fail, 16 files, 117 s
    (`/tmp/clad2a-nf.reg.log`).
  - I didn't run the full suite.

## Changelog

The two new bullets in `CHANGELOG-controller-interface.md` describe exactly the behaviour I observed.
