# Bounded inference context

Date: 2026-11-23

Status: Proposed for M2 and the v1 harness. Start with bounded selection and
refine allocation and rendering through scripted and interactive tests.
See [PLAN.md](PLAN.md) for module ownership and implementation gates.

## Session ownership and read boundary

Create one in-process `SessionContext` when the harness opens a session. It
uses the existing durable session store, session configuration, and tool
registry. All native channels use the same builder. The timeline is the
authoritative history, including after restart.

After taking input at an inference boundary, the turn runner calls
`build({ channelId, turnId })`. The context module reads a bounded view through
the storage contract at one committed timeline revision. Capture configuration
and tool definitions for that build as well. Release the storage read before
rendering, loading image bytes, or calling the model. Selection and rendering
belong in the context module. Provider encoding belongs in the model adapter.

The build returns an immutable inference context with the session, channel,
turn, and read revision, plus the ordered messages and offered tools. Freeze
the request inputs for retries of the same inference. Later iterations build
fresh views. Channels may infer concurrently from different revisions of the
same session. A committed change is eligible for later reads. An explicit
channel notice reaches the target through the existing take or wake behavior.

Use indexed reads for inference assembly. Bound both record count and bytes
read, including reads for active input and applicable tool policy. Check payload
sizes before loading message bodies. Search for shared history within a bounded
recent range. Return fewer shared entries when that range is dominated by the
current channel. Opening a
session recovers its durable state. The builder reads conversation material
on demand and can reconstruct the next context from the same timeline after
reopen. Assembled contexts are call-scoped values.

## Request structure

| Part | Content |
| --- | --- |
| Agent instructions | The consumer's configured system prompt, preserved verbatim. |
| Harness instructions | A short, stable explanation of how to interpret attributed history and active input. Tool-specific usage guidance lives with the tool definitions. |
| Current conversation | The current channel and the origin of the turn. Attribute each active input separately so steering from several participants stays clear. |
| Selected history | Recent messages from the current channel and a smaller window of earlier activity from other channels. Preserve source attribution. Render selected records in timeline order as historical data. |
| Active turn | The triggering input, taken steering and notices, and the assistant and tool exchanges still needed for inference. Preserve native call and result pairing. |

The first two parts form the system prompt. The next three form the
conversation input. Offered tool definitions travel alongside the messages in
the provider's tool field and count toward the budget. An entry appears once
per request. In particular, active-turn entries are excluded from history.

With [image input](../../attachments/0001-DESIGN/SPEC.md), include selected
images as parts of their active messages when the model supports them. Keep
older attachments and general files as references. Follow the
[timeline retrieval contract](../../timeline-retrieval/0001-DESIGN/SPEC.md)
for access to older messages and for keeping saved retrieval exchanges out of
later shared context.

V1 shares native history across the session and offers no cross-channel
privacy guarantee. Attribution remains available for interpretation, queries,
and future policy work. Shared identity outside the harness is deferred.

## Budget and selection

Enforce a published per-message UTF-8 byte limit before durable input acceptance.
The harness is authoritative. The development web chat and REPL preflight against
the same limit. An oversized submission is rejected before any inbox or timeline
write and receives no `Received` receipt. Take an ordered prefix within the
intake limits at each inference boundary and leave any suffix pending. If
already-taken required material cannot fit, fail with `context_limit` before
inference. Taken items remain linked to the failed turn and keep their existing
receipt milestones. See [decision 0026](../../../decisions/0026-bounded-context.md)
for receipt, policy, and compatibility details.

1. Start with the configured model context limit. Reserve space for output
   and estimation error. Estimate the input cost of instructions, tool
   schemas, active messages, and selected images. Provider enforcement of the
   output reserve remains a separate decision.
2. Allocate remaining space to history. Give the current channel priority
   for continuity and reserve a smaller share for recent shared activity.
   Allow unused space to be borrowed. Under pressure, remove the oldest
   shared entries first, then the oldest local entries. The original
   timeline remains available to retrieval tools.
3. Bound large tool results when presenting them to the model. If a long
   turn needs further trimming, omit older completed exchanges as whole
   units where provider rules permit. Preserve the current input, newly
   taken steering and notices, and exchanges required for continuation.
   Return a typed context-limit error if the required material cannot fit.

Use a conservative estimator for v1 and keep storage read limits independent
of the model budget. Start with the defaults in
[Business rules](../../BUSINESS_RULES.md) and tune them during testing.
Automatic summaries and persisted assembled context can be evaluated after
testing bounded selection.

## Inspection and acceptance

Keep the development inspector's existing three tabs:

- **Live Context** shows a bounded session-wide preview. Fetch it on opening or
  refreshing the tab. Push a change notification and coalesce refreshes while
  the tab is visible. A hidden tab stays dirty until opened.
- **Timeline** loads a bounded latest page on demand and pages older records
  separately. Committed entries can update the visible page incrementally.
- **Channels** updates lightweight working status from events. With capture
  enabled, show the five parts, offered tools, read revision, estimated input
  size, and trimming decisions from the inference itself. Use attachment
  metadata in place of large binary payloads. Follow diagnostic capture controls
  and fetch historical call details on demand.

On reconnect, refresh status and the visible view. Events and tab refreshes use
incremental updates or focused reads. The inspector's status and preview paths
both need to avoid full-session snapshots on every event.

1. Overlap inference across channels on a long session. Verify that one
   channel's activity leaves room for another channel's recent conversation.
   Assert bounded inference-path reads, including large records, and record
   assembly latency separately from provider latency. Verify a dominant channel
   cannot make the shared history read walk the full timeline.
2. Commit a correction while another channel's inference runs. Verify that
   the running request stays fixed and that the later view can see the
   correction. Exercise explicit notice steering and wake through the same
   inference boundaries.
3. Verify oversized input is refused before acceptance in the harness and
   preflighted in web chat and REPL. Exercise an oversized active turn and verify
   output reservation, trimming,
   intact tool pairing, and a typed error when required content cannot fit.
   Verify retries use the original request inputs.
4. Reopen the session and build from the restored timeline. With timeline
   retrieval available, recover an earlier decision outside the selected
   window. Exercise the scenarios in the web chat and inspect the captured
   requests to refine allocation and rendering. Verify hidden tabs perform no
   event-driven preview reads and reconnect refreshes the visible data.
