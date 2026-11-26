# Implementation plan for native service egress

**Status** — Decision 0040 and runtime `8c547c8` were independently
reviewed by Clad1a. Integration is pending. This plan implements the
[service egress amendment](SPEC.md) over the
[web-tool contract](../../../decisions/0035-web-search-fetch.md).

## 1. Pin the contract and resolve the runtime policy

Record the amendment in the next native decision. Document the startup
environment, safe availability reasons and transport failures. Keep
`ManagedConfig`, archived session formats and the paid-dispatch evidence
schema free of egress settings.

Add a side-effect-free policy resolver under
`src/capabilities/tools/web/`. It takes the trusted launch environment
and returns direct, proxy-required with a validated proxy URL, or
unavailable with a fixed reason. Test omission, explicit direct, empty
and unknown modes, both proxy schemes, malformed URLs, and a populated
`NO_PROXY`. Keep the parsed URL local to assembly. Only fixed reason
codes may leave it.

Use one assembly function in these entry points:

- `src/testing.ts` provides `createScriptedServer`, which also powers
  production stdio through `interfaces/cli/serve.ts`. Resolve egress at
  server construction, outside the executable-open callback.
- `src/interfaces/cli/development.ts` resolves the same policy when it
  constructs the standalone runtime. Both paths continue resolving
  service credentials for the effective executable session config.

Reuse the existing ACP-client launch environment. The host does not
need a second proxy field in the session contract.

## 2. Add a fixed-origin service transport

Put the reusable transport alongside the web runtime, below the registry
and service adapter. Its constructor binds an HTTPS origin and the
startup egress policy. Its request operation accepts a relative path,
method, service headers, body and the caller's abort signal. Reject
absolute or authority-relative request targets, ambiguous path encodings
and headers that can override routing or proxy authorization. Build the
request destination from the bound origin.

Keep a direct request path and a CONNECT path behind that transport.
Use the existing `node:https` behavior in direct mode. For CONNECT,
evaluate a private dispatcher using the existing Undici dependency.
`capabilities/tools/mcp/http.ts` shows why Bun's package-name shim and
ambient fetch dispatcher are unsuitable for isolated routing. Reuse that
lesson and the cleanup patterns. MCP policy and transport stay separate.

Use an explicit proxy per transport. Verify the proxy certificate for
HTTPS CONNECT and verify the service certificate inside either tunnel.
Send service authentication only after service TLS verification. Treat
all redirect statuses as terminal. Expose a cancellable raw response
stream so compressed bytes can be limited before decoding. On tunnel
refusal, TLS failure, abort or redirect, release the stream and connection
before returning the safe failure. Include dispatcher disposal in the
owning runtime's shutdown and failed-open cleanup if the dispatcher is
kept alive across requests.

Keep `exa-transport.ts` as the Exa adapter. Bind it to
`https://api.exa.ai` and retain its operation paths, headers, request JSON,
wire and decoded byte limits, and response parsing. `exa.ts` continues to
own tool deadlines, preview generation and provider usage interpretation.
Confirm direct and proxy paths enforce the same body limits. Add no global
fetch wrapper, environment proxy agent, or provider registry.

## 3. Apply availability and preserve dispatch evidence

Change `web/registry.ts` at the existing assembly boundary. Compute
availability by backend before resolving its credential or constructing
its executor. Invalid egress disables configured web backends. An invalid
required proxy disables Exa-backed tools. Required proxy mode never
registers a direct URL fetch executor, even when HTTP fetch is configured.
Preserve the credential rules for backends that are otherwise available.

Pass only available registrations to `createSession`.
`src/index.ts` already filters its offer through those registrations and
refuses an unoffered tool before calling the backend. Reuse its paired
`tool_unavailable` result and `webNoDispatch` marker. Keep both web tool
names reserved.

Return configured-but-unavailable reasons separately from the registration
list. Surface the fixed reasons in runtime status and the standalone
inspector, following the existing MCP status pattern without adding an
executable binding or persisting proxy details.

For a CONNECT or TLS failure after tool admission, use the existing
paired web failure path. `src/contracts/web.ts` already separates
immutable dispatch from provider-reported usage. Keep the dispatch
record and existing unknown-cost projection once that record exists.
Admission refusal creates no paid dispatch. Leave
`state/storage/web-tables.ts` and archive formats alone.

A successful Exa preview travels through the same paired result path
when provider cost is absent. Report `unknown` through the existing
usage projection and continue inference with the complete preview.
Transport failures return a paired tool error and continue the turn.
Cost remains an observation in both cases.

## 4. Verify the production boundaries

- Extend `test/web-exa.test.ts` for the direct path, request bounds, and
  unchanged previews and costs. Extend `test/web-managed-config.test.ts`
  and `test/web-session.test.ts` for egress policy, disabled offers and
  paired refusal when a model emits an unavailable call.
- Add a transport fixture with HTTP CONNECT, HTTPS CONNECT and a TLS
  service. Check each certificate failure separately, redirects,
  partial or refused CONNECT, cancellation, and credential isolation.
  Test a second bound service origin through the same transport. Use
  fixture-only trust and injection. Keep both production service origins
  and certificate verification outside model or session configuration.
- Add a real stdio rehearsal using the production proxy transport with
  fixture-only dependency injection at assembly. The existing
  `HARNESS_TEST_WEB_ENDPOINT` loopback fetch in `src/testing.ts` bypasses
  the transport and cannot serve as proxy coverage. Follow the separate
  fixture entry point used by `test/native/fixtures/web-direct-stdio.ts`
  where necessary.
- Verify no target DNS resolution or socket use for a direct URL call in
  required mode, zero direct fallback on proxy failure, unchanged
  model, relay and MCP routing, and matching standalone/stdio behavior.
  Use `test/web-usage-storage.test.ts` and `test/web-stdio.test.ts` to
  verify no-dispatch, admitted unknown cost and restart evidence.
- Run both typechecks, focused web tests and real stdio rehearsals, then
  the full root and harness suites. Send the exact tested revision to
  Clad1a for independent review. Hosted acceptance uses a launcher
  configured with the actual egress proxy as a separate deployment check.

## 5. Verify the cost clarification and integrate

1. Start from reviewed revision `8c547c8`. Clad1a independently passed
   both typechecks, 561 harness tests and 1,809 root tests. Keep the
   approved transport and decision 0040 as the integration baseline.
2. Extend `src/native-harness/test/service-egress.test.ts` with a
   successful proxied Exa response that omits cost data. Assert that
   inspection reports cost `unknown`, the next inference receives the
   complete JSON preview, and the turn completes. In the refused-tunnel
   case, assert that the next inference gets a paired tool error and
   can complete, with the same `unknown` cost. Retain the existing
   assertions for an explicit zero estimate and an admission refusal.
3. Exercise an ACP-client replacement harness process with the same
   launcher configuration. Assert that it still uses the configured
   proxy with `NO_PROXY` set and makes zero direct attempts. A fixture
   using a new raw harness process only verifies the harness policy.
4. Carry the clarified spec and focused tests onto an isolated
   integration candidate. Rerun the focused cases, both typechecks and
   the combined suite on the exact candidate. Send Clad1a any delta
   for review. Check the candidate against current `alpha` before
   landing. A hosted smoke test remains a separate deployment check.
