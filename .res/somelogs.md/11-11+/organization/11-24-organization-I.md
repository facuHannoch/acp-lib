# Organization I: how the acp-client track worked (2026-11-22 to 2026-11-24)

Written by core-p (coordinator) on 2026-11-24, at the point where the user asked to move faster. Purpose: a record of the
way of working we used, with results, problems and numbers, so it can be compared with Organization II later
(`11-24-organization-II.md`). Where a number is measured it says where it comes from; where it is my estimate it says so.

## 1. Scope covered

- Spec 1: controller interface verification (A1, A2, B1, B2, flake fixes, native fixes).
- Spec 2: native harness integration R1 to R6, and the merges of the harness track's work into alpha.
- Spec 3: orchestrator, workers and delivery (live Codex runs included).
- Release preparation: consumer guide, migration note, package contents.
- Reminders and routines: planning (plan revisions 1 to 5 and 11 addenda), R7 (library store and model), R8 (wire, cold wake,
  idle stop), R8.5 (typed harness client), R9 (routines, guard), the joint real-stdio acceptance (two slices), a live test.
- Ended with: alpha published as `0.13.0-alpha.1` (tag `alpha`, `latest` stays 0.12.1).

## 2. Structure

| Role | Who | Work |
| --- | --- | --- |
| Coordinator and gatekeeper | core-p (me) | briefs, rulings, clean-archive gates, candidate branches, merges, cross-team messages |
| Implementers | cod2a-r (R1 to R6, release docs, docs for reminders, R9 Part 1), cod2b-t (R7 to R9, joint tests) | build, test, report |
| Independent reviewer | clad2a-s | reviews, mutation testing, stress runs, gate reruns |
| Harness side | haurness-l (coordinator), Cod1a (runtime), Clad1a and Clad (harness review) | contracts 0031 and 0032, runtime, SDK types |
| Decision maker | the user | scope, defaults, merges and publishing |

One git identity is shared by every agent, so commit authorship cannot separate their work.

## 3. The workflow (per feature)

