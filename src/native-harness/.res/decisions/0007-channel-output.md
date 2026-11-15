# Terminal channel subscriptions

Completed turns publish channel-scoped reply/error events through a host-owned
output port. The Unix HTTP adapter exposes read-only SSE subscriptions. Chat
clients subscribe before accepting input and render replies only from that stream,
avoiding duplicates with the existing POST response. Notice-triggered turns use
the same completion path. No kernel or inference behavior changes.

Subscriptions deliver future events, not transcript replay. A lost subscription
closes the chat with a visible reconnect instruction rather than silently dropping
answers. Disconnecting a client does not cancel accepted agent work. `/clear`
only clears the local terminal, preserving both channel state and subscription.
