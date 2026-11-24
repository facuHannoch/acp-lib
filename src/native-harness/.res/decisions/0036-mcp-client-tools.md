# 0036 · Native MCP client tools

Status: proposed at M1. Runtime starts after review. Both stdio and Streamable
HTTPS are required for v1, shipped in that order. Keep MCP outside the kernel
and behind an optional executable adapter. Use SDK 1.31.0's client and
Streamable HTTP transport with a fenced fetch. Supply runner-owned streams
through the SDK Transport interface instead of using its process launcher.
Advertise only transports installed in the running executable. See the
[contract and probe evidence](../docs/mcp-client/0001-DESIGN/M1.md).

The managed session names servers explicitly. The trusted host assigns input
policies. Each contributing policy must explicitly allow the MCP group for
both offer and dispatch, including a recheck after approval for any existing
lifecycle hook. Text, sender labels, model arguments and remote instructions
cannot grant access. An immutable offer binds name, remote schema and current
connection generation. Stale calls refuse before dispatch.

An ordinary call may remain pending for approval and report request-scoped
progress. Its default wall deadline is 30 minutes, including transport work.
Cancellation uses the original JSON-RPC request ID and independent bounded
cleanup. After a possible send, connection loss leaves an uncertain outcome
and never triggers automatic replay. Neither elicitation nor task augmentation
is in v1. Actual agents-tools and door approval compatibility remains open
until the service owners confirm the request and progress behavior.

Catalogs, links, progress and secrets are runtime-owned. Portable configuration
stores nonsecret literals and environment references only. Existing sessions
have MCP disabled and retain their checkpoint keys when MCP fields are absent.
Reuse paired tool results and keep the complete active exchange or fail before
the next model request. No format or archive bump is proposed. Older strict
config readers refuse a session saved with MCP fields.
