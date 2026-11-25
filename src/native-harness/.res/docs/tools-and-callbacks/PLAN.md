# Native harness tool implementation plan

Date: 2026-11-24

Status: Proposed.

Timeline retrieval is integrated. Reminders are the next implementation
priority, starting with the one-off contract and runtime. The web and shell
plans remain available for later scheduling.

| Slice | Depends on | First usable outcome |
| --- | --- | --- |
| Timeline retrieval | Tool registry and focused timeline reads | Search old conversation text and open the source message. |
| Web | Checked tool registration, provider configuration and tool usage evidence for paid calls | Search, then fetch a selected URL in the same turn. |
| Foreground shell | Checked tool registration and one supported runner | Run a bounded command in an explicit directory. |
| Attachments | Attachment storage and transport for input. A shared runner interface for copy and path-based sharing. | Send an image to a model or process an uploaded file and share the output. |
| Reminders | Session storage, channel lifecycle and durable inbox notices | Schedule a one-off and have it wake its channel while the harness is running. |

## Gate 1 · Tool admission and timeline retrieval

- Reuse native registration and dispatch in `src/capabilities/tools/`, including
  the catalog in `runtime/catalog.ts`. Pin the shared registration behavior first.
  An unavailable or malformed call receives a paired result before approval.
  An allowed invocation runs through the existing permission, dispatch evidence
  and cancellation paths. Standalone and stdio assemble the same definitions.
- Add `search_timeline` and `read_message` behind the storage read contract in
  `src/contracts/storage.ts`. Put the SQLite FTS5 projection and memory behavior
  in `src/state/storage/`. Reuse focused ID and channel range reads. Store the
  index transactionally and rebuild it on upgrade or import. Keep raw tool
  results out of the searchable corpus for v1.
- Pin the query, candidate and result limits and how clipping is reported.
  Exercise phrase and case-sensitive matching, shared timeline scope, reading
  by ID, and bounded same-channel neighbors. Check a long timeline with a
  common term. Measure ranking work separately from candidate verification.
  Use the snapshot instrumentation to verify the tools avoid full session reads.
- Run the same scripted scenario in standalone development chat and over stdio.
  Verify that an agent finds an older decision, reads its source and cites it
  with the correct channel attribution.
  [Timeline retrieval](../timeline-retrieval/0001-DESIGN/SPEC.md) ·
  [Gate plan](../timeline-retrieval/0001-DESIGN/PLAN.md)

## Gate 2 · Web search and fetch

- Put independent search and fetch adapters under `src/capabilities/tools/`.
  Use managed configuration in `src/runtime/config/managed.ts` for backend
  selection and environment credential references. Implement the Exa adapters
  against fixtures, including bounded results, provider errors and cancellation.
- Pin optional tool usage metadata in the execution result contract. Commit it
  with the paired result, keyed by invocation ID. Expose it through
  `src/interfaces/inspector/`. Test denied calls, reported cost on a failed
  extraction and unknown cost after dispatch without a committed result.
  Keep this gate independent of billing-grade model accounting.
- Build the credential-free HTTP adapter against the same fetch contract. Start
  a reusable extraction corpus and compare coverage, clipping and latency with
  Exa on the same URLs. Keep improving the corpus and adapter independently of
  search. Exercise destination checks on the initial request and redirects.
  Keep live paid comparisons opt-in. Verify one live search-to-fetch flow and
  inspect its usage before recommending a backend as the default.
  [Web tools](../web-tools/0001-DESIGN/SPEC.md) ·
  [Gate plan](../web-tools/0001-DESIGN/PLAN.md)

## Gate 3 · Foreground shell and attachments

- Pin the execution port under `src/contracts/` and assemble the first Linux
  runner under `src/runtime/execution/`. The shell tool lives under
  `src/capabilities/tools/`. Verify the supported environment's filesystem,
  network and credential boundary, explicit working directories, bounded
  output, approval, deadline and cancellation. Use concurrent channels and
  confirm descendant cleanup in the supported environment.
- Build managed attachment upload, storage and references through the state,
  protocol and context contracts. This input slice can proceed before shell.
  Verify an image sent from the client reaches the model in the correct message
  position and a retained file survives reopen and managed export/import.
- Add `copy_attachment` and `share_attachment` once storage and the runner
  agree on transfer. Default copies to the session and channel temporary area.
  Run an end-to-end exercise that copies an uploaded CSV, transforms it in the
  runner, shares the result, and opens the published file after runner cleanup.
  Exercise interrupted transfers and retry of a committed share. Add the
  consumer-managed store against the same contract as a separate increment.
- Review background shell as a follow-up after foreground and transfers.
  Pin job ownership, cancellation on channel suspension, restart behavior,
  bounded output retrieval and durable completion notices before enabling it.
  [Shell execution](../shell-execution/0001-DESIGN/SPEC.md) ·
  [Attachment storage](../attachments/0001-DESIGN/SPEC.md) ·
  [Attachment tools](0003-DESIGN-attachment-tools/SPEC.md)

## Gate 4 · Reminders and routines

- Add one-off reminder tools, a session-owned timer and indexed due reads
  against the memory and SQLite storage contracts. Put scheduling behind the
  runtime lifecycle and reuse inbox notice delivery. Test due, cancelled,
  suspended, retired, detached and restarted sessions with a controlled clock.
- Pin the shared startup and deadline contract before the acp-client handoff.
  The open path applies channel changes and reminder intents before queuing
  overdue work and reports the resulting deadline. acp-client owns the wake
  index, stopped-session intents, lazy startup and consumer API. Test one lazy
  start and one notice, offline cancellation and replay after a lost reply
  over real stdio. Cover the accepted late-wake crash window.
- Add recurrence after the one-off path. Review catch-up, overlap, calendar
  semantics, limits and the unattended-turn guard before enabling routines.
  [Reminder and routine tools](0004-DESIGN-reminder-tools/SPEC.md)

## Review and integration

The gate numbers describe review order. Independent implementation can proceed
once its own contract and dependencies are ready. Coordinate edits to the
catalog, storage format and archive, startup path and protocol so workstreams
do not allocate conflicting changes to shared files. Record public contract
changes in numbered decisions before dependent code. Keep implementation modules
outside the kernel and keep acp-client integration behind the public harness API.

Each slice needs focused offline acceptance, typechecking and applicable
memory/SQLite or transport conformance. Exercise the final combined tool catalog
with a scripted acp-client run over real stdio and a manual standalone REPL run.
Use the inspector to verify tool admission, paired results, usage where
applicable and durable notices. Live provider calls are a separate opt-in check.

The next implementation action is R-H1 in the
[reminder implementation plan](0004-DESIGN-reminder-tools/PLAN.md).
The gate numbers identify the original slices. The current priority is
reminders, followed by a fresh scheduling decision for the remaining slices.
