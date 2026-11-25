# OpenCode Go for native inference

Status: Implemented in the native harness. Amends [model execution](../0001-DESIGN/SPEC.md)
and extends [decision 0034](../../../decisions/0034-openai-compatible-inference.md).

The default native agent template uses OpenCode Go. Its requests currently
fail before inference because Go requires a conversation routing header.
Native should support Go by name through the existing Chat Completions
client, so the template can use a Go API key and reach the native gateway.

## Managed configuration

Add a provider preset to `harness.config.model` for executable create and
open.

```ts
model: {
  protocol: "opencode-go",
  model: "deepseek-v4.1-flash",
}
```

Require the exact upstream model ID. Accept an optional `apiKeyEnv` override
with `OPENCODE_API_KEY` as the default, and accept the same optional
`contextBudget` as the compatible arm. Reuse strict managed validation.
Normalize the credential reference in the existing managed config and archive
paths. Resolve the value only at executable open. A missing or blank key is
an `invalid_config` error before any request. Validation, inspection and
portable import need only the reference.

The preset fixes the request destination to
`https://opencode.ai/inference/go/openai/v1/chat/completions` and rejects
redirects. It sends the key as a Bearer token and a User-Agent identifying
the native ACP-client harness. Keep credential values and raw provider error
bodies out of observability and archives. Reuse Chat Completions request,
streaming, tool-call, usage and context-budget behavior. The initial preset
supports text input.
[OpenCode harness API](https://opencode.ai/docs/console/harnesses/) ·
[OpenCode Go client requirements](https://opencode.ai/docs/console/go/#where-can-i-use-it)

## Conversation routing and recovery

Send `x-opencode-session` on every request through the preset. Derive its
value from the durable native session ID and channel ID using a structured,
namespaced hash with a `ses_` prefix. The same channel sends the same value
across turns, tool continuations, retries and executable reopen. Channels
within a session send distinct values. Avoid sending raw native IDs, user
identities or credential material in the header.

Include provider identity, the fixed endpoint and upstream model in the
checkpoint compatibility key alongside the existing execution inputs.
Provider or model changes fence an incompatible checkpoint. Credential
rotation preserves compatibility. Reuse the managed config store and
archive versions. Older strict readers refuse the new config arm. When the
[model catalog](../0003-DESIGN-model-selection/SPEC.md) lands, it can
reference the preset and reuse its connection and request behavior.

## Error reporting

Propagate upstream HTTP status and recognized, sanitized error codes to the
native turn error. Distinguish missing routing metadata, rejected
credentials, and rate limiting. Use safe status-based messages for unrecognized
codes. Preserve the existing retry policy for transient failures and terminate
nonretryable request failures. The channel remains available for future turns.

## Evidence and acceptance

A direct authenticated probe against the official Go endpoint used
`glm-5.3` and a synthetic tool. Its first attempt returned a streamed tool
call and usage, then timed out on the continuation. A fresh probe carried
the tool definitions on both requests and received HTTP 200 twice, a
streamed tool call, a final answer reflecting the tool result, and usage
on both replies. A live ACP-client native stdio turn then discovered and
called a local MCP fixture and reported its result. Acceptance against the
upstream Hub gateway remains pending.

Use the [implementation plan](PLAN.md) for the offline and live gates.
