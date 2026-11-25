# 0040 · Native service proxy egress

Exa search and Exa-backed fetch share a fixed-origin transport. Each process
resolves its trusted launch environment once. Only uppercase `HTTPS_PROXY`
is read, and only in `HARNESS_WEB_EGRESS=proxy-required`. Lowercase variables
and `NO_PROXY` have no effect. Omitted or explicit direct mode uses a private
direct dispatcher. Invalid policy disables configured web backends. A valid
required proxy disables arbitrary URL fetch before DNS. A relaunched harness
uses the environment supplied by the same launcher configuration.

Explicit HTTP proxies may be remote. The launcher is trusted to select the
proxy, so public-address filters do not apply to it. An HTTPS proxy verifies
the proxy hostname, or the IP SAN for an IP literal, before sending HTTP/1.1
CONNECT to `api.exa.ai:443`. The authority is fixed by the service adapter.
No proxy authorization or service credential is sent in CONNECT. Accept
only a 2xx CONNECT response, with headers limited to 16 KiB under the caller
deadline. Bytes after the headers remain tunnel bytes for the TLS parser.
On refusal, destroy the connection without reading or reporting a proxy body.
Verify independent origin TLS inside the tunnel with service SNI and HTTP/1.1
before sending the API credential. Use system trust and assembly-only fixture
trust. Refuse all service redirects and preserve wire and decoded limits.

Never fall back to direct. Keep only fixed diagnostic categories. Admission
refusals create no paid dispatch record. CONNECT refusals and proxy or service
TLS failures after admission provide no reported charge, so existing durable
cost accounting reports unknown. There are no session, archive or Hub proxy
configuration fields.

See the [amendment](../docs/web-tools/0002-AMENDMENT-service-egress/SPEC.md).
