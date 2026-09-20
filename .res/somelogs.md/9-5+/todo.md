Practically, no.

`PromptResult.messages` was already being retained, so this does not introduce a second copy of the response. The new helper only allocates a combined string when a consumer explicitly requests one.

In fact, consumers rendering `messages` independently can avoid creating the large flattened `text` string. The deprecated `PromptResult.text` is still currently computed for compatibility, so today performance is essentially unchanged.

A future breaking release could remove eager `text` generation entirely, making the structured approach slightly more memory-efficient for large responses. Network, model inference, transcript I/O, and tool execution costs dominate this tiny formatting cost.







  - Some direct-session persistence combinations; managed sessions are the complete persistence path.
  - Managed degraded/PTY persistence.
  - Combined transcript-and-audit reconfiguration.
  - Long-term V1 compatibility; V1 is transitional.
  - Rich first-class command descriptors for AgentSession-level commands, which we discussed but have not yet
    implemented.
