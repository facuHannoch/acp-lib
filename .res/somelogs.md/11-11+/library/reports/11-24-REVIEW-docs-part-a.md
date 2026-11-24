# Review: 0.13 docs Part A (`docs-0.13-update`, b53c9f2 to ec1796f)

Reviewer: clad2a-s. Clean `git archive` of ec1796f on `/dev/shm`; no edits to the branch.

Verdict: **approve with 4 small fixes** (two omissions in neighbouring docs, one stale count, one wording). Every claim I could check against the code is true, and the snippets compile.

## Scope and gate

- Diff b53c9f2..ec1796f is **three docs files only** (`CONSUMER_GUIDE.md`, `MIGRATION-0.12-to-0.13.md`, `CHANGELOG-operation-lifecycle.md`): no `src/` or `test/` change.
- `tsc --noEmit`: exit 0. Plain `bun test`: **2,162 pass / 0 fail, 225 files, 35 snapshots**. No test reads the markdown files (grep of `test/` and `src/` found none), so "doc-related tests" reduces to the suite as a whole.
- `bun pm pack --dry-run`: both guide, changelog and migration files are in the tarball; `src/native-harness/README.md` (the link target of the harness section) is packed too. Anchors `#message-status` and `#provider-notices-retries-warnings-and-failures` exist.

## Snippets (compiled with a temporary tsconfig mapping `@qlairoslabs/acp-client` to `src/index.ts`; a deliberate type error was reported, so the check is live)

- The `promptWithStatus` guide function: compiles (imports `AgentConversation`, `MessageStatus`; `handle.status`; `subscribe` narrowing to `message_status`; `await handle`; unsubscribe in `finally`).
- The provider-notice `onActivity` fragment: compiles with `handlers: PromptHandlers`; `severity`, `category`, `code`, `title`, `actions`, `noticeId`, `revision` all have the documented types.
- Migration claims as types: `PromptHandle.status: MessageStatus`; `AgentSessionEvent` and `AgentConversationEvent` both narrow to `message_status` with `turnId?: string`. All compile.

## Claims checked against the code

- Status values and order (`queued, received, taken, delivered, seen, withdrawn, failed`), forward-only, `turnId` optional: `message-status.ts`.
- Native uses harness milestones; ACP reports received/taken/delivered together at dispatch (`advance(id, native ? "taken" : "delivered")`) and `seen` at first output; `withdrawn` only before a take; live only (tracker is in memory): all as in `agent-session.ts` and `message-status.ts`.
- AIR: `clientCapabilities._meta` carries `jetbrains.air` version 1 with `sessionFailure` (`provider-notices.ts`, `client.ts`); Codex fallback `_meta.codex.error`; notices become `provider_notice` activities with the documented fields; `meta` exists on `session_info` and `usage` events (`types.ts`); a stall carries `details.providerCode`.
- Exports: I recomputed the public entry with the TypeScript API: 510e2a7 = 913 names, fb20ed6 = **915**, none removed, added `MessageStatus` and `MessageStatusEvent`. `package.json` between them changes only `files` (adds the controller changelog and this migration); exports map and dependencies are unchanged, so "unchanged through fb20ed6" is true.
- Version/status line: `package.json` is 0.12.1; `alpha` is fb20ed6; "covers `alpha` through `fb20ed6`, version remains 0.12.1, 0.13 unpublished" is accurate.
- Harness section: `timelineTools` exists in the managed session config (`contracts/config-permissions.ts`) and as `--timeline-tools` in the CLI; the tools are `search_timeline` and `read_message`; README says search can span native channels in one session; bounded model-call paging is 31ffb79; CLI `--instructions`, `--debug`, `--debug-tools` are documented in the harness README. SQLite harness storage format was already 6 at 510e2a7, so no storage upgrade is missing.

## Fixes

1. **Stale count.** The migration now says the package entry "had 913 exports" at `510e2a7`, but the note claims coverage through fb20ed6, where the entry has 915 (adds `MessageStatus`, `MessageStatusEvent`). Say "913 at 510e2a7, 915 at fb20ed6" (or name the two new types) so readers do not take 913 as current.
2. **Guide message-event table not updated.** `CONSUMER_GUIDE.md` "Events and results" (around line 1819) lists `message_pending`, `message_delivered`, `message_withdrawn` only; `message_status` is now in the same event union (`MessageEvent`). Add a row, or say that the table lists waiting events and point to Message status.
3. **README activity list not updated.** `README.md` (around line 132) says every update reaches `onActivity` discriminated by `kind` and lists `thinking ... session_info, config, unknown`. `provider_notice` is missing from that list.
4. **Wording.** Under `## 0.12.0` in the lifecycle changelog the line "It landed on `beta` while the package version still read 0.11.2." now has no antecedent after the heading; restore the subject ("0.12.0 landed on `beta`...").

## What the migration still lacks (user-visible since 510e2a7, left for Part B)

All remaining user-visible changes between 510e2a7 and the branch head are the reminders track, which Part B covers:
- Library: `agent.reminders`, `conversation.reminders`, `conversationCapabilities.reminders`, the `reminder_intent_*` and harness `reminder_*` event kinds on the conversation union, `AgentConfig.reminders` and the harness options `idleStopMs`, `idleStopWindowMs`, `reminderTimer`, and `Reminder`/`ReminderError` exports (the entry will exceed 915 names).
- Storage: SQLite schema **22**. The migration still says a 0.12.1 database "opens at schema 21" (true for alpha at fb20ed6; Part B must change it to 22), and the R7-era schema-22 fail-fast message.
- Harness: one-off reminder tools and `reminder/*` methods, `session/stop { ifIdle }`, `reminders_due`; the harness README already documents them, the migration does not.
- Behaviour: a SQLite owner arms a cold-wake timer that can start the harness; explicit `stop()` keeps it, `Agent.close()` clears it.

Not user-visible and correctly omitted: the characterization snapshot change for the advertised AIR capability, the harness web-chat and inspector tweaks. Optional: the harness tool catalog reserves the names `search_timeline` and `read_message` (a host catalog using them is rejected as "already used"); worth one sentence in the harness README.
