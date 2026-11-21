# How the specs are implemented

Written 2026-11-12. The organization every implementation run follows. The specs themselves are in the parent folder
(`../11-11-NOTE-overview.md` lists them and their order).

## Who does what

**One trio per spec**, numbered by the order specs start in:

| Role | Who | Does |
| --- | --- | --- |
| Orchestrator and gatekeeper | `bobN` | runs the loop for its spec: hands each brief to the implementer, asks the reviewer to review, does the gate check, releases the next brief; keeps the status file; talks to the other bobs about cross-spec state |
| Implementer | `agentcladN` | implements the spec's briefs in order, meets each gate, writes a report per brief |
| Independent reviewer | `agentcoN` | reviews each brief's commits against the spec, writes a review per brief; never edits `src/` |
| Spec owner | `cl-c` (Claude, in the user's main session) | owns the specs: fixes a spec when a bob finds a problem in it, does the final review of each spec |
| Owner | the user | decides what bobs escalate; releases each spec at the end (merge into `beta`) |

Running now: **trio 1, controller interface** (`bob-b`, `agentco-1`, `agentclad-1`). The next trio (`bob2`,
`agentco-2`, `agentclad-2`) starts when its spec is ready for implementation (Order and readiness, below).

**Why this shape:** a bob can talk to its agents and to other bobs, and hear back; the spec owner can send but not
read messages, so it stays out of the per-brief loop. Each bob has only two kinds of conversation: with its own
trio, and with other bobs.

## Communication: through files, not chat

Anything someone else needs to act on is a file in the repo, committed, so every role (including the spec owner and
the user) can read it without the hub. Messages between agents only point at files ("A2 is ready, report at …").

**Branches per spec** (`<spec>` is a short name, e.g. `controller-interface`):

| Branch | Who commits | What |
| --- | --- | --- |
| `<spec>` | the implementer | the implementation, and its reports |
| `<spec>-reviews` | the reviewer | its reviews |
| `<spec>-status` | the bob | the status file and gate results |

Each agent works in its own worktree. A branch can be checked out in only one worktree, so the reviewer and the bob
read the implementation with `git log` / `git diff` / `git show`, or a copy (`git archive`), never by checking out
`<spec>`. All three branches start from `beta` at the commit named when the spec starts. Nobody merges into `beta`
and nobody pushes: the user does, after the spec owner's final review.

**Files** (paths inside `.res/somelogs.md/11-11+/`):

| File | Branch | Written by | Contents |
| --- | --- | --- | --- |
| `library/reports/<date>-REPORT-<brief>.md` (or `harness/reports/`) | `<spec>` | implementer | commits, gate results with test count and time, line counts the brief asks for, deviations from the spec and why, open questions |
| `library/reports/<date>-REVIEW-<brief>.md` | `<spec>-reviews` | reviewer | findings ranked by severity with file and line, whether each gate holds, independent gate evidence |
| `.plan-execution/status/<spec>.md` | `<spec>-status` | bob | where the spec is: each brief's state (not started, implementing, in review, gate passed, blocked), commits, open questions and who they wait on |
| `.plan-execution/status/<date>-GATE-<brief>.md` | `<spec>-status` | bob | the gate check: commands run, results, the verdict, what was accepted and why |

## The loop, per brief

1. **bob → implementer:** "implement brief X" (the spec's brief section is the brief).
2. **Implementer:** implements step by step, meets each step's gate, commits the report, tells bob.
3. **bob → reviewer:** "review brief X at commit …".
4. **Reviewer:** reviews, commits the review, tells bob.
5. **If the review has blocking findings:** bob sends them to the implementer; back to 2. A finding that is a problem
   in the spec itself goes to the escalation path instead of being worked around.
6. **bob: the gate check** (below), recorded in a GATE file and the status file.
7. **Passed:** bob releases the next brief (back to 1). The last brief of a spec: bob tells the user and the spec
   owner that the spec is ready for the final review.

## The gate check

Done by the bob, on the brief's final commit, never in an agent's worktree:

1. **A clean copy:** `git archive <commit> | tar -x -C <tmp dir>`, with `node_modules` linked from the main checkout.
2. **Typecheck:** `bun run typecheck`, clean.
3. **The full suite:** `bun test`, green, with the test count at least the previous gate's plus the brief's new tests.
   Run it with its output saved to a file; a gate passes on a complete green run, never on separate subsets.
4. **What must not change, didn't:** snapshot files unchanged unless the brief allows a change (then the change is in
   its own commit, showing only what the brief allows); `src/` untouched where the brief says so; anything the brief
   says must not be touched.
5. **The diff matches the brief:** every step done, nothing outside the brief's scope (an exception the user approved
   is in its own commit and named in the report).
6. **The brief's own gates and done criteria,** as the brief lists them (line counts, conformance, etc.).
7. **The reviewer's verdict** holds for the same commit.
8. **The report's open questions:** answered, accepted with a reason, or escalated.

The verdict and the evidence go in the GATE file.

## Escalation

