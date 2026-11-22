# Review — alpha `713a76a` merge into controller-interface-verify

This review covers merge `4cd3ce96` (parents `9016c0c` and `713a76a`) and the report `32d30d0`. I read them with
`git show --cc` and a clean `git archive 4cd3ce96` copy (`/tmp/clad2a-am.P3kD`); I didn't check out the branch.

**Verdict: no blocking findings.**

- Both conflict resolutions are correct.
- The media preflight covers every native send path that can carry media.
- No test of ours depends on the removed native wire methods.
- Both probes still refuse.
- The intermittent rehearsal failure is alpha's: it also happens on a clean `713a76a` archive with no merge. It
  isn't caused by the merge.

## (1) Conflict resolutions

- **`src/native/controller.ts` `send`.** The order is:
  1. duplicate-ID and stopped checks;
  2. our media preflight over the whole run;
  3. alpha's lazy `if (!this.#detach) await this.start();`;
  4. the push loop.

  This is correct. An invalid run is refused before alpha's lazy attach, so a refused prompt doesn't even start or
  attach the channel. Nothing else from either side was dropped. The combined diff shows only the two blocks placed
  one after the other.
- **`test/native/checkpoint.test.ts`.** The conflict was only in the import block. `spyOn` was kept together with
  alpha's seven new imports. The test bodies merged without conflicts, and our two guard tests are present and pass.

## (2) Does the media preflight cover alpha's send paths?

I looked for every place in `src/native/` and the session/turn code that sends input to the harness:

- `NativeController.send` (`controller.ts:249`) is the only caller of `host.push` in library code. Both queued and
  steered prompts reach it.
- `NativeHarnessHost.push` (`host.ts:695–711`) and the resubmission at reopen (`host.ts:584–590`) work on
  `Submission` records. That type has only `{ id, channel, sender, text }`, so it can't carry media, and every
  submission saved by the controller has already passed the preflight.
- `Agent.nativeHarness` exposes the host publicly, so a consumer could call `host.push` directly. That path is
  text-only by type, so no media can be lost there either.
- Alpha's external notices and operator controls are on the harness side (`src/native-harness/`). They don't add a
  send path on the client side that takes consumer content.

**The preflight covers everything.** My M2 note from the native-fixes review still applies: forwarding parts has
to arrive in the same change that enables a media flag.

## (3) No test assumes the old wire paths

- `session/load` still appears only in ACP fixtures (`identity`, `config`, `lifecycle`, `replay`, `media`,
  `presentation`, `echo-prompt`) and in ACP tests (`media-client.test.ts`, the `turn-path.test.ts` hold on the ACP
  lifecycle fixture). ACP still has `session/load`, so these are correct.
- In the native harness, the only mentions are alpha's own checks that the methods are *gone*:
  - `operator-controls.test.ts:24–25` checks that neither method is advertised;
  - `protocol.test.ts:129` checks that `session/load` gets `method_not_found`.
- `test/native/` and `src/native/` don't mention either method.
- Our native guard tests use the public API plus a `host.push` spy.

## (4) The rehearsal failure

| Archive | `bun test test/native/rehearsal.test.ts` |
| --- | --- |
| Merge `4cd3ce96`, 5 runs | 4 green, 1 failed: *"settlement accounts for more than one reconcile page of inputs"*, `rehearsal deadline before all work settled` (25.1 s) |
| **Alpha `713a76a`, with no merge**, 6 runs | 5 green, 1 failed: *"the timed fixture runs in CI with shortened offsets…"* (10.7 s). This is the test cod2a saw fail. |

So the failure isn't from the merge.

- The rehearsal drives `NativeHarnessHost` directly and doesn't touch the merged controller code.
- Its source and scenario match alpha byte for byte.
- It fails at a similar rate on alpha alone.

Two different failure modes appear:

- **`Unused model records`** (cod2a's run and the alpha run). The shortened test divides send offsets by 25 and
  `quiet` tool delays by 10. Under load, an input can arrive while the previous turn is still running, and get
  folded into it instead of starting its own turn. That turn then uses fewer scripted model records, and the
  test's `exactConsumption` assertion fails even though every send `completed`. This is **test timing** in an alpha
  test, and the only thing wrong is the record count. Nothing is lost.
- **`rehearsal deadline before all work settled`** (my merge run). This one deserves attention. On its face it's
  "work didn't settle within the rehearsal's budget". The run took 25 s, the file ran 48 s in total, and the machine
  was loaded. That's most likely load again. But if a channel had really stopped settling, it would meet the triage
  rule's "can leave a channel stuck". I couldn't establish which from one occurrence.

**Recommendation: accept for this merge**, since the merge doesn't cause it and alpha alone shows it too. Hand both
modes to the alpha owner. When that test hits the deadline, it should print operator status (pending inputs and
open turns per channel). That would settle "slow" against "stuck" the next time it happens.

## (5) Probes on `4cd3ce96`

I reran `test/zz-probe/b1-probe.test.ts` (the same probe as in the B1 and native-fixes reviews) on the merge
archive:

- media: rejects with `UnsupportedError: a native conversation does not support file input`, and `pushes []`;
- handoff: rejects with a bare `UnsupportedError`, no `handoff_*` events, no new records, and the next prompt
  `completed`, phase `idle`.

Both still refuse.

## Other checks

- `bun run typecheck` on the merge archive: passes.
- `bun test test/native`: 90 pass, 0 fail, 7 files, 85.6 s.
- I didn't run the full suite. cod2a has two green `./test` runs (1,426) and a green root run (1,786).
