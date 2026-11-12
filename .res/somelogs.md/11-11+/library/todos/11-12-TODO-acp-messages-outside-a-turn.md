# TODO: ACP harnesses talking outside a turn (background work), and ACP v2

Related: `../11-11-SPEC-native-harness-integration.md` (turns started by the backend), `../11-11-SPEC-orchestrator.md`
(the way back from workers), `../../11-11-NOTE-overview.md`. Written 2026-11-12. Not in the current plan: the native
harness manages the entity's conversations, and the turn model already supports turns started by the backend, so
this only matters for ACP conversations and workers.

## What we know

- **ACP v1** (what Codex, Claude, OpenCode and Grok speak today): a turn begins with the client's `session/prompt` and
  ends when the agent answers it with a stop reason. The spec does not forbid updates between turns ("Session updates
  are not limited to active prompt turns", [prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)), but
  gives the agent no way to start a turn and no meaning for work it does on its own.
- **acp-client drops what an ACP harness sends between turns.** `AcpClient.handleUpdate` (`src/client.ts`, around
  line 925) returns early when no prompt is active, keeping only usage, config options, available commands and
  session-load replay. Message chunks and tool activity outside a turn are lost without a trace. The check made sense
  when every update was attributed to the running prompt (its response text, its handlers); discarding legitimate
  protocol traffic silently doesn't.
- **An evicted worker can't talk back at all:** its process is stopped. For ACP workers the way back stays the turn
  ending (seen by the orchestrator) and `check`.
- **ACP v2 is a draft** (announced 2026-07-20; schema tags `schema-v2.0.0-alpha.N`; negotiated with
  `protocolVersion: 2`). It decouples messages from turns, as our design does: the `session/prompt` response only
  acknowledges the message; the end of a turn is a `state_update` notification (`running`, `idle`,
  `requires_action`, with a stop reason); "agent-initiated work does not require a `session/prompt` request";
  background terminals and tool calls are listed on `state_update` and may report while idle; prompts sent while busy
  must be accepted and taken in order, steering or starting the next turn at the agent's choice
  ([v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft),
  [prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle),
  [migration](https://agentclientprotocol.com/protocol/v2/migration)). No page says whether Claude's or Codex's
  adapters support it.

## To do

1. **Probe (spends tokens; needs the owner's go-ahead).** With throwaway Claude and Codex sessions: start a background
   command (a sleep followed by output), let the turn end, wait, and log every `session/update` that arrives between
   turns (the wire log shows them even though the client drops them). Answers whether their adapters say anything
   after a turn. Delete the sessions afterwards; approve permissions by exact command.
2. **Stop dropping updates outside a turn,** whatever the probe shows: route them to a session-level listener, record
   them as activity on the conversation, and emit an event. They don't start a turn (v1 has no such concept).
3. **ACP v2, when it is stable:** negotiate `protocolVersion: 2` where the agent supports it; map `state_update` to the
   backend-started turns path (the same one the `NativeController` uses), the prompt response to "message accepted",
   and the `background` list to activity. Until then, v1 only.
