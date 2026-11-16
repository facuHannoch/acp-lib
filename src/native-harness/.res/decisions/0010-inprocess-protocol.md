# Experimental in-process protocol

Implement initialize, session/create, channel/push and session/idle with the spec's
JSON-RPC-shaped envelopes and channel/event notifications. Version 1 here is an
explicit experimental subset, not full protocol conformance. Initialize reports
supported methods and memory-only acceptance. Reject unsupported options rather
than silently pretending to implement them. No stdio or durable acceptance yet.

Execution emits completed textual messages independently of turn completion,
including tool preludes. Clients consume these events once, without republishing
the loop's final return. Channel lifecycle and notice admission emit ordered events.
The public client correlates requests and bounds waits; in-process transport JSON
copies envelopes. Per-session item IDs deduplicate accepted inputs; conflicting
reuse fails. Scripted models are injected per channel, not globally shared.

Extract a host-independent session composition entry point with injected models,
tools and optional inspector wrappers. Existing development hosts use it too.
Storage remains in memory. Unsupported lifecycle/settings/subscription features
fail explicitly. Persistence, rich subscriptions and stdio are subsequent work.
