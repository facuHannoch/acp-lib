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

These rules are proposed in the
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

The spec owns execution contracts and invariants. Commit-before-dispatch, tool
result pairing, and fencing output after interruption stay defined there.