- **To the user** (they talk to the bobs): a decision only the owner can make: a scope exception (touching what a
  brief says not to), a change in behaviour, anything spending tokens or live harness runs, an open question the
  spec doesn't answer.
- **To the spec owner** (through the user, who relays): a problem in the spec itself, so the spec is fixed rather
  than worked around. The fix lands on `beta`; the bob tells its agents to bring it in.
- **To other bobs:** cross-spec state: one spec waiting on another, a shared contract (the harness protocol) that
  changes, a conflict in files both touch.

## Rules for every agent

- **Commits:** explicit paths only (`git commit -- <paths>`; new files `git add -- <exact paths>` first). Never
  `git add -A` or `git add .`. Never push. Never merge into `beta`.
- **Never touch:** the worktree `.agents/.workspaces/metering-c`; the user's `opencode` process (PID 475472); the
  user's untracked files in the main checkout (`todo.md`, `README-n.md`, `.agents/`, `.res/somelogs.md/harness.md`);
  other agents' worktrees.
- **No live harness runs** (no real Codex, Claude, OpenCode or Grok sessions, nothing that spends tokens) unless the
  user authorizes it for that run; tests run offline with the fixture agents.
- **Snapshots are never loosened or regenerated to make a test pass.** A changed snapshot means order or ids changed;
  the code is fixed. Waits in tests are on events, never fixed delays.
- **Nothing waits forever** in what we build: every new wait is bounded or cancellable, and names which.
- **Temporary files outside the repo.**
- **If a brief doesn't fit one run:** commit what passes its gates, report where it stopped.

## Code quality

- **Reuse first.** Each brief starts with a search for existing code that does the job. The report lists what was
  reused, and any new helper that resembles existing code, with why it couldn't be reused. The reviewer checks for
  duplication as a finding category.
- **Large files don't grow:** `src/agent-session.ts`, `src/client.ts`, `src/agent/conversation-manager.ts`,
  `src/controller.ts`. Code needed there is extracted into a module first; the report gives their line counts before
  and after.
- **One concern per new module.** A new file over about 400 lines is called out in the report, with why.
- **Existing mechanisms, not parallel ones:** errors in the existing error modules; events added to the existing
  unions; records through the existing record kinds; storage through the persistence backend (optional repositories
  with a capability flag), never straight to SQLite.
- **Grounding before a spec's first brief:** the implementer checks the spec's "code as it is" and reuse points against
  the code at that moment and reports what moved or doesn't exist; the spec owner corrects the spec before the first
  brief.

## Triage: what gets fixed

Decided 2026-11-13, to stop the design growing on edge cases. A finding (in a review, a gate check, or while
implementing) is **fixed** only if it:

- can leave the agent or a channel stuck;
- silently loses data in normal operation;
- contradicts another part of a spec (then the wording is fixed, often by stating a limitation).

Anything else is **accepted**: the spec owner records it in the spec's Limitations section, and nobody designs around
it. An edge case that existed before and wasn't handled stays unhandled unless it meets the rule above.

**Every bug or error found is written down, even when it isn't fixed:** one new Markdown file per error in
`$AGENTS_COMMON_ARTIFACTS_DIR/errors/`, named `<date>-<short-slug>.md`, with:

- **What:** the behaviour seen, and what was expected;
- **Where:** files and lines, the commit, the brief;
- **How it was found,** and how to reproduce it (a test name, steps);
- **Impact:** what it can break, and how likely;
- **Status:** fixed (with the commit), accepted (with the triage reason), or left for the owner to decide.

The report or review that found it links the file.

## Order and readiness

| Spec | State | Trio |
| --- | --- | --- |
| Controller interface (`library/11-11-SPEC-controller-interface.md`) | implemented and merged (`9668cf7`, base `004cc7f`); spec updated to the code 2026-11-21 | done |
| Harness protocol (`11-12-SPEC-harness-protocol.md`) | first design; shared by integration and harness part 1 | (no code of its own) |
| Native harness integration (`library/11-11-SPEC-native-harness-integration.md`) | stage 2a core built by the harness's integration work (approved `7133c5c`); revised 2026-11-21; Remaining work 1–7 listed, briefs to write | next: Remaining work 1 (durable channel intents) |
| Harness project setup and harness part 1 (`harness/11-11-SPEC-harness-project.md`, `harness/11-11-SPEC-harness-v1.md`) | not yet reviewed on their own | next, in parallel |
| Orchestrator (`library/11-11-SPEC-orchestrator.md`) | reviewed, plan written (G, O1–O6); route revised 2026-11-21 to registered tools | after integration Remaining work 1–3 |
| Integration stage 2b, harness part 2 | after 2a and part 1 | later |
| CLI (`library/11-11-SPEC-cli.md`) | lowest priority | last |
| End-to-end robustness (`11-12-SPEC-end-to-end-robustness.md`) | after everything that builds is done | last |
| `billing_required` for native | moved into integration stage 2a (brief N10) | — |

A spec is ready for a trio when it has its implementation briefs (steps with gates, a test plan, done criteria,
risks) and has passed the spec owner's reviews.
