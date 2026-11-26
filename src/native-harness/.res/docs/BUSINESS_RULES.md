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

## Bounded context

Starting values for [decision 0026](../decisions/0026-bounded-context.md). Tune
them with captured requests and the long-session fixture.

| Rule | Initial default | Why |
| --- | --- | --- |
| Input admission | 8 KiB of normalized UTF-8 text per message or notice. | Gives clients an exact check and bounds one new input. |
| Input take | 8 KiB of text and 16 items per inference boundary. | Several messages can steer the same turn while keeping the next batch small. |
| Context storage read | 256 KiB of serialized records and 64 records. Scan at most 128 recent candidates for shared history. | Bound how much the builder loads even when the session is long. |
| Text request estimate | Default to a 16,384-token context target, clamped to a lower configured model ceiling. Reserve 2,048 tokens for output and 1,024 for estimation error. Estimate one token per UTF-8 byte of serialized model-visible text and tool definitions for the initial text-only build. | Keeps the starting estimator simple and deliberately conservative. Tune with observed usage before adding image accounting. |
| History allocation | Start with two thirds of the remaining budget for local history and one third for shared history. Either slice can use spare capacity from the other. | Preserve local conversation continuity on a busy shared session. |

Store adjustable defaults together in the context module at implementation.
Validate that one admitted item fits an empty intake batch and that the two
reserves leave a positive request input budget.

## Operator and consumer controls

These defaults are proposed for the
[operator controls spec](operator-controls/0001-DESIGN/SPEC.md).

| Rule | Current proposal | Why |
| --- | --- | --- |
| Transcript history on open | Harness history fetching is opt-in. Opening the agent or attaching to a channel fetches no transcript pages unless the consumer requests them. A chat UI can request the newest page automatically when the harness is its transcript source. A consumer using its own transcript can skip the history request. | Keep startup independent of transcript size and avoid retrieving a second copy of history. |
| Conversation page size | Default to 50 committed chat messages when a consumer requests a conversation page. Accept a caller-supplied limit within wire bounds. Tool activity does not consume the message count. | Match acp-client's existing conversation page default and keep pages useful in tool-heavy conversations. |

Forward catch-up is an explicit history request. Live subscription and
targeted reconciliation for tracked inputs or turns are independent of it.

## Tools and host callbacks

These rules are implemented from the
[tools and callbacks spec](tools-and-callbacks/0001-DESIGN/SPEC.md) and
[decision 0021](../decisions/0021-tools-and-host-callbacks.md).

| Rule | Current choice | Why | Code |
| --- | --- | --- | --- |
| Tool execution deadline | None unless the tool (`deadlineMs`) or the session (`defaultDeadlineMs`) sets one. The tool's value wins. | A host function can legitimately run for a long time. A consumer that wants a bound says so. | `runFunction` in `src/capabilities/tools/functions.ts` |
| Deadline expiry | Cancel, commit one paired `tool_timeout` result with unknown effect, continue the turn. | The model can react. The effect is not assumed either way. | Same |
| Inline result limit | 16384 UTF-8 bytes of the complete serialized success result. More must come as a preview and a reference. Inline bytes over the limit fail as `result_too_large`. | Keeps a callback response well inside one frame and the context small. | `TOOL_LIMITS.inlineBytes` |
| Preview size | At most 1024 bytes, cut by the harness if longer. | Enough to judge whether to read more. | `TOOL_LIMITS.previewBytes` |
| Result read size | At most 16384 bytes per `read_tool_result` call. | Same bound as an inline result. | `TOOL_LIMITS.readBytes` |
| Result access | Only the channel that produced a result can read it. | A result ID seen in shared history must not grant access. | `readResult` |
| Offered order | Built-ins, fixed entries by name, `read_tool_result`, then changeable entries by name. | A stable prefix for providers that cache it. | `offer` in `src/index.ts` |
| Skipped built-in calls | Emit no `tool_call` event, as before. Catalog tools emit `skipped`. | Existing consumers see no new event for existing tools. | `recordSkip` in `src/index.ts` |

### Timeline retrieval limits

A search accepts 1024 query bytes, 32 tokens and 256 bytes per exact or
folded token. It verifies up to 1000 candidates and 2 MiB of source text.
The hit cap is 20 and excerpts use at most 512 UTF-8 bytes. A point read
accepts up to 20 neighbors on each side and returns at most 20 fragments
per page. Storage output is capped at 32 KiB of JSON. The model-tool
adapter requests at most 8 KiB so paged JSON and its cursor can fit in
active inference without the generic tool-result string shortening.

## Web search and fetch

Decision [0035](../decisions/0035-web-search-fetch.md) sets the initial web
research limits. An enabled search returns at most five hits with excerpts up to
512 UTF-8 bytes. Both tools default to a 15-second deadline and emit complete
JSON no larger than 2048 UTF-8 bytes. Direct fetch caps raw responses at 2 MiB,
decoded responses at 4 MiB and follows at most five validated redirects. Exa
fetch requests a 24-hour cache freshness target with live crawling; Exa may
return older cached content if the fresh crawl fails. A reported provider cost
is an estimate, and a paid dispatch without a committed estimate is unknown.
