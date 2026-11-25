# Trusted HTTP endpoint for native inference

**Status** — Implemented on the relay branch. See [decision 0039](../../../decisions/0039-trusted-inference-relay.md)
and the original [decision 0034](../../../decisions/0034-openai-compatible-inference.md).

ACP-client and the native harness need a way to use an explicitly trusted
inference relay, such as `http://10.250.0.4:8080/v1`. HTTPS is preferred.
Ordinary OpenAI-compatible sources keep the current HTTPS or canonical
literal loopback HTTP rule. The relay exception authorizes one exact URL
at executable open. Endpoint discovery, grant issuance, and deployment
qualification belong to the embedding application.

## Portable request and runtime grant

Add `credentialMode: "relay"` to the `openai-compatible` model declaration.
The portable declaration contains the provider ID, model and base URL.
Reject `apiKeyEnv` in relay mode. Only a runtime relay grant can authorize
execution or supply the credential. Ordinary sources continue using the
existing environment-reference path.

The embedding application provides a `harness.inferenceRelayGrant`
callback. ACP-client invokes it for executable create and reopen, including
recovery. The callback receives the session ID and abort signal and may
return a grant containing `baseUrl`, `bearerToken`, and `expiresAtMs`
(a Unix timestamp in milliseconds). ACP-client forwards that grant in the
top-level `inferenceRelayGrant` field of the executable request over the
native control connection. The value applies to that session open only.
Startup retries and later opens obtain fresh material through the callback.
The callback may return no grant for sessions without a relay. Launchers
using the native protocol directly may supply the same executable-only field.

The harness verifies the selected credential mode, base URL match, token
presence and expiry before making the session executable. Missing,
malformed, expired or mismatched material fails with `invalid_config` and
a safe diagnostic. Reject a grant on an ordinary source or on validation,
inspection and import paths. Prompts, channel settings, sidecars and
archives cannot supply a grant. Keep the grant and token out of durable
state, archive, request capture, logs and error details.

## Trust boundary and credential lifetime

The native control connection must be controlled by the trusted embedding
application. A runtime grant is executable authority on that connection.
The harness check is a guardrail for a trusted launch. Processes sharing
the harness's workload can use a credential accessible to that workload.
The relay must authenticate the workload and enforce its grant on each
request. Harness-process-only authority requires separate isolation.

The embedding application supplies a short-lived, relay-only credential
scoped to the workload and its permitted inference route. The relay or its
upstream service keeps the model provider key. The harness sends the
runtime token as a bearer credential and never falls back to a model key.
Enable plaintext only on a path the embedding application can keep
isolated from untrusted observers and peers. Plain HTTP exposes the token,
prompts and tool data to anyone who can observe the traffic. If that
isolation cannot be guaranteed, use TLS or an authenticated encrypted
transport.

The first version refreshes material on executable reopen. The harness
checks expiry again before each dispatch. If a grant expires while open,
surface a specific relay-credential failure and let the host reopen with
fresh material. Expiry never authorizes a fallback or an automatic replay
of a possibly accepted inference. In-place refresh is a separate extension
for consumers that need uninterrupted long-lived sessions.

## Endpoint matching and dispatch

Use one harness canonicalizer for the configured and granted URLs. Compare
scheme, IP or hostname, effective port and base path, then use the canonical
granted URL for dispatch. Append `/chat/completions` through the existing
adapter and refuse all redirects, including same-origin redirects. Relay
requests must bypass ambient proxies so the credential goes directly to
the bound destination.

- Normalize scheme and DNS hostname case, remove an explicit default port,
  and strip trailing path slashes. Preserve path case and nondefault ports.
- For HTTP, require a canonical literal IPv4 or bracketed IPv6 address.
  IPv4 must use four decimal octets without leading zeroes. IPv6 must be
  the lowercase compressed spelling produced by the URL parser. Reject
  alternate numeric IPv4 forms, expanded or uppercase IPv6, IPv4-mapped
  IPv6, zone IDs and hostnames. A private range by itself grants nothing.
- Reject userinfo, query and fragment delimiters, whitespace, backslashes,
  ambiguous authorities, percent escapes and dot segments before URL
  normalization. For example, `HTTP://10.250.0.4:8080/v1/` and
  `http://10.250.0.4:8080/v1` match. Changing the address, port or path
  requires a new grant.

## Portability and recovery

Validate and import relay declarations structurally without requiring
credentials. Inspection can display the portable declaration. Export
includes the normalized URL and relay mode. A restored session requires
a new runtime grant from its destination for executable reopen. Keep
grant material and expiry out of checkpoint identity. Endpoint changes
remain subject to the existing compatibility fence. Existing formats can
carry the declaration. Switching credential modes also fences a checkpoint.
Older strict readers may reject the new field.

## Acceptance

1. Use an ACP-client fixture launcher and a local relay to exercise
   executable create, reopen, and recovery. Verify that every open receives
   fresh material and that the relay receives the intended bearer credential
   at the exact configured API path. Assert zero redirected or proxied
   requests.
2. Verify that missing, expired, malformed and mismatched grants fail before
   dispatch, even when an upstream model key is available. Check expiry
   on an already-open session and successful reopen with fresh material.
   Confirm that validation, inspection and import reject grant material.
3. Exercise URL equivalence and rejection, including different address, port
   and path, ambiguous IP spellings, and percent-encoded or dot path segments.
   Check both grant comparison and actual dispatch. Preserve the ordinary
   HTTPS and canonical loopback cases.
4. Export and restore a relay-backed session. Inspect it before authorization,
   verify the declaration survives, and confirm executable reopen refuses
   missing authority and succeeds with fresh material. Use credential
   canaries to check storage, archive, protocol tracing, diagnostics and
   request capture.
