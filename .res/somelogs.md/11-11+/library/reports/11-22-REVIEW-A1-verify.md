# Review — controller interface A1 verification

Reviewed the report-only commit `f0208602` (`library/reports/11-22-REPORT-A1-verify.md`) against
[Brief A1](../11-11-SPEC-controller-interface.md#brief-a1-characterization-tests) and the tests at `d11cd18`.
I read the code with `git show` and a `git archive` copy. I didn't check out `controller-interface-verify`.

**Verdict: no blocking findings.** The report's claims hold. The "Different" rows test the behaviour A1 asks for,
apart from the gaps below. I agree with how the three error notes were handled.

## Findings, by severity

None of them blocks.

1. **The "provider fails to start" case only covers a failed reattach (non-blocking, covered behaviour narrower than
   the wording).** `characterization.test.ts:450–468` creates a working conversation first. It then force-stops it
   and makes the *reload* fail. A conversation whose provider never starts is not characterized, for example a bad
   command on the first prompt. A2 step 4 adds its own test for a provider-connection failure (`abandonTurn`,
   `turn_failed`, a rejected prompt), so the gap is covered there. It doesn't meet the triage rule: nothing gets
   stuck and no data is lost. **Accept.** The spec owner may reword the A1 case as "a provider that cannot be
   (re)attached".
2. **The named fixtures exist but aren't used (non-blocking).** The report reads as if the lifecycle fixture stood in
   for missing agents. In fact `test/fixtures/stalling-prompt-agent.ts` and `test/fixtures/permission-agent.ts` are
   both present at `d11cd18`, and other tests use them (`test/permissions.test.ts`, `test/agent-owner-shutdown.test.ts`).
   - `[lifecycle:partial]` emits output and then stalls, which tests the stale policy (`firstOutputMs`/`nextOutputMs`
     30 ms, `cancelGraceMs` 50).
   - `stalling-prompt-agent` never answers, and only a transport close settles it. That is closer to the
     force-stop path than to a stale cancel.

   Both rows are acceptable equivalents of the behaviour A1 asks for. **Accept.** The spec could name the
   lifecycle modes instead.
3. **The capabilities case doesn't read before start through a conversation (non-blocking, structural).**
   `L594–613`: the public conversation factory awaits start, so a conversation can't be read before it starts. The
   controller does the literal before/after read, and the conversation reads at create, force-stop and reconnect.
   This is the closest equivalent. **Accept.** The spec should say the before-start read happens at the controller
   boundary.
4. **Bridge from normal mode runs only on a detached `AgentSession` (non-blocking).** `L572–591`. A1 asks to assert
   which path runs and that the ACP session is untouched. Both are pinned (start/bridge/stop counts,
   `sameInternalSession`, and a prompt afterwards). A1 doesn't require the bridge in all three modes. **Accept.**
5. **Error notes (triage):**
   - *ID numbering order* (`normalize.ts:104–126`). I confirmed it in the code. The first pass registers values
     under ID keys, in sorted-key walk order, before the text pass numbers UUIDs found in other strings. So `<id:N>`
     is not literal first appearance. Equal IDs still share a placeholder, which is the property A1 cares about. This
     is a wording mismatch between the spec and the code, not stuck/data-loss, and regenerating the snapshots is
     forbidden. **Accept.** The spec owner should describe the real order: ID keys first, then other strings.
   - *Fixed 50 ms PTY wait* (`L551`). Confirmed. It breaks the "waits on events" rule in plan.md, but no assertion
     depends on the fixture's output order, and none of the triage conditions applies. **Accept** as test hygiene.
     If it's ever fixed, wait on the PTY echoing `typed` in `written` instead.
   - *Sandbox fixture connection failure.* This was the environment, not the code. My own runs were green inside my
     sandbox, so the failure is specific to cod2a's environment. **Accept.** No repository change is needed.

## Report claims checked at `d11cd18`

- Line references for the 23 all-modes tests: L292, 302, 314, 335, 351, 365, 381, 391 (the report says 390 for the
  handoff; the `test(` call is on 391, which is negligible).
- Line references for the once-only tests: L419, 432, 450, 470, 492, 516, 534, 594, 614–636, 639–669. All match.
- Modes: `MODES` at L42 holds the three modes; handoff skips detached (L390). 35 tests in all, as reported.

## Independent gate evidence

I ran a fresh `git archive d11cd18` in `/tmp/clad2a-a1.gsAz`, with `node_modules` linked from the main checkout.
I ran `bun test test/conversation-turns/characterization.test.ts` three times, with logs in `/tmp/clad2a-char-{1,2,3}.log`:

| Run | Result |
| --- | --- |
| 1 | 35 pass, 0 fail, 35 snapshots, 321 expects, 15.35 s |
| 2 | 35 pass, 0 fail, 35 snapshots, 321 expects, 15.26 s |
| 3 | 35 pass, 0 fail, 35 snapshots, 321 expects, 23.20 s |

The snapshot SHA-256 after each run was `fbc6ec2c726524487bb942a0e0cd59948aac40670ae8394c97350f05d675b45d`, the same
value the report gives. I didn't rerun the full suite or the typecheck, so the report's 1,727/175 figures are not
independently checked.
