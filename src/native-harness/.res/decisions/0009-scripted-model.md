# Scripted model for offline execution

Use the existing Model contract with a sequential, instance-local JSON script.
Version 1 contains responses with content and optional tool calls. Script call
arguments are JSON objects and are serialized to the neutral contract's string
arguments. Validate the complete script before execution, reject unknown fields,
and fail explicitly on malformed files or exhaustion.

Capture each invocation's messages and tool definitions by value, including an
exhausted invocation, and return copies for inspection. No API request or inference
occurs. The script's final text is predetermined; tests separately verify actual
tool execution and the request that follows it.

A dedicated scenario CLI composes the real store, builder, scheduler and loop
with the scripted model and echo tool. Echo is registered only there and in tests,
never in normal startup. Instances consume responses in call order; callers needing
independent concurrent scripts must use separate instances. No kernel contracts,
stdio transport, normal launch behavior or persistence change in this increment.
