# Review — controller interface B1 verification

I reviewed the report-only commit `79627f63` (`library/reports/11-22-REPORT-B1-verify.md`) against
[Brief B1](../11-11-SPEC-controller-interface.md#brief-b1-capabilities-the-rename-the-session-on-the-interface),
Capabilities, and Seams and files. I read the code through `git archive 79627f63` and the reviews worktree; I didn't
check out `controller-interface-verify`. I also wrote my own offline probe on that archive. It used the scripted
native fixture (`test/native/support.ts` `nativeRig`) and no live harness.

**Verdict: no blocking findings for B1 itself.** Steps 1–4 and the seam table hold. The two native gaps are real,
and they're in the later native integration, not in B1:

- **(a)** is silent data loss under triage, so it needs a fix.
- **(b)** is a contradiction with the spec, not stuck or lost data. The fix is small.

## My probe

The probe is at `/tmp/clad2a-b1.elxO/test/zz-probe/b1-probe.test.ts`, a temporary file outside the repository. Its
output, in summary:

```
caps.media {"image":false,"audio":false,"file":false}
PROBE-A outcome {"ok":true,"status":"completed"}
PROBE-A pushes [{"id":"…","channel":"agc-…","sender":"user","text":"look at this"}]
PROBE-B outcome {"ok":false,"name":"AgentSessionHandoffError","causeName":"UnsupportedError", …}
PROBE-B events [… "handoff_started","handoff_failed", …]
PROBE-B new records [native_action reset state=started (seq 4), native_action reset state=failed (seq 5), error recorded]
PROBE-B next prompt completed phase idle
```

## Findings, by severity

1. **(a) Native prompts drop media without saying so. Confirmed. It meets the "silently loses data in normal
   operation" rule, so it gets fixed. It's in the native integration, not B1.**
   - I sent a public `prompt({ parts: [text, file] })` on a native conversation. It completed (`status: completed`).
     The only `NativeHarnessHost.push` carried `text: "look at this"`. The file wasn't sent and wasn't refused, even
     though the controller advertises `media.file: false`.
   - Cause: `src/native/controller.ts` `send` pushes `{ id, channel, sender, text }` for each message and ignores
     `messageParts` and `attachments`.
   - The existing media gate runs only in the ACP turn preparation (`run-turn.ts` L63–68). A native message never
     reaches that preparation: it goes through `send` or `steerIntoRunningTurn`.
   - **Where to refuse: on the native send path, as the required fix.** In `NativeController.send`, throw
     `UnsupportedError` before any `push` if a message carries non-text parts or attachments the backend's
     `media` flags don't allow. Check every message in the run before pushing the first one, so nothing goes out
     half-sent.
   - This is the only place every native route passes through: queued sends, steers into a running turn, and any
     future caller. It's also where the loss actually happens.
   - A session-level gate at acceptance (`enqueuePrompt`) would give a nicer, earlier rejection, so it's worth
     adding. It isn't enough on its own, for two reasons:
     - For ACP, the backend's capabilities are still unknown before connecting, so the ACP preparation gate has to
       stay anyway.
     - A gate at acceptance would duplicate the backend check in two places.
   - My recommendation: do the controller-level refusal now. Add the early session check later if wanted.
   - Also add a test in `test/native/`: a text and file prompt rejects with `UnsupportedError`, and nothing is
     pushed.
2. **(b) An unsupported native handoff writes records before refusing. Confirmed. It isn't stuck and loses no
   data; it's a spec contradiction.**
   - A same-adapter `handoff({ continuation: { kind: "none" } })` produced:
     - `handoff_started` then `handoff_failed`;
     - two `native_action` records, `reset` `started` then `reset` `failed`, with the `UnsupportedError` text
       recorded;
     - a rejected call.
   - The next prompt completed normally (phase `idle`). The history is honest: a started/failed pair. Nothing was
     reset and nothing was lost, so under triage the code doesn't *have* to change. It does contradict the spec's
     rule that an operation is refused before durable writes.
   - Cause: `agent-session.ts` `runHandoff` (~L2519–2559) emits `handoff_started` and `recordNativeAction(…,
     "started")` first. Only later (~L2624–2626) does the target controller's `startFresh` reject
     (`native/controller.ts:127–128`).
   - **Smallest fix:** at the top of `runHandoff`, before `handoff_started`, refuse with `UnsupportedError` (no
     events, no records) when the target can't start a fresh context. For the same adapter that means
     `this.controller.conversationCapabilities.freshContext === false`.
   - Put the check in `runHandoff`, not at `handoff()` call time. The controller can change while the handoff waits
     in the queue (a mode switch), so it's correct to check at execution.
   - It's about 3 lines plus one test. It's cheaper than writing a Limitations entry and removes the contradiction.
   - Side note: the caller gets `AgentSessionHandoffError` with `UnsupportedError` as its `cause`, not a bare
     `UnsupportedError`. With the early check, the bare `UnsupportedError` would reach the caller directly, which
     matches the guard contract.
   - Not checked: a cross-adapter switch from a native conversation. The report says the factory carries the
     native binding into the target. If so, the same check should cover a switch too. That's for the native spec
     owner to confirm.
3. **The REPL takes the concrete controller instead of using the escape hatch. Spec wording only.** The REPL is
   ACP-specific, and the CLI hands it the `HarnessController` it constructed. Neither turn code nor the session
   depends on this. No guard is skipped for a non-ACP controller, because the REPL never receives one. Fix the
   spec's seam description. **Accept.**
4. **The session doesn't read the load and fork flags. Spec wording only.** Load and fork aren't neutral interface
   operations. `AcpClient` enforces the raw ACP flags, and an unsupported startup load takes the existing
   continuation path. So refusing still happens, just one layer lower than the guard table says. No stuck path and
   no data loss. Fix the guard-table row to say that ACP enforces it. **Accept.**

## Steps 1–4, guard table, and "Drift since B1" checked

I spot-checked these against `79627f63` and they match the report:

- `acpCapabilitiesOf` throws `UnsupportedError` for a non-harness controller (`guards.ts:57–59`; my first probe
  attempt hit exactly that).
- Native `conversationCapabilities`: `nativeSteering: true`, `supervision: "backend"`, `freshContext: false`, all
  media flags false (`native/controller.ts`).
- Native `startFresh` rejects before touching anything.
- The session's controller and handoff target are typed as `ConversationController`, and the target is built
  through the factory.

The "Drift since B1" section is accurate. The raw getter still throws instead of returning null; the native
integration spec tracks that as remaining work.

## Gate evidence

I didn't rerun the typecheck or the full suite. cod2a's run (1,402/131, snapshot hash unchanged) and the A2 gate stand.
My evidence is the probe above.
