Initialize is a simple handshake. There is not much about it. It is necessary every time the communication starts.
Here is however where we can know some important things:
- confirm the agent supports 
    - fs
    - terminal

- what the agent accepts in prompts
- which transport types it can use to connect to MCP servers
- if the agent can load sessions
- the auth methods (authentication)
- if logout is supported (authentication)
- if sessions can be loaded (sessions load)
- other information
    - additional directories


Authenticate is probably going to be much easier with the package implementation. Otherwise we need to take care of certain back and forth communications.




**acp protocol responds with empty result if everything is ok**





session new

there are two ways agents seem to declare models and configurations:
- result -> models / modes / etc

"mode" is kind of arbitrarry. Codex uses it for access level, open code for disntiguising between plan and code. The only thing that seems guaranteed is the model.
And the only thing that seems maybe not guaranteed but unambiguous is the reasoning level.


session/promt

kimi only returns end_turn after a message, without any error. This could be a login issue.

*What happens when sending multiple messages*

It can be learned the behavior by trying, but that is an arbitrary implementation. So we should define a spec withing the library.

- not allow to send a new message until a end_turn
- always send session/cancel explicitly for interrupting and sending a new message, even if you suspect the agent already cancelled itself.
- if queueing a message, handle the logic within the library

  [busy] → user sends new prompt
    → enqueue
    → when end_turn arrives OR cancel completes → send queued prompt

  Or if you want to expose an interrupt:
  user calls interrupt(newPrompt)
    → send session/cancel
    → wait for cancelled/end_turn response
    → send newPrompt


*session/prompt response*

  → send session/prompt
  ← session_info_update (active) [Codex-specific]
  ← agent_message_chunk* (streaming text)
  ← tool_call (in_progress)          ┐
  ← tool_call (in_progress)          │ parallel, any order
  ← tool_call_update (completed)     │
  ← tool_call_update (completed)     ┘
  ← agent_message_chunk* (more text after tools)
  ← usage_update (after each LLM turn)
  ← session_info_update (idle) [Codex-specific]
  ← result: { stopReason, usage }    ← the actual JSON-RPC response





