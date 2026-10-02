# TODO: steering across participants

Related: `10-2-SPEC-steer-pending-messages.md`.

Left open on purpose. The groups model is not finished, so a rule would be premature.

## The question

In a conversation with several participants (`promptFrom` with a `participantId`, for example the
Hub's groups), a `steer` message from participant B sent during participant A's running turn would
cancel A's turn at the next tool boundary and run B's message. Steering today does not look at who
sent the message or who started the turn.

## A use that wants it

The "inbox" pattern: several senders (agents, users) route messages into one conversation, all in
`steer` mode, and the model receives them together at the next boundary. Here a message from
another participant interrupting the running turn is the intended behavior, and the spec merges
messages across participants, keeping each one's `participantId` and `consumerMetadata` as parts.
Any rule that restricts steering by participant has to keep this working.

## Options considered

- Steer only when the sender is the same participant as the one who started the active turn; every
  other sender defaults to `queue`. Protects a participant's turn from others.
- No rule: any participant can steer any turn. Simplest; may be acceptable if participants are
  cooperating agents or the same user.
- Make it a consumer decision, with a hook or setting deciding per message whether steering is
  allowed.

## Status

The v1 spec has no participant rule: delivery mode is per message and the library does not check
participants. Revisit when the groups model is defined, before `steer` becomes the default in the
major release.