1. Spec or plan, with open questions sent to the contract owner and answered in writing (pins, decisions 0031 and 0032).
2. Brief written by me, stored as a file, sent by message.
3. Implementer's Part 1: a grounding or conformance report, documentation only. Implementer stops and waits.
4. Reviewer reviews that report. I read it, add rulings, give the go.
5. Implementer's Part 2: build in stages, each with its own full-suite run and repeats of new tests.
6. My own clean-archive gate (a fresh `git archive` copy, RAM-backed `TMPDIR`, typecheck plus the full suite).
7. Independent review: gate rerun, requirement check, mutation testing (break the code, see if a test fails), stress runs.
8. Fix round, then re-review, then my re-gate. Repeat until the reviewer approves.
9. Candidate branch (merge of implementation, reviews, my status docs), final gate, then merge into alpha (the user at first,
   then me with the user's go-ahead).
10. Harness-side confirmation of the exact SHA before integration.

Every step produced a document: brief, report, review, gate record, log entry, plan addendum.

## 4. Numbers

Measured from git and the repository on 2026-11-24.

| Measure | Value | Source |
| --- | --- | --- |
| Calendar span | 3 days (2026-11-22 to 2026-11-24) | commit dates |
| Commits `d11cd18..alpha` (all agents, all tracks) | 666 (256, 235 and 174 per day) | `git rev-list` |
| Of those: docs commits / merges / fix / feat / test | 345 / 93 / 34 / 33 / 15 | commit subjects |
| Docs share of commits | about 52% | same |
| Source and test churn, excluding the harness | 223 files, +20,256 / -1,578 lines | `git diff --shortstat` |
| Harness churn since 0.12.1 baseline (`510e2a7`) | 171 files, +8,535 / -896 lines | same |
| Documentation churn (guide, migration, README, changelogs) | 6 files, +1,278 / -45 | same |
| Tests (full suite) | 1,727 in 175 files (2026-11-22) to 2,237 in 234 files | gate records |
| Reminder and routine source / tests | about 2,300 / about 2,600 lines | `wc -l` |
| Review and report files kept | 95 (56 reviews, 39 reports), 6,086 lines of review text | library/reports |
| Gate status records | 29 | `.plan-execution/status` |
| Local branches | 127 | `git branch` |
| Plan document | 359 lines after 11 addenda | plan file |

Estimates, not measured:
- My own clean-archive full-suite runs: about 40 (each 3 to 4.5 minutes, so about 2.5 hours of machine time), on top of the
  implementer's runs and the reviewer's runs of the same suite. Each step therefore ran the suite roughly three times.
- Review rounds per feature, counted from the review reports: R7 3 (grounding, code, follow-up), R8 about 8 (conformance,
  code, follow-up, joint, joint follow-up, cold-wake, docs), R9 about 7 (conformance, code, follow-up, final, unlimited, joint,
  slice 2).
- Messages exchanged: not measurable from here (hub history is not exported).

## 5. Results

Shipped and in alpha:
- Reminders (one-offs) and routines (`every`, `cron`, `count`/`until`, `missedRuns`, `overlap`), unattended-turn guard
  including `"unlimited"`, typed harness client, harness runtime for routines (timezone data, guard persistence).
- Native tools, policies and system prompt per Agent (documented).
- Real-stdio joint tests against the real harness (14 + 9 cases), live run with a real model: a one-off and a two-run routine
  fired on time with correct replies.
- Consumer guide, migration note, package narrowed (596 to 398 files), published as an alpha.

Defects the independent process found after the implementer reported green (from reviewer reports and gate notes), about 14:
1. R5/R6: usage lost on a double failure, a stop-behaviour regression, a Bun timer bug, flaky tests (fixed before release).
2. R7: a service rebuilt with a fresh in-memory store on every access (state lost); edits accepted on cancelled reminders;
   explicit `startAt` and zero-length expiry not validated; five requirements with no test (mutants survived).
3. R8: channel-batch `invalid_params` wrongly quarantined innocent reminder entries; four rulings without tests.
4. Joint testing: our change type did not match the harness's strict types (typecheck failure at the merge); a deadline message
   arriving during an explicit stop was dropped, so the wake was lost (found by stress repeats, a real product bug).
5. R9: a persisted marker made an agent unable to start after a failed create (two variants, B1 and B1'); event dedupe that
   broke a ruling; a routine marked dead on an expiry event.
6. Test flakes found: a pre-existing harness startup race, a wall-clock race, a production-launcher timing race.

The reviewer's mutation testing (break the code on purpose) was the most productive technique: about 90 mutants were
killed across R7 to R9 and about 15 survived, each survivor being a missing test.

## 6. Problems

1. **Latency.** A step was a serial chain (report, review of report, go, build, my gate, review, fixes, re-review, re-gate,
   merge). A small change cost hours. The chain was designed for safety, not speed.
2. **Triple execution.** The same full suite ran by implementer, by me and by the reviewer for every step.
3. **Coordinator bottleneck.** Every message, ruling, gate and candidate went through me; agents idled waiting for my go.
4. **Process documentation load.** About half of all commits were documents. Briefs, reports, reviews, logs and plan addenda
   were useful for audit but dominated the history.
5. **Message reliability.** Inboxes were sometimes busy and refused messages (twice in a row once), full names with suffixes
   were required, and messages sent in pieces left one implementer idle without acting, so it had to be replaced.
6. **Late contract discoveries.** Several of my earlier assumptions were overturned by the contract owners (fence reset on open,
   one-off only first, `expired` as a state not a cancel reason, the guard requirement). Each cost a rework round.
7. **Size ceilings.** Protected-file line limits forced extraction commits and an extra review step before any change
   (`host.ts` sat at 909 of 909 for days).
8. **Flaky tests under load** made gates ambiguous; deciding "flake or regression" took repeated runs and reviewer time.
9. **Context loss.** The coordinator's context was compacted several times; continuity depended on logs and status branches.
10. **Late real-world check.** The first run with a live model came last, after all the structured review, and found nothing:
    the reviews had already covered it, but it was the slowest path to that answer.

## 7. What worked and is worth keeping

- Contract-first with pins in writing, and a scripted peer built only from the contract.
- Real-stdio joint tests against the real harness, which found a bug no unit test found.
- Reviewer mutation testing and stress runs.
- Clean-archive gates (they caught environment-dependent failures).
- A written plan with dated addenda, which made later comparison and recovery after context loss possible.

## 8. Data I could not measure

Wall-clock time per step, number of messages, agent idle time and cost per agent. Organization II defines these so they can be
recorded from the start.
