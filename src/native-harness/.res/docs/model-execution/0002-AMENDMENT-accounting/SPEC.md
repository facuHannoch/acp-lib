# Native harness accounting

Status: draft for review. Amends [model execution](../0001-DESIGN/SPEC.md).

R5 compares acp-client's in-turn metering against the model-call records the
harness already exposes. Billing-grade accounting additionally needs evidence
that the ledger is complete and that each reported quantity can be interpreted
and attributed. Native `billing_required` remains refused until the harness
contract and acp-client certification pass their respective gates.

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

## Between-turn work and strict admission

When the harness gains a producer for between-turn model calls, associate
each call with a channel, a nullable turn ID, and a stable accounting ID.
Define a bounded pull and idle trigger so the consumer can settle that work
without another prompt. Keep agent-wide work without a channel separate.
Support for between-turn accounting requires a producer and an end-to-end
verification gate.

Before enabling strict billing, define how the host confirms the accounting
capability before open or resume can admit work, including pending input and
work started by the harness. If accounting becomes unavailable, preserve
already produced output and known evidence. Refuse further work for the
affected strict channel until reconciliation. The harness owns the accounting
evidence and admission controls. acp-client owns pricing, accounting commits,
and certification of its integration.

## Acceptance

1. Use scripted per-attempt values as independent ground truth. Verify exact
   IDs, token presence and values, cache category semantics, route identity,
   purpose, and cost/currency where supplied, including retries and failed or
   aborted attempts.
2. Interleave channels and page one sealed turn. Detect an omitted row or
   torn read. Verify a sealed empty turn and unavailable evidence have
   different outcomes. Reopen after a crash and verify known usage remains
   recoverable without double counting.
3. Verify incompatible startup, missing evidence, and incomplete or unpriced
   usage in the acp-client integration. Check that strict admission closes on
   the affected channel while preserving results already produced.
4. When between-turn work is introduced, verify scoped retrieval and durable
   accounting after idle and restart without a subsequent prompt.

Record public types, storage and wire guarantees, compatibility, and shared
conformance requirements in a decision before dependent implementation.
