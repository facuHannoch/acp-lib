# Proxied egress for native built-in services

**Status** — Proposed amendment to [web search and page fetching](../0001-DESIGN/SPEC.md)
and [decision 0035](../../../decisions/0035-web-search-fetch.md).

Hosted harnesses need web search and Exa-backed fetch when the only
outbound route is an operator-managed proxy. Add one reusable HTTPS
transport for built-in integrations with known service origins. Exa is
the first caller. An additional built-in service can reuse the transport
by binding its own origin, request limits and credentials.

## Ownership and configuration

- The launcher owns egress. Set `HARNESS_WEB_EGRESS=proxy-required`
  in the harness startup environment. In that mode, read `HTTPS_PROXY` as
  the proxy URL. Resolve the policy once at process startup, using the
  same resolver in native stdio and standalone CLI assembly. An omitted
  mode or `direct` uses the existing direct service route. In direct mode,
  ambient proxy variables have no effect. An empty or unknown mode
  disables web egress. Changing the route requires a new harness process.
- In required mode, support both HTTP and HTTPS CONNECT proxies in this
  slice. Accept an absolute proxy URL with an
  authority and optional root slash. Reject embedded credentials, other
  paths, query and fragment delimiters, and ambiguous URLs. Proxy
  authentication is a separate extension. Missing or malformed proxy
  configuration makes the configured Exa backend unavailable. Required
  mode ignores `NO_PROXY`. A failed tunnel returns a paired tool error
  without attempting a direct connection.
- Omit unavailable web backends from the model's offer and report the
  reason through safe harness diagnostics. An already-issued call that
  reaches dispatch gets a paired unavailable result before backend
  invocation. Model execution and other tools stay available.
- Egress configuration is runtime-only. ACP-client can supply it through
  its existing harness launch environment. Managed session config,
  tool arguments, archived sessions, and model context carry no proxy
  authority or material. Relay grants and model transport keep their own
  trust boundary.

## Shared service transport

The service adapter creates a transport bound to a fixed HTTPS origin
and supplies only origin-relative request paths, headers, a body and an
abort signal. Absolute or authority-relative paths and caller-controlled
routing headers are rejected. A service can use the transport for its own
API credential. The credential is sent only inside the TLS connection
to that service. The proxy receives the CONNECT target and no service API
credential. With an HTTP proxy, send CONNECT over plaintext and establish
verified service TLS inside the tunnel. With an HTTPS proxy, verify TLS to
the proxy before CONNECT, then independently verify service TLS inside the
tunnel. Refuse every redirect, including redirects to the same origin.

Carry the caller's deadline through connection, tunnel, TLS and response
reading. Preserve limits on wire and decoded bytes and close the
connection on abort or refusal. Transport diagnostics use fixed
categories and exclude raw proxy or provider payloads, headers and
credentials. The transport owns routing and stream cleanup. The service
adapter still owns request fields, response projection, and any usage
interpretation. Keep each service's origin in its adapter. Adding a
repository-wide registry of origins or exposing it to model input is
outside this amendment.

## First integration

Use the shared transport for Exa search and Exa-backed fetch, with the
origin fixed at `https://api.exa.ai` and the existing operation paths.
Fetch source URLs are data in Exa requests. They cannot change the
connection destination. Keep current tool admission, bounded previews,
and durable usage contracts. A call refused during admission creates no
paid dispatch record. Once the dispatch record exists, a refused CONNECT,
failed TLS handshake or lost response leaves cost unknown unless Exa
reports it. The transport diagnostic can distinguish these failures.
Preserve the immutable dispatch record across crash and recovery.

Direct URL fetch retains the public-address and actual-peer checks in
decision 0035. In proxy-required mode, a direct URL fetch backend must
return a safe unavailable error before resolving or dialing a target.
Hosted deployments can configure Exa-backed fetch instead. Proxied
arbitrary URL fetch needs its own contract for who validates the resolved
address and how that address is bound to the connection.

## Acceptance

1. Run search and Exa-backed fetch through the real native stdio path
   against local HTTP CONNECT and HTTPS CONNECT fixtures and a verified
   TLS service origin. Confirm
   the expected service authority, operation paths, request data and
   bounded result. Check that the proxy sees no Exa credential and that
   the destination receives it only after TLS verification. Fixtures do
   not change production service origins or trust settings.
2. Test wrong proxy certificates on HTTPS CONNECT and wrong service
   certificates through both proxy schemes. Test redirect traps, missing
   and invalid proxy settings, a refused tunnel, and cancellation during
   tunnel establishment and response streaming. In required mode, assert
   zero direct attempts even with `NO_PROXY` configured. Verify error
   diagnostics exclude credentials and raw proxy responses. Keep the
   direct-mode Exa regression.
3. Verify that direct URL fetch in required mode makes no DNS or socket
   request and that direct mode retains the existing address checks.
   Exercise the shared transport with a second fixture origin to prove
   origin binding and credential isolation without adding another tool.
4. Check that stdio and the standalone CLI resolve the same startup
   policy, disable web egress for an invalid mode, and keep other
   capabilities available. Verify model, relay, and MCP routing.
5. Verify complete previews and usage on success, absence of a paid
   dispatch record for admission refusals, and unknown cost on tunnel,
   TLS and lost-response failures after dispatch. Run both typechecks
   and the repository regression suites.

See the [implementation plan](PLAN.md).
