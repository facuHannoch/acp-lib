# TODO: User-entered code for tools

Date: 2026-11-20.
Status: deferred until consumer-registered callbacks work end to end.

Explore an optional executor for tools whose implementation is written by a
user. The current callback design uses implementations registered by the
consumer. User-entered code needs a separate execution environment because a
normal callback can inherit the host's access to files, credentials, and
network resources.

Before designing an implementation, decide:

- Who can create, edit, and enable a code-backed tool.
- Which language and runtime are supported, and which resources the executor
  can access. Start with explicit grants for files, network, and credentials.
- How to bound time, memory, and output, and how cancellation and uncertain
  effects are reported through the existing tool-call lifecycle.
- Whether code and its version travel in a session export. Define what the
  destination must approve before imported code can run.

Reuse the existing tool schema, policy gate, and call records. The gate
authorizes dispatch. The executor enforces the limits on what the code can do.
