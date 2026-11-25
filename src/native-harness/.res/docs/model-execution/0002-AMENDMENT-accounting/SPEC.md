# Native harness accounting

Status: draft for review. Amends [model execution](../0001-DESIGN/SPEC.md).

R5 compares acp-client's in-turn metering against the model-call records the
harness already exposes. This amendment improves reporting by recording what
ran, verifying which records were received, and identifying quantities or
prices that remain unknown. This increment is report-only. Native
`billing_required` remains unavailable. Any future certification or change
to its semantics requires a separate decision.

The starting point is the R5 grounding and review on `integration-r456`.
Pin the final R5 revision at contract review and reconcile any changes to its
consumer requirements.

## Attempt evidence

Retain stable logical call and attempt IDs and the terminal outcome of each.
Record the provider and model identity for the route that actually ran. A
session-wide identity is sufficient only if it is guaranteed for every
attempt. Record an extensible purpose for each call.

Define input, output, total, and cache categories explicitly, including whether
cache reads and writes are included in input totals and how consumers can
price them without double counting. A missing field means unknown. Zero
requires explicit evidence. Preserve provider-reported cost and its currency
when supplied, separately from consumer-calculated pricing. Failed, aborted
and retried attempts can incur usage. Preserve independently known evidence
even when the aggregate is incomplete.

## Sealed turn accounting

Expose an additive, versioned accounting capability during initialization.
The contract decision must define the durable seal, the bounded reads, and
their ordering with turn finalization and recovery. A terminal turn event
alone is insufficient evidence of a seal.

The seal identifies the exact set of committed logical calls and attempts
belonging to a channel and turn, including failed and aborted attempts. Use
an ID manifest or a durable read fence with scoped pagination and equivalent
coverage evidence. Verify that every page belongs to the same seal and that
the consumer can detect missing, duplicated or incomplete rows. A sealed turn
with zero attempts is distinguishable from a turn whose accounting is
unavailable. A complete ledger can still have unknown usage or price for
individual attempts.

## Between-turn work

When the harness gains a producer for between-turn model calls, associate
each call with a channel, a nullable turn ID, and a stable accounting ID.
Define a bounded pull and idle trigger so the consumer can settle that work
without another prompt. Keep agent-wide work without a channel separate.
Support for between-turn accounting requires a producer and an end-to-end
verification gate.

## Reporting and reconciliation

Accounting does not gate execution. Missing, incomplete or unpriced
evidence must never block a channel, interrupt a turn, or suppress an
already produced response. This applies on startup, reconnect, resume,
and to work admitted by the harness such as reminders.

Report ledger completeness independently of quantities and cost coverage.
Distinguish a verified empty ledger from missing evidence. Show known usage
and cost as subtotals when accounting is incomplete, and label missing,
unknown or unpriced items explicitly. Preserve provider-reported amounts
separately from estimates calculated from price schedules. A gap must never
be filled with zero or an inferred charge.

The harness owns durable execution evidence and the seal. acp-client owns
verification, rating, reporting and idempotent accrual. If a read or
accounting write fails, preserve the last committed position, expose the gap
and retry reconciliation independently of turn execution. Later evidence
updates the affected record and totals using the same durable IDs so a
reconnect or retry cannot count the same evidence twice. Record the scope
of any reported totals so separate paid web-tool evidence can be shown
without implying that all external costs are covered.

## Acceptance

1. Use scripted per-attempt values as independent ground truth. Verify exact
   IDs, token presence and values, cache category semantics, route identity,
   purpose, and cost/currency where supplied, including retries and failed or
   aborted attempts.
2. Interleave channels and page one sealed turn. Detect an omitted row or
   torn read. Verify a sealed empty turn and unavailable evidence have
   different outcomes. Reopen after a crash and verify known usage remains
   recoverable without double counting.
3. Simulate missing seals, partial provider reports, unpriced usage, a failed
   read and a failed accounting write. Verify that each gap is visible, known
   evidence and replies are preserved, and the same channel completes later
   turns and reopens normally. Recover the missing evidence and verify the
   reported totals update without duplicate accrual.
4. When between-turn work is introduced, verify scoped retrieval and durable
   accounting after idle and restart without a subsequent prompt.

Record public types, storage and wire guarantees, compatibility, and shared
conformance requirements in a decision before dependent implementation.
