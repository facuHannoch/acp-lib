# TODO: confidentiality of information across channels

Related: `../11-11-SPEC-harness-design.md` (policies, the basic promise, the injection suite),
`../11-11-SPEC-harness-v1.md` (messaging tools, timeline scope). Written 2026-11-12. Out of scope for v1.

## What v1 guarantees, and what it doesn't

- **Guaranteed (code):** actions. An untrusted party can't make the agent do what its channel's policy forbids: the
  gate checks every tool call, and messaging targets are checked against the sending turn's policy. Prompt injection
  can confuse the agent's judgment but not widen its rights.
- **Done, but not a guarantee:** what is delivered into a channel is filtered by scope (a guest turn's digest leaves
  out owner-scoped events). It lowers what a channel's context holds; it doesn't stop the agent from carrying
  information across.
- **Not guaranteed:** the content of what the agent writes. If the agent, in an owner channel, sends a private detail
  to a guest channel with `message_participant`, or repeats something it knows, code doesn't check the text. That is
  the model's judgment in v1.

## Later

- **A confidentiality check as a separate model call:** before text leaves for another channel (and possibly before
  any reply in a low-trust channel), a cheap call checks it against the scopes of what it could reveal. Feasible;
  costs a call per outgoing message and adds latency.
- **Scope tracking on derived content:** mark what the agent writes with the most restrictive scope of what it read
  in that turn, so code can refuse to send it to a channel whose policy can't see that scope. Coarse (it over-blocks)
  but mechanical.
- A real optimization space: confidentiality per piece of information rather than per channel.
