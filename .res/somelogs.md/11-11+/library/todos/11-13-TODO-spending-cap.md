# TODO: a spending cap enforced by the library (native)

Status: deferred (owner, 2026-11-13). For v1 the library measures native costs as precisely as it does with the
certified OpenCode plugin (integration spec, Billing-grade metering); a consumer enforces limits outside, from those
records and the per-call usage events (for example, not prompting a user who is out of credits, or interrupting a
turn). acp-client has no spending limit today (`src/metering/` checks only that usage can be measured).

## The idea, if it comes back

A spending check before every model call, decided by the consumer's code:

- **The policy:** a consumer function on the `Agent`, say `spending: (request) => "allow" | "deny"` (name
  provisional).
- **The check:** before each model call the harness asks the host (a `budget/authorize` callback) with the channel and
  turn, the purpose (turn, compaction), the participants whose messages caused the turn (so the right user is
  charged), and an estimate (input tokens plus the call's maximum output, priced by acp-client's catalog).
- **Reservations:** acp-client reserves the estimate when allowed and settles it to the real usage when the call
  reports; checks run one at a time per `Agent`, so two channels can't both spend the last of a budget.
- **A refusal:** the harness doesn't make the call; the turn ends with a "spending refused" outcome and its prompts
  settle with a distinct error, so a product can show "out of credits".

## Considerations

- One call can't be stopped once it starts; it is bounded by its reservation (only a provider ignoring `max_tokens`
  exceeds it).
- A refused compaction call means the turn can't continue; the policy sees the purpose.
- The harness waits for the host's answer (the host decides, as with permissions); a hung host means model calls wait,
  cancellable.
- ACP conversations can't get this: their model calls are invisible to acp-client (only a per-call source such as the
  certified OpenCode plugin would allow it).
- A standalone harness would use its own numeric limit (`limits.budget`, harness v1 Guards).

## Alternatives considered

- The consumer checks before prompting (today's ACP way): can't stop a running turn.
- The consumer interrupts from per-call usage events: works with v1 as built; overshoot about one or two calls.
- A numeric allowance enforced by the harness: no round trip, but only numbers (rules per user, per plan, per day must
  be translated into allowances per channel and kept updated).
