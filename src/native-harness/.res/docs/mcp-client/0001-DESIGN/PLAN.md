# MCP client implementation plan

Status: Proposed. Start with a contract and SDK conformance probe.

Build local stdio first for agents-tools and installed packages, then
Streamable HTTP over HTTPS for agents-hub, direct URLs and the door. Both
transports are required for v1. Use the same discovery, policy, execution
and result path in each. Keep authentication to configured credentials in
this slice. [MCP client spec](SPEC.md)

## M1 · Verify the protocol and freeze the contract

- Confirm with the agents-tools and door owners that their approval flow keeps
  an ordinary `tools/call` pending and reports progress. Capture a sanitized
  transcript or an equivalent fixture. If either requires MCP elicitation or
  task-augmented requests, identify the missing operation before promising
  compatibility with that server.
- In a small offline Bun probe, connect the same test server over stdio and
  Streamable HTTPS using a maintained SDK. Verify protocol negotiation,
  discovery, per-call timeout, progress and the actual cancellation frame.
  Confirm how to pass runner-owned stdio streams and where to enforce
  receive bounds before the SDK parses messages. Pin the package version and
  supported protocol revisions. Reuse the SDK for protocol behavior.
- Define the managed server map and connection status, including transport
  capability on native hosts. Freeze the owner policy grant, deny by
  default, and the rule that every policy of taken inputs must grant it.
  Trace the owner policy assignment from the trusted host and test that guest
  input cannot name it. Include the grant in checkpoint compatibility while
  preserving existing fingerprints when the grant is absent.
- Freeze catalog limits and name encoding, supported schema dialect or
  subset, catalog snapshot semantics, and typed outcomes. Reject unsupported
  schemas at registration. The current `util/schema.ts` validator ignores
  unknown keywords. Capture an immutable binding of name, server, schema and
  connection generation in the offer. A changed or unavailable definition
  refuses dispatch instead of being silently replaced.
- Pin receive limits, result budgets and the active exchange rule. Proposed
  first slice uses a complete serialized preview within the inline limit.
  Preserve the just-produced MCP call and all its paired results for the next
  inference, or fail with `context_limit` before contacting the model. Reuse
  the web-tool exchange behavior when composing with G2.
- Define reserved HTTP headers, secret resolution and reopen behavior, SDK
  timeout precedence, and outcome handling for cancel, remote tool error,
  timeout and connection loss. Use a 30-minute wall-clock call timeout by
  default, with shorter startup and discovery limits. Progress does not reset
  the wall clock in v1.
- Publish a numbered contract decision and the probe evidence before dependent
  implementation. Choose the base and decision number at dispatch. Coordinate
  edits to session assembly, config, context and persistence with G2.

## Proposed code structure

Paths in this table are relative to `src/native-harness/`.

| Area | Placement and responsibility |
| --- | --- |
| Contracts and config | `src/contracts/mcp.ts` for provider-neutral config, status and registrations. Extend managed validation and portable projection through the existing config paths. Keep SDK types and objects inside the adapter. |
| Protocol adapter and connection lifecycle | `src/capabilities/tools/mcp/` owns SDK connection and discovery, name mapping, validation and result projection. Split the stdio and HTTP transports into separate files behind a shared client contract. Track connection generation and in-flight request IDs there. |
| Process execution | Use `src/runtime/execution/` for the runner-backed stdio adapter. The architecture identifies the execution port, while the current runtime has no general implementation in that directory. Add the small spawn and teardown seam needed by MCP and coordinate with foreground shell so ownership and cleanup can be reused. |
| Session assembly and policy | Wire the optional adapter at executable entry points through `src/index.ts`. Compose definitions with existing tool offers and dispatch, and enforce the group decision under `src/governance/policy/`. Keep SDK imports outside the kernel and the base client entry point. |
| Context and inspection | Use `src/capabilities/context/` for bounded, paired results. Surface per-server status and typed failures in the existing inspection path. Keep credentials and raw SDK state outside model requests, snapshots and diagnostics. |
| Tests | Put transport conformance and fixtures in harness `test/`. Extend the cumulative real-stdio fixture under root `test/native/fixtures/` and its rehearsal driver. |

Use existing durable dispatch evidence and paired results. Connection state,
catalogs, credentials and progress notifications are runtime-owned. Reassess
storage compatibility only if the approved contract requires new durable
fields.

## M2 · Stdio and the shared lifecycle

- Start configured executables through the runner, using explicit working
  directory and environment. Negotiate and discover bounded tools. Publish
  an unavailable server status when spawn, negotiation or discovery fails.
  Other servers and built-in tools continue to work.
- Make a real call through the model's normal tool path. Use the existing
  invocation and paired results and correlate the MCP request and progress at
  the adapter. Cancel on turn abort or deadline using the SDK or the
  transport, with one notification per request. Keep the cancel send usable
  even after the invocation signal aborts. Bound its wait, ignore late
  responses, and release the per-call state. Reap owned processes on close.
- Verify the first cumulative phase with a real fixture subprocess. Cover
  owner, guest and mixed-turn policies, spoofed policy selection, forged and
  stale tools, invalid schemas and arguments, oversized discovery, timeouts,
  disconnect without replay, and cancellation without affecting another
  invocation. Assert what reaches the next model request near its budget.

## M3 · Streamable HTTPS

- Add the HTTPS transport against the same client contract. Configure
  headers and secret references, reserve protocol-owned headers, validate
  certificates and refuse redirects. Keep resolved values outside portable
  config and redact diagnostics. Exercise the actual SDK HTTPS adapter
  against an offline local fixture with test-only certificate trust.
- Reuse the stdio conformance cases. Test configured headers, including secret
  values confined to their endpoint, bad certificates, redirects, bounded
  streamed responses, and a stopped turn sending `notifications/cancelled`
  with its original request ID. Exercise a 23-minute-equivalent pending
  approval with progress about every 25 seconds and a hard 30-minute timeout
  with a controlled clock or scaled fixture. Verify SDK and host deadlines
  leave the intended window available.
- Extend the cumulative fixture with the HTTPS path. Preserve the stdio phase,
  real tool execution and exact script consumption. Report unsupported
  content as a bounded paired outcome. Treat `tools/list_changed` as an
  optional follow-up for already-connected servers.

## M4 · Native launch integration

The upstream `harness/launch/` and W18 code are outside this checkout.
Coordinate the upstream card after both transports are usable.

- In acp-client, use the public harness SDK types. Today
  `src/native/capabilities.ts` advertises both MCP transports as unsupported,
  and the native host passes typed `ProtocolConfig` on executable create
  and open. Add capability forwarding and use the approved
  `harness.config.mcpServers` mapping at the native launch boundary. Reapply
  runtime header material on reopen. Keep other ACP launches on their
  existing paths.
- Add a W18-style launcher test that configures agents-tools over stdio and
  a Streamable HTTPS fixture with headers. Launch a real native session
  through acp-client and discover and call one tool on each connection.
  Prove that guest inputs have no MCP grant and that the configured servers
  and credentials reach the intended session on reopen.

Submit each slice's exact revision with focused tests and both typechecks.
The final gate runs unified transport conformance, the cumulative real-stdio
rehearsal, and the full harness and root suites. Live service checks can run
separately with the operator's configured servers.
