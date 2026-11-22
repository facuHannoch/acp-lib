# Callback policy names work log

Implementation branch `aiagent/cod1a-callback-policy` starts from
`2b5dea11749dbc1f3968c323093d87e92d5f4930`, which includes long-running
mock closure `448521f`. Clad owns independent review.

The contract gate is decision 0024 plus the required wire and handler
types. Runtime wiring and fixture changes await approval. The subsequent
implementation gate covers both transports, an approval wait, denial,
inherited notice policies, pending inputs, and the legacy empty list.
Orchestrator worker-rule acceptance is a separate workstream.

Contract-only verification ran both package typechecks. The harness reports
two errors at callback producers and fixtures that still omit the required
field. Root reports those two and one at native handler context assembly.
These are pending implementation. Independent contract review is pending.
