# MCP client tools

Status: Proposed for v1.

The harness connects to operator-configured MCP servers and offers their tools
through the existing tool lifecycle. Implement local stdio first for
agents-tools and installed packages, then Streamable HTTP over HTTPS for
agents-hub, direct URLs, and the door. Both transports are required for v1.
The same managed configuration works in standalone mode and through acp-client.
The members' MCP server remains a separate feature.
[Harness architecture](../../../../ARCHITECTURE.md)

## Configuration and transports

Define a session-level map of named MCP server entries. A stdio entry supplies
an executable, argument array, optional working directory, and explicit
environment variable references. An HTTPS entry supplies an endpoint and
configurable request headers. Support literal nonsecret values and environment
references for secrets, including authorization. If the trusted launcher
supplies a resolved secret header, keep it in runtime-only configuration.
Resolve credentials on executable open and keep values out of persisted
configuration, archives, and diagnostics. Export may carry nonsecret settings
and reference names. Allow an operator to disable an entry.

Support Streamable HTTP response framing, including event streams used
within that transport. The legacy HTTP+SSE transport and OAuth login are deferred.

Start local servers through the execution port with the deployment's runner
boundary and an explicit environment. Execute the configured command directly.
Keep protocol stdout separate from bounded stderr diagnostics. The runtime
owns shutdown and managed child cleanup. Use certificate validation for HTTPS
and refuse redirects. Bind credentials to the configured endpoint. Resolve
configuration from the operator or trusted host. Model inputs, tool results,
and server instructions have no authority to add servers or change endpoints.

Use a maintained MCP SDK compatible with Bun for negotiation and both
transports. Keep it behind an optional harness entry point. The contract review
must verify that its stdio transport can use our execution boundary, that its
HTTP transport can enforce the configured endpoint and deadlines, and that
both transports interoperate with the selected protocol revisions. If the
SDK's local launcher cannot use the execution boundary, use the SDK's client
with a runner-backed transport. [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/)

## Discovery and policy

The runtime owns one connection per enabled server entry per executable
session. Channels share the connection. Configure separate entries when
different credentials or different server-side state are needed. Inspection
and import do not spawn or connect to servers.

Bound initial connection and discovery. Negotiate capabilities, read tools
through the SDK, follow bounded discovery pages, and register validated
definitions under stable names such as `mcp__issues__list`. Reserve the MCP
namespace. Pin a deterministic naming and collision rule that preserves the
route back to the original server and tool name. Bound the catalog by tool
count and serialized schema size. A failed server stays visible as
unavailable without blocking other servers or normal session work.

On explicit reconnect or a new executable open, rediscover tools. Optionally
handle `notifications/tools/list_changed` by replacing the validated catalog
for that configured server and refreshing the next model offer. This refresh
does not discover unconfigured endpoints. Agents-tools already lists
connectors live through the gateway. Recheck that an offered tool still
belongs to the current catalog at dispatch. A stale offer cannot silently
route to a changed or removed tool. SDK-managed negotiation and discovery
stay outside the kernel.

Each named policy has one MCP grant, with deny as the default. For an MCP
tool, the permission gate uses this group grant in place of individual tool
grants. An operator can allow the whole group for the owner policy. The host
assigns that policy using trusted attribution. Participant text and display
names grant no authority. Every policy contributed by taken inputs must allow
MCP. A guest restriction in a mixed turn denies the group. Pending inputs
take effect under the existing policy snapshot rules when taken. Apply the
same check when offering tools and immediately before dispatch. A model
cannot invoke a hidden MCP tool by guessing its name.

The grant controls tool use. Shared timeline visibility and shared
server-side credentials follow their existing session boundaries.

## Calls and lifecycle

Validate the arguments against the registered supported schema before
dispatch. Use the existing invocation ID, permission gate, dispatch
evidence, deadline, abort signal, and result pairing. Keep the MCP server
and remote tool identities in operator diagnostics. Provider and SDK details
stay in the MCP adapter.

Use a configurable wall-clock call timeout, initially 30 minutes, to cover
approval flows that wait up to about 23 minutes. Startup and discovery retain
separate short deadlines. Support request-scoped progress notifications, using
a progress token to associate updates with the call. Updates at about 25-second
intervals leave the call pending. The first implementation keeps the
30-minute wall-clock bound even when progress arrives. A progress-reset idle
deadline can follow if needed and must retain a hard wall-clock cap.

When turn interruption or deadline expiry cancels an in-flight MCP request,
send `notifications/cancelled` with its original request ID on either
transport when the connection remains writable. Bound the cancellation send
and settle the local tool result even if the server fails to respond or
continues working. Discard late results. Cancellation of one invocation leaves
unrelated calls usable.
[MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation) ·
[MCP progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)

Normalize remote tool success, tool errors, connection failure and timeout
into the existing outcome model. Preserve supported text and structured data
within wire and model-context budgets. Clipped results remain usable, with
an explicit clipping marker and complete structured metadata. Treat results
as external data. Define how unsupported content blocks are reported. Server
instructions, prompts, resources, model sampling, elicitation, and OAuth
login are outside the initial capability.

If the transport fails after a request may have been sent, record an
uncertain outcome and avoid automatic replay of the tool call. A reconnect
can restore availability for subsequent invocations. Closing a session
cancels outstanding calls, releases HTTP resources, and reaps owned stdio
processes. Catalog and connection state are rebuilt on executable open.
Tool invocations and paired results use the existing durable trace.

## Launch integration

Add the native harness entry in the upstream launcher under `harness/launch/`
once both client transports work. The proposed native input is managed
`harness.config.mcpServers`. Convert launcher-provided definitions at the
native launch boundary and forward them through acp-client on executable
create and reopen. Keep the other harnesses' existing config paths. The
contract decision must confirm the mapping and capability advertisement.
Add a W18-style gate that launches a real native session with an agents-tools
stdio entry and an HTTP fixture with headers, then discovers and calls a
tool from each. The gate must prove the running session received the entries.

## Contract and acceptance

Publish a numbered decision before implementation. Pin public config and
capability fields, policy resolution, optional SDK packaging, startup and call
limits, discovery bounds, freshness, tool naming, supported input schemas,
result projection, failure codes, and compatibility. Keep existing
configurations and session files readable with MCP disabled by default.

1. Use one deterministic test server with both stdio and Streamable HTTP over
   HTTPS. Run a real discovery and call through each transport, including one
   tool result observed by the next scripted inference. Extend the cumulative
   real-stdio harness rehearsal rather than mocking the harness tool executor.
2. Verify owner, guest, and mixed-turn offers and calls. A denied or forged
   invocation has one paired refusal and causes zero requests. Test duplicate
   names, oversized discovery, malformed arguments, and stale offers.
3. Verify use of explicit environment references, authenticated HTTPS, redirect
   refusal, configurable headers, missing credentials, and secret-free
   portable config and inspection. Verify local process cleanup on close.
   Run the launcher integration gate.
4. Use a controlled clock or shortened fixture timings to exercise a
   23-minute approval wait with progress and the 30-minute wall deadline.
   Check that no shorter underlying SDK or host timeout ends the call. Stop a
   turn while a call is pending on each transport and assert that the server
   sees the original request ID in `notifications/cancelled`. Exercise a
   server that ignores cancellation and a late response.
5. Disconnect after dispatch and verify one recorded uncertain outcome with
   zero automatic replays. Reconnect and make a new call. Test bounded results
   and unrelated tool availability after a server startup failure.
