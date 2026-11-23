# Decision 0026 · Bounded inference context

Date: 2026-11-23

Status: Gate 1 draft. Grounded on `alpha` at `510e2a7406b4dc2b6d3aafedb61529bff423990b`.

Full snapshots currently supply context, policy, and delivery evidence before
inference. Use one detached, indexed read at a committed revision and freeze
the assembled input and tool offer for retries. Whole snapshots remain useful
for export. A persisted rendered context would add rebuild and invalidation
rules. Start with on-demand selection and shared native visibility.

**Admission.** Measure UTF-8 bytes of the normalized text stored for a new
input, including separators between text parts. Apply the per-message limit to
participant input and notices. Reuse `invalid_input` in process and
`invalid_params` on the wire, with a message naming the limit. Rejection writes
nothing and emits no receipt. An identical retry of an accepted stable ID
still returns its existing receipt. Expose the effective limit in session open
metadata and development client configuration. The web chat and REPL preflight
against the advertised value.

**Taking input.** Both start and steering atomically take a FIFO prefix under
the batch byte and item-count bounds. The next input that would exceed a bound
and all later inputs remain `received`, in order, for the next boundary. A
pending suffix keeps normal wake and finish behavior. The batch limit budgets
raw text. Assembly can still fail when required instructions, tools, attributed
input, and other required material together exceed the actual request budget.
An oversized head item accepted by an older version is taken alone and ends
its turn with `context_limit` if it cannot fit, so it cannot block later work.

**Build and receipts.** Preserve the turn's triggering input and inputs newly
taken since the preceding committed assistant response, including on resume.
Any additional active exchanges are optional and may be omitted only as whole
assistant call groups with every corresponding result and provider state. The
receipt set contains only original input items represented in the frozen
request. The scripted boundary set contains just newly taken IDs in take
order. The policy set covers the whole taken turn, including inputs whose text
was trimmed. If required data or complete policy evidence cannot fit the read
or input bounds, fail the turn with reason `context_limit` before reserving a
model call. Taken items stay linked to that failed turn, existing milestones
stand, and remaining pending items stay eligible. Fresh work can start.

**Read and budget.** Both storage adapters implement `InferenceStorageReads`.
Bound candidate rows and serialized record bytes before materializing message
bodies. Omit oversized optional history. A required overflow is explicit.
Measure candidate sizes as serialized message bytes plus UTF-8 attribution and a
fixed record allowance. The record cap applies to message bodies and also
limits the distinct policy-name projection independently. Both spend the same
byte budget. SQLite uses the turn, conversation, and row sequence indexes, with
partial indexes for taken inputs and assistant responses. A per-turn policy
projection is backfilled transactionally on first open and updated when items
are linked, including writes by format-6 owners that predate this read. It
changes neither the session format nor the archive format. Memory maintains
the same projection with transaction rollback.

Select shared material within a bounded recent candidate range, which may yield
fewer items under a busy local channel. Use a text estimate with an output and
error reserve. Provider-side enforcement of the output reserve stays open.
See [Business rules](../docs/BUSINESS_RULES.md) for starting values.

The contracts are additive at Gate 1. Gate 2 wires the storage extension into
both adapters and proves its bounds. Gate 3 wires admission, receipts, and
assembly through normal entry points. Existing text inputs and tool policies
retain their representation.
