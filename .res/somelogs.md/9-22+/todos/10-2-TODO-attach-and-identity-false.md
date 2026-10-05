# TODO: `attach` on Agent, and `identity: false`

Context: discussion on adopting existing provider sessions (session/list, session/load).
Two modes were distinguished:

- **`adopt`**: the library takes ownership. Stores from now on, optional `importHistory`
  (`boolean | { last: number }`), a model-made recap checkpoint, and the conversation joins
  identity. Requires the resolver to give content capture.
- **`attach`**: bind to a provider session and drive it without storing or joining memory.

Until `attach` exists, use acp-client directly (session/list, session/load, prompts, MCP servers).

## `attach` on Agent

Bind an existing provider session (`session/load`) and drive it through the Agent model, so it
can reuse adapters, MCP servers, metering and audit configuration, without storing messages or
taking part in the Agent's memory.

Blocked on `identity: false` (below): anything under the Agent otherwise takes part in identity.

## `identity: false`

A per-conversation mark in the persistence resolver override
(`AgentConversationPersistenceOverride`): the conversation neither contributes to identity
(stored messages, checkpoint summaries) nor receives sibling identity.

- Prerequisite for `attach`.
- Also makes stored-but-excluded conversations expressible (e.g. an archive). Today stored
  content automatically makes a conversation an identity source.
- Currently out of scope in `9-24-SPEC-conversation-persistence-policy.md`: capture `none`
  covers "does not contribute", but "does not receive" is listed as a non-goal.
