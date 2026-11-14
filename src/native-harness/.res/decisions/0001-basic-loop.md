# Basic loop contracts

The first runnable slice needs a model boundary without making the loop depend
on OpenRouter. Use neutral messages, tool definitions, and an injected model
function. Tool calls carry IDs and raw JSON arguments; each receives one result.
Opaque provider state travels on assistant messages and is interpreted only by
the originating adapter. Tool execution is injected by the entry point.

This is an initial, non-streaming contract, not the complete v1 API. Streaming,
cancellation and richer outcomes will require a later contract decision. There
are no existing API consumers to migrate.
