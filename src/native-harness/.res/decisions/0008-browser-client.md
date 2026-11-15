# Local LAN browser client

A separate LAN HTTP listener serves a mobile-friendly chat and delegates channel
requests to the same handler as the Unix transport. It shares the running agent
and output port, without changing kernel execution or model context. The inspector
remains loopback-only and its routes are not exposed by the chat listener.

Startup prints pairing URLs for local interfaces with a fresh random token. The
token is required for message and subscription requests; the page keeps it in
session storage and removes it from the address bar. This is a development access
mechanism, not participant authentication or a replacement for future policy.
Same-origin requests are enforced when an Origin header is present.

The buildless browser UI joins one channel, sends messages and displays future
replies, including notice-triggered output. History replay, rich Markdown,
automatic reconnection and remote hosting are outside this increment.
