# Channel input and execution

One agent owns shared configuration and a map of channels. Inputs contain a
channel ID, participant ID and text. Each channel owns its history and a promise
queue; different channels execute concurrently. Participant identity is supplied
by the client and labeled in context, not authenticated in this increment.

The transport calls a small Agent interface and does not own history. The kernel
receives an injected turn runner so it depends only on contracts. HTTP over a
Unix socket connects separate local CLI processes. This experimental endpoint is
not the eventual host protocol.

An execution failure blocks that channel until process restart, avoiding reuse
of incomplete tool exchanges or automatic replay of side effects. Disconnects
do not delete channels or cancel accepted turns. All state is in memory.

This adds an initial channel API; the existing loop contract is unchanged.
