# Native harness business rules

Updated: 2026-11-19.

This index records choices we might want to revisit, such as a default limit or
what to show a user when an operation is interrupted. Each entry links to the
spec that owns the behavior. Add the code location when the rule ships.

Keep adjustable values together in a named configuration or defaults module.
Give a behavioral choice a named decision at the boundary where it applies.
For example, retry eligibility belongs in the retry policy and the partial
reply rule belongs in stream finalization. A named decision can be changed and
tested independently. Expose a public setting when a consumer needs to choose.

## Model execution

These rules are implemented from the
[model execution spec](model-execution/0001-DESIGN/SPEC.md).

| Rule | Current proposal | Why |
| --- | --- | --- |
| Retry budget | One automatic retry for a transient provider failure. | Recover from a brief failure while bounding additional latency and usage. |
| Retry after output | Close the retry window when the runner accepts its first nonempty text delta for publication or commits a response. Apply the same cutoff in both delivery modes. Privately buffered tool fragments can still establish Seen. | Prevent duplicate partial answers and keep execution independent of who subscribes. |
| Call timeout | 120 seconds for the model call, including the complete stream, retry wait, and retry. Tool execution and approval waits use separate limits. | Bound the wait for one call while letting a turn keep working across many iterations. |
| Retry delay | Wait one second before the single eligible retry, within the original deadline. | Give transient failures a brief recovery window without resetting the deadline. |
| Partial reply | Keep it visible locally as incomplete if the reply ends before commit. On reconnect, a committed reply with the same ID replaces the draft. | Preserve what the user saw and recover an answer committed before the connection failed. |
| Default text delivery | Send completed messages by default. Interactive clients can opt in to deltas. | Reduce event traffic for consumers that display whole messages. |
| Slow reader | Coalesce live deltas within a bounded buffer. Fall back to the committed reply when the reader falls behind. | Keep inference independent of live rendering speed. |
| Provider output limit | End the turn with `output_limit`, mark any streamed reply incomplete, and skip all tool requests in that response. | Avoid acting on a truncated response. |
| Retry during suspension | An eligible retry can finish the current call within its original deadline. | Let suspension finish the current iteration with a bounded wait. |

Implementation locations: retry budget, deadline and cutoff are in
`src/capabilities/model/runner.ts`; stream publication and reference decisions
are in `src/interfaces/protocol/server.ts` and `live-queue.ts`; durable call,
receipt and script-reservation transactions are in `src/state/storage/engine.ts`.
The stdio and in-process transports share the bounded live queue.

The spec owns execution contracts and invariants. Commit-before-dispatch, tool
result pairing, and fencing output after interruption stay defined there.

## Tools and host callbacks

These rules are proposed in the
[tools and callbacks spec](tools-and-callbacks/0001-DESIGN/SPEC.md).

| Rule | Current proposal | Why |
| --- | --- | --- |
| Tool execution deadline | Use a per-tool deadline or an optional session default. When both are unset, there is no harness wall-clock deadline. | Tools have different durations, and approval and model waits already have separate boundaries. |
| Suspension during a tool call | Wait for the dispatched tool and show which call is holding suspension open. An operator can interrupt it. | Preserve the iteration checkpoint while keeping the wait visible and cancellable. |
| Large results | The producing process saves the full result and returns a preview and opaque ID. A scoped reader returns bounded portions to the producing channel. | Keep callback frames and model context bounded while preserving access to successful results across sandbox boundaries. |
| Tool visibility | Offer available tools whose effective policy is allow or ask. Omit denied and unavailable tools. Keep the offered list across retries of the same inference. | Keep the model's choices relevant and its retries consistent. |
| Runtime tool lifetime | Keep runtime selections in memory. The consumer supplies them on reconnect before execution starts. Preserve configured grant revocations across reopen and export/import. | Let the consumer restore temporary selections explicitly and preserve lasting access decisions. |
| Quiet callbacks | Show the active tool and phase start time. Use `session/status` to probe the connection. Native turn supervision leaves a quiet callback running under its own execution deadline and cancellation rules. | A responsive connection and a silent handler provide different information. |
| Temporary result retention | The producer owns retention and declares how long it can serve the bytes, including any restart or relocation guarantees. Report expiry explicitly and keep the original outcome. Choose inline and per-read bounds at the contract gate using the wire and model-context budgets. | Keep temporary storage and retrieval limits visible to consumers. |

## Operator and consumer controls

These defaults are proposed for the
[operator controls spec](operator-controls/0001-DESIGN/SPEC.md).

| Rule | Current proposal | Why |
| --- | --- | --- |
| Transcript history on open | Harness history fetching is opt-in. Opening the agent or attaching to a channel fetches no transcript pages unless the consumer requests them. A chat UI can request the newest page automatically when the harness is its transcript source. A consumer using its own transcript can skip the history request. | Keep startup independent of transcript size and avoid retrieving a second copy of history. |
| Conversation page size | Default to 50 committed chat messages when a consumer requests a conversation page. Accept a caller-supplied limit within wire bounds. Tool activity does not consume the message count. | Match acp-client's existing conversation page default and keep pages useful in tool-heavy conversations. |

Forward catch-up is an explicit history request. Live subscription and
targeted reconciliation for tracked inputs or turns are independent of it.
