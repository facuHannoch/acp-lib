# Message status

Status: proposed, 2026-11-24. acp-client only; reads the native harness's existing item milestones
(`src/native-harness/src/contracts/agent.ts`, `ItemMilestone`; the `items_receipt` channel event). No harness change.

## What it is

One status per user message, the same for every conversation, so a consumer can show "sent / delivered / seen" ticks
without combining several events. Today a message's progress is spread over `message_pending`, `message_delivered`,
`message_withdrawn`, `message_held`/`message_released` and the prompt's result, and native receipts stay internal to
the native controller (`receiptOf()`).

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
| `failed` | the turn ended failed before `seen` | same |

- **Only forward.** A status never goes back. When several steps happen at once (ACP `taken` and `delivered`), each
  is still reported, in order, so a consumer sees the same sequence everywhere.
- **Combined prompts:** every original message of the prompt gets the status, each under its own id.
- **ACP statuses are approximate** by nature (`seen` is inferred from output). That is documented, not flagged:
  no capability field.

## Surface

- **`handle.status`** on the prompt handle (`PromptHandle`), the latest status.
- **One event** on the conversation's events: `message_status { id, status, turnId? }`, emitted on every change.
- **The existing message events stay** for compatibility.

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
