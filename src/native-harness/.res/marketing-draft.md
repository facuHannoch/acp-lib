# Harness positioning draft

Provisional wording for later marketing work; this is not an implementation spec.

One agent. Many conversations. A distinct relationship with every participant.

A configurable agent runtime for one persistent identity across many concurrent
conversations, with participant awareness and explicit policies.

The intended strengths are concurrent, independent channels; recognition of
distinct participants and their relationships to the agent; continuity across
conversations; and consumer configuration of the system prompt, tools and policy.

The initial reason to build it is to support acp-client's intended behavior.
Standalone adoption is an additional possibility, not a prerequisite.

The harness is not focused on coding and initially lacks coding capabilities.
Consumers can supply tools and instructions for their own use cases. In
acp-client, those may include access to external coding workers; that integration
belongs to acp-client, not to the harness's built-in responsibilities.

These are positioning ideas, not claims of uniqueness relative to other systems.
