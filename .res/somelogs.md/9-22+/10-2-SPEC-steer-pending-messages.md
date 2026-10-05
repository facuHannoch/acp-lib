# Steering: messages sent while a turn is running

Status: implemented (steer, interrupt, combining, withdraw, events, `busyDelivery`; default `queue`). Independent of `10-2-SPEC-adopt-provider-session.md` and the persistence
resolver. Release sequencing is in section 9 of `10-2-PLAN-adopt-session-and-persistence-resolver.md`.
Open multi-participant question: `10-2-TODO-steer-multi-participant.md`.

## Problem

Today a prompt sent while a turn is running is appended to a FIFO queue
(`AgentConversationQueue`, used by `AgentSession.operations`) and runs after the turn ends. Most
harnesses now behave differently: the new message is delivered after the next tool call ("sending
after next tool call"), and the user can choose to interrupt and send it immediately.

The library should support that workflow for every consumer, with no dependence on the harness or
the model.

## Constraints

- **Works with every agent.** ACP has no standard "inject into a running turn". A turn is a
  `session/prompt` call that resolves when the turn ends, and the only control during it is
  `session/cancel`. So the mechanism is built from observation (the streamed updates) plus cancel
  and a new prompt.
- **No adapter-specific queues.** Not every harness accepts a prompt mid-turn.
- **No MCP injection.** Sending a message is a core action and must not depend on the model
  choosing to call a tool.
- **No fabricated text.** The follow-up prompt is the user's text, unchanged.

## Contract

A message sent during a running turn is delivered **no later than the end of the turn, and at the
earliest clean tool boundary**. In the worst case it behaves like today's queue. It never fails
because the agent or model lacks a feature.

Which tool boundary that is (the first call of a batch or the last) is the agent's choice and is not
promised: see "Where the steer lands".

## Overview

In one picture:

```
 consumer ── prompt(text, { delivery }) ──► conversation
                                              │
                          idle? ── yes ──►  run now (nothing changes)
                              │ no
                              ▼
                     pending FIFO  (one list, as today's queue)
                     ┌──────────────────────────────────────────────┐
                     │ [steer] [steer] [steer] │ [queue] │ [steer]  │
                     └──────────────────────────────────────────────┘
                       head run (combined)       own turn   waits
                              │
        delivered by whichever comes first:
          • a tool call settles (and none in flight)  → cancel turn, send head run   (steer)
          • the turn ends by itself                    → send head run               (turn_end)
          • the consumer calls interrupt()             → cancel turn, send head run  (interrupt)
                              │
                              ▼
                 one combined prompt (one operation, one metering record)
```

- **One FIFO.** Steering adds a delivery mode to prompts in the existing queue. Nothing is reordered.
- **Two modes.** `steer` waits for a tool boundary. `queue` waits for the turn to end, and is its own
  turn.
- **One interrupt.** `conversation.interrupt()` cancels the turn at any moment; what is pending is
  then sent.
- **Combined delivery.** Consecutive `steer` messages at the head go out as one prompt. The library
  adds no text; the originals are kept as parts with their own ids, participants and metadata.
- **Always bounded.** A message is delivered no later than the end of the turn. No harness support,
  adapter queue or MCP is needed.
- **Observable.** Message events (`pending`, `delivered`, `withdrawn`) and `endedBy` on the cancelled
  turn tell the consumer what happened.
- **Opt-in at first.** `busyDelivery` defaults to `queue`; `steer` becomes the default in a major
  release.

## Model

The conversation keeps a single FIFO of pending work, as it does today. Steering adds a delivery
mode to prompts in it; it does not add a second structure.

A prompt sent while a turn is running is **pending**. It has an id and a delivery mode:

- `steer` (target default): delivered at the next tool boundary.
- `queue`: delivered after the turn ends (today's behavior, kept as a non-default option).

**Ordering is FIFO.** A `steer` message is appended to the queue like any other. A `queue` message
sent earlier keeps its place ahead of it. Steering does not reorder anything. The boundary rule
therefore applies only when the head of the pending prompts is a `steer` message. If the head is a
`queue` message, nothing is delivered at a boundary, and the steer message runs in its turn when it
reaches the head.

**Interrupting.** There is no per-message promotion. The consumer can interrupt at any moment with
the existing `conversation.interrupt()`, including during a long text-only turn: the running turn is
cancelled, and whatever is pending at the head of the queue is then sent. So there is no fallback or
timeout rule. Whichever happens first delivers the head of the queue: a tool boundary, the end of
the turn, or an interrupt.

A pending message can also be **withdrawn** before it is delivered. Its `prompt()` promise
settles as a queued prompt dropped by `interrupt({ clearQueue })` does today:
`stopReason: "cancelled"`, `usage: null`, `metering: null`. It emits `message_withdrawn`.

When the conversation is idle, a prompt starts immediately and none of this applies. Steering also
applies only while the active operation is a **prompt turn** the consumer started. While a handoff,
configuration change, mode change, recovery resolution, or a hidden internal operation (checkpoint
summaries, the adoption recap) is running, every pending prompt behaves as `queue`, and steering
never cancels those operations.

When a `steer` message behaves as `queue` for this reason, `message_pending` reports the effective
mode (`queue`); the requested mode stays on the `PendingMessage`.

### Combining

A run of consecutive messages **requested** as `steer` at the head of the pending prompts is
delivered as **one prompt**, whenever it is delivered (tool boundary, interrupt, or turn end). The
run stops at the first `queue` message, which stays its own item and its own turn, as today. `queue`
mode is unchanged: every queued prompt is its own turn. Combining follows the requested mode, so
steer messages held back behind a handoff (effective mode `queue`) are still combined when they are
finally sent.

Why: the model should see the whole correction at once. With

```
> working...
Also, remember x
and y
and z
no, actually forget about y and z
```

three separate turns would have the model start on `x` before it reads the correction. Delivered
together, it sees all four messages in one prompt.

The combined prompt is built so that nothing is lost and nothing is invented:

- **Text:** the messages' texts, in order, joined with a fixed separator (a blank line). The library
  adds no sender names and no wording of its own. If the consumer wants the model to see who said
  what, the consumer puts that in the text.
- **Attachments:** concatenated in order.
- **Operation:** one `operationId` and one metering record. Every merged `prompt()` promise resolves
  with the same turn result.
- **Streaming handlers:** every merged message's handlers receive the same events.
- **Attribution:** kept per message. The combined prompt carries its original messages as parts, and
  each is stored as its own user message record, in order, under the same operation: the first as
  `<operationId>:user`, the others as `<operationId>:user:2`, `:user:3`, ... Each record has its own
  `participantId` and `consumerMetadata`. Messages from different participants are combined too; the
  consumer decides what the metadata means. A prompt made of a single message is recorded as it always
  was.

### Example: a consumer-side inbox pattern

Not part of the library; it shows what the parts list is for. A consumer routes several senders into one conversation, as one inbox, all in `steer` mode:

```
> working...
(agent b) I finished this thing
(agent c) I had a problem
(agent d) user x told me to tell you that ...
```

The model receives the three messages as one prompt at the next boundary. The `(agent b)` prefixes
are in the text because the consumer wrote them there. Separately, each message was sent with its
own `participantId` and `consumerMetadata` (for example the sender), and the parts list keeps them
per message. The consumer can then render the inbox with sender names, or filter by sender, from its
own metadata, without the library having to know what a sender is. `consumerMetadata` is for the
consumer's own use; the library stores it and returns it with the part it belongs to.

## Consumer API

`prompt()` and `promptFrom()` already take more than text: `handlers`, `attachments`,
`consumerMetadata`, and a `participantId` (`promptFrom`). Those inputs stay with the pending message
until it is delivered. The delivery option is added to the same input objects.

```ts
type PromptDelivery = "steer" | "queue";

// added to AgentConversationPromptInput and AgentConversationAttributedPromptInput:
//   readonly delivery?: PromptDelivery;

conversation.prompt(...): PromptHandle;
conversation.promptFrom(...): PromptHandle;

interface PromptHandle extends Promise<AgentSessionPromptResult> {
  readonly id: PendingMessageId;
  withdraw(): boolean;          // true if it was still pending
}

conversation.withdraw(id: PendingMessageId): boolean;
conversation.pendingMessages: readonly PendingMessage[];

interface PendingMessage {
  readonly id: PendingMessageId;
  readonly delivery: PromptDelivery;
  readonly participantId?: string;
  readonly text: string;
  readonly createdAt: string;
}
```

- The promise resolves with that message's own turn result, as `prompt()` does today, so existing
  callers keep working. For a message sent as part of a combined prompt, that result is the combined
  prompt's result. The handle type has to be added everywhere `prompt` and `promptFrom` are
  declared, including the conversation interface in `agent-conversation-contracts.ts`.
- The by-id methods and `pendingMessages` exist because a UI that rebuilds its state after a reload
  only has ids.
- Queued prompts and steered messages share the one pending list and the same events.
- The consumer decides the mode per message, when to interrupt, and when to withdraw. The library
  enforces the contract and reports what happened. It never interrupts on its own beyond the
  boundary rule.

### Interaction with `interrupt()`

`AgentSession.interrupt(options)` already cancels the active turn, with an optional `clearQueue`.
Interrupting is that same call, with no new cancel path.

- `interrupt()` without `clearQueue` cancels the active turn. The pending queue then drains as
  usual: the run of consecutive `steer` messages at the head is sent as one prompt (see
  "Combining"), and `queue` messages follow as their own turns. The cancelled turn's result gets
  `endedBy: "interrupt"`.
- `interrupt({ clearQueue: true })` also drops pending messages. They resolve as they do today for
  queued prompts: `stopReason: "cancelled"`, `usage: null`, `metering: null`. They also emit
  `message_withdrawn`.

### Events

On the existing conversation event stream (`AgentSessionEvent`, which carries `seq` and `ts`), each
carrying the message id:

| Event | Meaning |
|---|---|
| `message_pending { id, delivery }` | Accepted and waiting. `delivery` is the effective mode (see below). |
| `message_delivered { ids, via, turnId }` (`turnId` equals the operation id, `mintTurnId` returns `mintOperationId`) | Sent to the agent. `ids` lists every message in the prompt, in order (one id for a single message). `via` is `"tool_boundary"`, `"interrupt"` or `"turn_end"`. |
| `message_withdrawn { id }` | Removed before delivery. |

Today the stream has turn, state, configuration, handoff, mode and metering events. Messages have
no ids or state events, and `state_changed` carries only `queuedOperationCount`. These events are
new, and they give the existing queue the same observability.

### Result of an interrupted turn

The turn that was cancelled by a steer or by `interrupt()` ends with
`stopReason: "cancelled"`. Its result also says why, so a consumer can tell it from an error:

```ts
endedBy?: "steer" | "interrupt";
followedBy?: readonly PendingMessageId[];
```

The streamed output of the first turn ends, and the follow-up streams as a new turn with its own
`turnId`.

## Delivery mechanism

1. Hold the message as pending. Nothing is sent yet.
2. Listen to the running turn's tool-call events. The **boundary** is an event: a tool call settles
   (completed or failed) *after the message was accepted*, and no other announced call is still in
   flight. It is not a state check, so a text-only turn, or a turn that has not announced any tool
   call yet, never produces a boundary and a steer message is not delivered early. A tool call
   waiting for a permission decision is in flight. The status comes from the existing activity
   tracking (`src/activity.ts`), which already tracks each call as `announced` or `settled` and
   handles agents that announce a call twice. The watcher does not parse updates itself. An agent
   that never reports completion for some tools never produces a boundary, and the message is
   delivered at turn end.
3. At the boundary, if the head of the pending prompts is a `steer` message, cancel the turn through
   the same path as `interrupt()`, with an internal reason of `"steer"`.
   `session/cancel` is a notification with no acknowledgement (`client.ts`); the signal that it took
   effect is the turn's prompt response arriving as cancelled.
4. When the cancelled turn resolves, the operations queue drains as usual and dispatches the head
   run of `steer` messages as one combined prompt.
5. If the turn ends by itself before a boundary, the head run is dispatched as the next prompt
   (`via: "turn_end"`).
6. If the consumer calls `interrupt()`, the turn is cancelled immediately (`via: "interrupt"`). A
   permission request pending at that moment resolves as cancelled.
7. If the turn finished between the decision and the cancel, or the turn ends normally (`end_turn`)
   even though a cancel was sent, the head run is dispatched as a normal prompt with
   `via: "turn_end"` and the turn gets no `endedBy`. `via` and `endedBy` record what actually
   happened, not what was intended.

### Where the steer lands

The boundary is the first tool call that settles while nothing else is running. Which one that is (the
first of a batch, the last) is the agent's choice and is not controlled or promised: the point is that
the agent receives the information without stopping altogether. The contract is only "no later than the
end of the turn". A precise "after the batch" boundary was considered and dropped as arbitrary.

What the cancel leaves behind is the harness's business (see "Findings").

## Persistence

Pending messages exist in memory only. When the conversation stops, pending messages settle as
queued prompts do today. They are not persisted, and if the process stops they are
lost, as queued prompts are today. A prompt's user message record is written when the prompt is
dispatched, as it is for queued prompts now. Internal prompts write it at dispatch (before the
provider call); the user-prompt path is to be confirmed. The
cancelled turn and the follow-up are two turns in the records.

## Findings

From `smoke-tests/test11-steerTurn` against Codex (`codex-acp` 2.1.1) and OpenCode (1.18.32). The
library's own steering was prototyped from the outside for these runs; the smoke test now drives the
real API.

- **Cancel is fast and clean.** The cancelled response arrives in 15–70 ms on both.
- **Completed work is kept.** After a cancel at a tool boundary, the follow-up continues the task
  (it re-reads only what it had not read) and still remembers earlier tool results.
- **Metering on OpenCode stays consistent.** With the certified plugin, the cancelled turn and the
  follow-up turn are both metered and reconciled; together they cost about the same as the same task
  run without interruption (50414 tokens against 50134), nothing lost or counted twice.
- **Usage over ACP on a cancelled turn is unreliable.** OpenCode reports 0 over ACP for a turn whose
  inference had completed (about 12k tokens; only the plugin sees it). Whether a cancelled turn
  consumed tokens depends on whether the model's message finished before the abort: when it did not,
  OpenCode itself records an aborted message with 0 tokens, and the plugin's record matches
  `opencode export` exactly (checked for two cancelled turns and every follow-up turn). Codex reports a context-size number, and the turn after a
  boundary cancel was marked `counter_reset` (4 of 4 runs), which attributes it no tokens. The stored
  records show why: the library reads ACP usage as a cumulative counter and flags a reset when a
  component decreases, but Codex's `inputTokens` moves with the prompt cache (4326, then 743), so the
  check trips. This is a limit of how Codex usage is read, not something steering causes; the `s9`
  control (two plain turns, no cancel) is there to confirm it. Once a turn is flagged, the next one
  can be flagged too. With plain ACP telemetry,
  steering can under-count the cancelled turn.
- **A tool already running:** Codex keeps the process running after the cancel (the file appeared 22
  seconds later, and the agent had already said it did not exist). OpenCode aborts it, and the agent
  correctly reported that.
- **Batched tool calls:** OpenCode announces the calls of a batch together. Codex announces them
  lazily, one by one, and ran two more after the cancel. This does not matter for the design (see
  "Where the steer lands") but it means tool calls can still finish after a steer.
- **Partial text:** Codex drops text it was streaming when cancelled from the model's context.
  OpenCode's result on this was inconclusive (the model used a tool in that run).
- **A cancel can lose the race with a normal ending:** on OpenCode 2 of 5, then 4 of 5, cancels sent on
  the first chunk of a one-word reply ended `end_turn`. `endedBy` is therefore reported only when the
  provider really stopped the turn. This also exposed a bug, now fixed: the result status (and the
  stored assistant message status) followed the interrupt request, so a turn the provider ended with
  `end_turn` was reported `cancelled`. Both now follow the provider's stop reason
  (`test/steering.test.ts`, "a cancel that loses the race with the end of the turn").
- **With the implementation, on OpenCode:** a steer message at a tool boundary ends the turn with
  `endedBy: "steer"`, two steer messages go out as one operation with one stored user message each,
  `interrupt()` and `withdraw()` behave as specified, and the cancelled plus follow-up turns cost about
  the same as an uninterrupted run (50017 against 49999 tokens).

## Settings

The busy-delivery default is one more key in the shared conversation config:

```ts
busyDelivery?: PromptDelivery;   // default: "queue" in the first release
```

- `AgentConfig.conversationDefaults` sets it for every conversation of an Agent.
- `create({ runtime })` / `open(id, { runtime })` override it per conversation.
- `delivery` on a single prompt overrides it per message.

Because it lives in the shared conversation config, a plain `AgentSession` without an Agent gets it
too, keeping the two layers consistent.

The first release keeps `queue` as the default so existing consumers are unaffected. `steer` becomes
the default in a major release, since a mid-turn `prompt()` would then cancel the turn at the next
boundary where it used to wait.

## Code structure

`prompt()`, `promptFrom()`, `interrupt()` and the operations queue live in `src/agent-session.ts`
(about 4400 lines), which must not grow beyond thin call sites. The new logic goes in its own
module:

```
src/steering/
  contracts.ts            PromptDelivery, PendingMessage, PromptHandle, message events, PromptPart,
                          the queued-prompt shape steering reads
  controller.ts           SteeringController: the delivery mode on queued prompts, the tool-boundary
                          watcher, delivery (cancel, then the head run), withdraw, pendingMessages.
                          A view over the one operations queue, not a second list.
  combine.ts              combinePrompts and mergeHandlers
  index.ts
```

Wiring in `agent-session.ts`:
- `prompt()` / `promptFrom()` return the handle and carry `delivery`.
- The queue item for a prompt records its delivery mode, so the drain loop and the watcher can read
  the FIFO head.
- The event union gains the three message events.
- `interrupt()` fills in `endedBy` and handles pending messages per its `clearQueue` option.

## Plan and status

1. Smoke test `smoke-tests/test11-steerTurn`: done (Codex and OpenCode); see "Findings".
2. Spec revised with the findings: done.
3. Contracts, events, the pending view and the FIFO head rule (`src/steering/`): done.
4. Boundary watcher and delivery, wired into `prompt()`, `promptFrom()` and the queue: done.
5. Combining, withdrawal and the `interrupt()` interaction: done.
6. `busyDelivery`, default `queue`: done.
7. Tests (`test/steering.test.ts`, scripted agent in `test/fixtures/steer-agent.ts`) and the consumer
   guide: done. The smoke test now drives the real API and is the acceptance test on real harnesses.
8. Not done yet:
   - run `test11-steerTurn` on Codex and OpenCode against the implementation;
   - run `s9` on Codex to confirm the `counter_reset` also happens without steering (Codex run with the
     implementation is otherwise done: every steering check passes; the two failing checks are Codex
     behavior: partial text dropped, running process survives);
   - decide what to do about Codex usage that is not a cumulative counter (metering, separate from
     steering);
   - steering during a handoff or another non-prompt operation is covered only by the design (such
     operations are not consumer prompts, so a tool event cannot trigger a cancel); add a test;
   - major release: flip the default to `steer`.

## Non-goals

- Adapter-specific or protocol-extension queues.
- MCP-based delivery.
- Automatic interruption on a timeout, or any decision made without the consumer.
- Reordering the FIFO, or adding sender names or any other text to a combined prompt.
- Rewriting the user's text, or adding "you were interrupted" wording.
- Undoing actions or editing the partial turn after a cancel.
- Persisting pending messages across a restart.
- A rule for steering across participants (see the TODO).

## Open questions

- Metering attribution of a combined prompt made of several participants' messages (one operation, so
  which participant, if any, is it attributed to).
- The adoption recap must be an operation of its own kind in the operations queue, so steering sees it
  and treats messages as `queue`. A requirement on `10-2-SPEC-adopt-provider-session.md`.
- Multi-participant behavior: `10-2-TODO-steer-multi-participant.md`.
- Naming (`steer`, `withdraw`) and the separator for combined text (a blank line) are in use; revisit
  if consumers object.
