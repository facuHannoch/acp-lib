# Organization II: proposed fast way of working (proposed 2026-11-24)

Written by core-p, for comparison with `11-24-organization-I.md`. Decided with the user on 2026-11-24: build and test, merge,
publish, review afterwards; as many agents as needed; a new line of work after each publish is fine; accept a small risk of
breakage; protected-file line ceilings waived; `permissions.unanswered` offers both values with `"reject"` as the default.

## 1. Principles

1. **Ship small and often.** A wave is a set of independent lanes that merge and publish together (an alpha.N).
2. **The builder owns quality.** Code, tests and docs in one lane by one agent. Tests are required to merge; review is not.
3. **Review after publishing,** in parallel with the next wave, on the shipped SHA. Findings become tickets in the next wave.
4. **One full-suite run per wave** on the merged result, by me. Lanes run only their own tests.
5. **Contracts with other teams still go through a written pin.** Anything crossing into the harness (wire, types) is the one
   place where we keep a gate, because rework there is expensive.
6. **Less paper.** One short ticket per lane (a paragraph), one running log per wave. No brief, report and approval rounds.

## 2. Roles

| Role | Who | Does |
| --- | --- | --- |
| Integrator | core-p | tickets, merge order, the wave suite, publish commands, cross-team contact, the log |
| Lane owners | cod2a-r, cod2b-t (and more agents as lanes need them) | build, test, document, merge their lane into alpha |
| Post-publish reviewers | clad2a-s (and a second reviewer when the wave is large) | review shipped SHAs, mutation-test the riskiest lanes, stress flaky areas, file findings |
| Harness team | haurness-l, Cod1a, Clad1a, Clad | contracts, runtime, SDK types; their own process is theirs to choose |
| Publisher and decider | the user | defaults, publishing (`npm publish --tag alpha`), priorities |

## 3. Cadence of a wave

1. Integrator writes tickets (what, acceptance, which shared files it touches). Lanes start at once.
2. Lanes build, test, merge into alpha when their tests and typecheck pass; tell the integrator the SHA.
3. Integrator merges order for shared files (config types, `agent.ts`, `host.ts`), runs the full suite once, fixes or reverts a
   broken lane, then hands the user the publish command and the exact SHA.
4. After publishing: reviewers review the shipped SHA; the next wave starts immediately in parallel.
5. Severity of findings: a bug that corrupts data or blocks start gets a patch release the same day (alpha.N+1); anything else
   goes into the next wave.

## 4. Test rules (the safety net that replaces pre-merge review)

- Every lane adds tests for each requirement and each refusal it introduces.
- Anything touching persistence has an upgrade test from the previous schema.
- Anything crossing the harness boundary has a real-stdio test (deterministic fixture model) before it counts as done.
- A known-flake list is kept; a failing test on it is rerun once, anything else blocks the merge.
- Reviewers mutation-test only the riskiest lane of each wave, and run the stress loop on flaky areas.
- Live-model runs are done by the integrator at the end of a wave for the user-facing paths (cheap model, small cost).

## 5. Rules I am dropping or changing

| Organization I | Organization II |
| --- | --- |
| Brief, report, review of report, go, build | one ticket, build |
| Gate by implementer, by me and by the reviewer per step | one wave suite by me; lanes run their own tests |
| Review before merge | review after publish |
| Protected-file line ceilings | waived (a cleanup lane later) |
| Candidate branches merging implementation, reviews and status | lanes merge straight into alpha |
| One document per step | one log per wave |
| Fixed implementer per feature | lanes reassigned freely; an idle agent can take a new lane |

## 6. What we accept in exchange (risks and mitigations)

| Risk | Mitigation |
| --- | --- |
| Defects reach published alphas | lane tests are mandatory; post-publish review within the wave; same-day patch releases for serious bugs; the user is the only consumer today |
| Lanes collide in shared files | declare shared files in the ticket; one owner per shared file per wave; fixed merge order |
| Contract rework with the harness | keep the written pin and the typed SDK commit as a hard gate for anything crossing the boundary |
| Flaky tests blocking merges | known-flake list, one rerun, flake fixes as their own tickets |
| Loss of audit trail | the wave log lists lanes, SHAs, results and findings; reviews are still written, just after |

## 7. Decisions fixed for the first waves

- Requirement 2: `permissions.unanswered: "reject" | "cancel"`, default `"reject"` (what alpha does today). The hub passes
  `"cancel"` for agents that need the 0.12 behaviour.
- Ceilings waived.
- Native tools are function definitions with handlers in the consumer's process; native MCP servers are not supported.
- System prompt is `harness.config.system`, per Agent, replaced fully at start.

## 8. The waves

| Wave | Lanes | Owner | Output |
| --- | --- | --- | --- |
| 1 | (1) `terminalEnv`, (2) unanswered-permission setting, (6) native tools and policies documented and tested, (7) system prompt confirmed and documented, migration status line | cod2a-r | alpha.2 |
| 2 | (3) restart a native agent (when idle or now, conversation count), (4) channel settings live (what the harness can apply live) | cod2b-t | alpha.3 |
| 3 | (5) `harness.model` with inference sources: the harness contract first (haurness-l), then the library pass-through | harness team, then a library lane | alpha.4 |
| continuous | post-publish review of every shipped wave | clad2a-s | findings into the next wave |

Open items outside the waves: the CLI spec, the end-to-end robustness spec, routine edge cases not covered over real stdio,
agent-created reminders tested with a live model.

## 9. How to compare with Organization I later

Record these per wave from the start (Organization I could not measure the ones marked "new").

| Metric | Organization I baseline | Organization II: record |
| --- | --- | --- |
| Time from ticket to merged lane | not measured (new) | per lane |
| Time from first ticket to publish of the wave | not measured (new); calendar span 3 days for the whole track | per wave |
| Features published per day | reminders + routines + typed client + guard in about one day after planning | per day |
| Docs commits as a share of all commits | about 52% | per wave |
| Full-suite runs per merged feature | about 3 (implementer, me, reviewer) | per wave (target 1 plus lane-local runs) |
| Defects found before publish / after publish | about 14 found before merge by review, joint tests and stress; none known after | both counts, with severity |
| Patch releases needed | 0 | count |
| Agent idle time waiting on the integrator | not measured (new) | per wave, estimated from message timestamps |
| Tests added per wave and suite size | 1,727 to 2,237 over the track | per wave |
| Live-model verification | one run at the end | per wave |

Questions the comparison should answer: did shipping first increase the number of post-publish defects, how serious were
they, and how much faster was a request to publish? If defects after publish stay low and lead time drops by a large factor,
keep Organization II. If serious regressions appear, add back one pre-merge check for the riskiest lane only.
