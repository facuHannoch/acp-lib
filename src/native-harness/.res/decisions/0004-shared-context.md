# Shared context foundation

One agent-owned append-only store replaces independent channel histories as the
source of truth. Entries carry sequence, timestamp, channel, turn and sender.
Incoming messages are recorded on acceptance; responses and tool results are
recorded as they occur. Append and snapshot deep-copy values.

Before each inference a pure builder renders a store snapshot, the unchanged
system prompt and current channel/turn. Other turns are attributed JSON data;
the active turn keeps native assistant/tool exchanges together. Opaque provider
state is retained only for the active turn, never copied into shared text.
Tool definitions continue through the separate model argument.

Agent runners receive turn identity instead of a private messages array. The
loop receives append/build operations instead of mutating history. Composition
wires these contracts; kernel modules do not import storage or rendering.

This initial internal contract change updates existing callers and offline tests.
It deliberately includes all shared events without summaries or scope filtering.
Channel queues remain independent. Notices, wake behavior, persistence and the
inspector tab redesign are later work.
