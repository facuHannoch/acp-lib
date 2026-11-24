# Check: the `"unlimited"` guard option (`scratch/r9-sdk-e594870` at 9ea791b)

Reviewer: clad2a-s. Clean `git archive` of 9ea791b on `/dev/shm`; no `src/` edits; probes and mutants on separate copies.

Verdict: **approve. No findings.** The option is validated strictly, encodes to the wire as a number, is compared numerically in both directions, and nothing outside the change set moved.

## Gate

- Root `tsc --noEmit`: exit 0. Harness `bun run typecheck`: exit 0.
- Plain `bun test`: **2,193 pass / 0 fail, 226 files, 35 snapshots** (2,191 before).
- Joint one-off real-stdio file: **20/20** (12 tests each). The two new tests, each 20x in isolation: 40 runs, 0 failures.
- `src/native-harness/` vs the combined base `70b1a5d`: empty diff. host 909, native/controller 591, agent-session 4,527.

## Diff scope

Nine files: `routine-guard.ts` (`configForOpen`), `routine-wire.ts` (new public input type `RoutineConfigInput`: `Omit<ProtocolConfig, "limits"> & { limits?: { unattendedTurns: number | "unlimited" } }`), the three type-signature sites (`agent/config.ts`, `host-config.ts`, `recovery.ts`), a new type test, one test file, guide and migration. Held/guard admission, staging, retry and wake logic are untouched. `ProtocolConfig.limits` in the SDK has only `unattendedTurns`, so the narrower input type loses no field. One incidental behaviour: when `unattendedTurns` is absent, `configForOpen` now returns the config without a `limits` key (before it returned the input object); a `limits: {}` could not exist by type, so this changes nothing observable. `configForOpen` is called only from `openOrCreate`, so inspection reads still never carry the field.

## Validation edge cases (probe through `RoutineAdmission.configForOpen`, supported peer)

`0`, `-1`, `NaN`, `1.5`, `Infinity`, `"Unlimited"`, `"UNLIMITED"`, `"5"`, `"unlimited "` (trailing space), `5n` (bigint), `null`, `Number.MAX_SAFE_INTEGER + 1`, `true`, `[]`: **all `invalid_config`** (a `ReminderError`, before any RPC). Accepted: `1`, `Number.MAX_SAFE_INTEGER`, `"unlimited"`. On a peer without routines/guard support: a valid value gives `HarnessIncompatibleError`, an invalid value still gives `invalid_config` first (same ordering as before). Numeric strings and bigint are rejected by the type test in the code path (`typeof value !== "number"`, backed by `Number.isSafeInteger`; that `typeof` clause is redundant with `isSafeInteger` but harmless).

## Encoded value and reopen

- `"unlimited"` goes on the wire as the number `9007199254740991` (`Number.MAX_SAFE_INTEGER`), which JSON represents exactly.
- Comparison is on the number the harness confirms (`opened()` stores the numeric `maxConsecutiveTurns`; `bound === value` compares numbers). Probed through `openOrCreate` with the routine peer: first `"unlimited"` then `MAX_SAFE_INTEGER`, first `MAX_SAFE_INTEGER` then `"unlimited"`, and `"unlimited"` twice: the first open sends `unattendedTurns: 9007199254740991`, the second open sends no `limits` (equal recognised in both directions), and a third open with `5` sends `5` and the peer answers **`invalid_config`** (a genuinely different value is still refused).

## Mutants (new and neighbouring tests)

Not converting the sentinel (sending the string): **killed**. Always sending the field even when bound: killed (2 tests). Never sending it (treating every value as bound): killed (9 tests). Case-insensitive sentinel: killed. Accepting floats: killed. Accepting 0: killed (2 tests). Type level: removing the `@ts-expect-error` on `"Unlimited"` makes `tsc` fail on that line; widening the public type to include `"Unlimited"` makes `tsc` fail ("Unused '@ts-expect-error'"), and the second type test pins that the sentinel cannot be a wire value.

## Docs

Guide and migration say: the setting accepts a positive safe integer or `"unlimited"`; `"unlimited"` sends `9007199254740991`; the guard stays on and keeps counting; unattended paid turns are effectively uncapped; a spending cap is still a TODO; both spellings bind the same value and the harness refuses later different values. All of this matches the code and probes (the guard does not switch off: the bound value is a positive safe integer, so the counter still runs and the channel can still be exhausted only at 2^53 - 1 turns). One note, accurate but worth keeping in mind: because the guard stays enabled, `conversationCapabilities.routines` still requires the executable-open confirmation, exactly as with a numeric limit.
