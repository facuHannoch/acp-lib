# Finding: an ACP message is durable only once its turn starts

Status: recorded 2026-11-12; accepted as is for now, may change later. Found in review 1 of
`../11-11-SPEC-controller-interface.md`.

## What happens

With the turn split, `send()` resolves when the message is **queued**. For ACP conversations the user record is
written when the message's turn begins, exactly as `prompt()` works today. Until then the message exists only in
acp-client's in-memory queue (`AgentConversationQueue`).

Example, while a turn is running:

1. `conv.send("also check the tests")` returns `{ messageId }` at once; the message waits in the queue.
2. Reading the conversation's history now does not show it.
3. It can still be withdrawn (`withdraw`), since nothing is recorded.
4. When the running turn ends, the message's turn starts: the user record is written, then the answer.

## Implications

- **Lost on a crash before its turn.** If acp-client stops before the turn starts, the queued message is gone. This
  is true today for queued prompts too.
- **The two backends differ.** A native message is pushed to the harness, which stores it in the channel's inbox at
  once and keeps it across restarts. An ACP message is not stored until its turn. A consumer using both should read
  "`send()` returned" as "queued", not "saved".
- **What it preserves:** today's record order; the managed-mode metering preflight running before any durable record
  (a pricing rejection needs no abort record); `withdraw`; steering combining queued messages into one turn.

## Why it is kept for now

The controller-interface spec is a refactor with no behaviour change. Writing the user record at `send()` would
change the order on the managed path (`SessionManager`, which agents-core uses) and would make `withdraw` need a
"withdrawn" record.

## If it changes later

Write a "queued message" record at `send()` for ACP too, so queued messages survive a restart:

- the managed-mode preflight then runs before that record, or the record is written as provisional;
- `withdraw` writes a withdrawn record instead of dropping silently;
- on restart, queued records without a turn are re-queued (or reported to the consumer as not delivered);
- record ids stay keyed by the turn once it starts (`<turnId>:user`), with the queued record linked by message id.
