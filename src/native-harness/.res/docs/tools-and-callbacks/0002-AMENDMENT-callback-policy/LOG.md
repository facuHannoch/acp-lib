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

Clad approved the contract at `cc1105a4591dee18d200c488e4a822bf3246dbda`.
The implementation sorts exact names lexically. The gate reads the
contributors once after checking tool structure. It retains policy denial
precedence and rechecks tool availability before dispatch as before. The
executor uses the same snapshot, with the legacy fallback omitted, and
the handler gets its own copy. Invalid metadata returns invalid_params
from the common callback client boundary. The harness records this as one
paired failed tool result and does not retry the callback.

Both package typechecks passed after implementation. The broad harness run
passed 346 tests and reported five stdio failures in the unchanged suspension,
large-reply, and relocation cases. The errors were session/create or channel/push
timeouts and exit 137 after the stdio helper's cleanup timer. A serial rerun of
those suites and the callback protocol suite passed all 37 tests. Existing
transport and cleanup deadlines were kept. The callback protocol cases reuse the
shared client and stdio fixtures in the existing protocol test file.

Both transports cover single policy, empty legacy metadata, a guest notice
in an owner turn, forged argument metadata, and a blocked input excluded during
approval but applied once taken. They also exercise approval denial and check
that malformed or absent callback metadata is refused before the handler.
Consumer invalid_params is paired once as a failed tool result. Native handler
context has separate in-process and real-stdio coverage. Worker rule composition
and assignment policy retention remain orchestrator acceptance dependencies.

Final root `bun test ./test` passed 1422 tests with no failures, 12113
assertions, and 35 snapshots. Both typechecks passed on the final tree.
Independent implementation review is pending.
