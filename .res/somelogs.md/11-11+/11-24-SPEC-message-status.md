# Message status

Status: proposed, 2026-11-24; review 1 and the code pass applied the same day. acp-client only; reads the native harness's existing item milestones
(`src/native-harness/src/contracts/agent.ts`, `ItemMilestone`; the `items_receipt` channel event). No harness change.

## What it is

One status per user message, the same for every conversation, so a consumer can show "sent / delivered / seen" ticks
without combining several events. Today a message's progress is spread over `message_pending`, `message_delivered`,
`message_withdrawn`, `message_held`/`message_released`, the prompt's result, and, for native conversations, the
public `items_receipt` event (`{ turnId, itemIds, milestone }`, documented in the consumer guide). The status is built
from these; it adds no new evidence.

## The status

`queued` → `received` → `taken` → `delivered` → `seen`, or the end states `withdrawn` and `failed`.

| Status | Native conversation | ACP conversation |
| --- | --- | --- |
| `queued` | waiting in acp-client's queue | same |
| `received` | the harness committed it to the channel inbox (push answer) | accepted by acp-client, same moment as sending |
| `taken` | committed to a turn (`turn_started` / `turn_took`) | the prompt is sent to the provider |
| `delivered` | `items_receipt` `delivered` | the prompt is sent (same moment as `taken`) |
| `seen` | `items_receipt` `seen` | the provider's first output of that turn |
| `withdrawn` | withdrawn before any take | withdrawn from acp-client's queue |
| `failed` | the prompt rejected before `seen` | same |

- **Only forward.** A status never goes back. When several steps happen at once (ACP `taken` and `delivered`), each
  is still reported, in order, so a consumer sees the same sequence everywhere.
- **Held and released** (`message_held`): no status change; the message stays where it was.
- **`failed` is about delivery, not the answer.** A message already `seen` stays `seen` when its turn then fails;
  the prompt's result says how the turn ended.
- **Only the conversation's own messages.** Native `items_receipt` ids can include external notices; ids the
  conversation didn't accept are ignored.
- **Combined prompts:** every original message of the prompt gets the status, each under its own id.
- **ACP statuses are approximate** by nature (`seen` is inferred from output). That is documented, not flagged:
  no capability field.

## Surface

- **`handle.status`** on the prompt handle (`PromptHandle`), the latest status.
- **One event** on the conversation's events: `message_status { id, status, turnId? }`, emitted on every change.
- **The existing message events stay** for compatibility.

## Implementation

From a pass over the code (2026-11-24):

- **A small tracker,** `src/steering/message-status.ts`: a map from message id to status, `advance(id, status)`
  moving forward only, filling skipped steps in order, and emitting `message_status` through the session's `emit`.
  Entries outlive the prompt's settlement, unlike `acceptedMessages` in `agent-session.ts` (deleted on resolve),
  because `handle.status` is read afterwards; dropped with the session.
- **The handle:** `prompt()` in `agent-session.ts` (`Object.assign(promise, { id, withdraw, withdrawAsync })`) gains
  a `status` getter reading the tracker; the rejected-handle path returns `failed`. `PromptHandle` in
  `src/steering/contracts.ts` gains `readonly status`, and `MessageEvent` the new event.
- **Where each status comes from:**
  - `queued`: where the prompt is accepted (`acceptedMessages.set` in `prompt()`), and `steering.accepted`.
  - `received`, native: after `host.push` resolves in `src/native/controller.ts` (the push loop of the run). It
    needs a per-message callback on the run (next to `beginInput`), since push results aren't reported today.
    ACP: at `taken`.
  - `taken`: native from `turn_started` / `turn_took` (their cause lists the ids), handled in
    `agent-session.ts` next to `reportTurnTook`; ACP from `message_delivered` (`steering/controller.ts`).
  - `delivered` / `seen`, native: the `items_receipt` branch in `agent-session.ts` (`event.kind ===
    "items_receipt"`), per id in `itemIds`.
  - `delivered`, ACP: with `taken`. `seen`, ACP: the supervisor's first stage change away from `waiting`
    (`onStageChanged` in `agent-session.ts`, where `operation_stage_changed` is emitted), for every message of that
    operation.
  - `withdrawn`: `message_withdrawn` (local) and `input_withdrawn` (native, `onNativeWithdrawal`).
  - `failed`: the prompt item's `reject`, when the status isn't `seen` yet.
- **Telling native from ACP:** by the controller (native controllers report turn events; ACP ones don't), so the
  ACP rules never fire on a native conversation and its `message_delivered` doesn't double as `delivered`.
- **Size:** the tracker plus about ten one-line hooks; no persistence or schema change.

## First version

- Live only: no persistence. A reopened conversation doesn't restore statuses; history keeps what it has today.
- Native: the controller forwards its receipts and turn takes as statuses instead of keeping them internal.
- Tests: one sequence per backend (native via the fake harness, ACP via a fixture agent), a withdraw, a failed turn,
  and a combined prompt.

## Limitations

- ACP `seen` means "the provider started answering", not proof the model read the message.
- Statuses of messages sent before a restart are not recovered.

## Open

- Saving the final status on the user message record, if a consumer needs it in history.
