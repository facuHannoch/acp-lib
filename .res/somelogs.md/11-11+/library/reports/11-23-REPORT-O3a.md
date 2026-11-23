# O3a assignments and the ACP reply path

## Alpha integration and production callbacks

`1c5829a` merges alpha `0003f20` without conflicts. It brings in the worker-delivery repository, schema 20, the terminal lifecycle binding and the native notice scan.

`41a225d` wires the delegation sender lookup through `serveFunctions` on the connection that receives the callback. The real in-process harness test keeps `session/create` in flight in the production host until the native tool has returned its result. The callback can reconcile its taken item before the host installs the connection. No worker-flush hooks changed.

`0e9c79b` trims the taken sender before checking the reserved prefixes. The same production-path test covers a plain sender and IDs with leading space, NBSP or tab. Notice labels stay distinct after the downstream participant normalization.

`ee6026e` moves the reconciliation lookup under `src/native/`. The production callback test also confirms that an ID consisting only of U+200B and whitespace is refused before it can open a worker.

## Assignment and refusal

`ae54682` reserves new assignments from `beforeDispatch` with the invoking call's ID, the causal worker message ID, the destination and the policy names. A duplicate reservation or replacement does not dispatch again. Continuation moves the existing binding to the successor message, adds the new policy contributors and retargets on redirect. These writes share one transaction. Explicit replacement uses `replaceAssignment`; a successful `replaced` result schedules the native flush. Local work without a return destination does not create a delivery assignment.

A busy send returns `steered` when queued. If the later pre-dispatch check rejects, the worker receives no successor prompt. The failed attempt publishes a `worker_failed` fact with reason `refused`, the giving conversation and the safe cause `conflict` or `hook_error`. The same refusal goes to that conversation as a distinct durable notice keyed to the refused invocation. In the same transaction the predecessor's awaiting continuation is closed as interrupted with reason `worker interrupted by steering`. It keeps the predecessor's destination. The refusal notice uses a synthetic cause solely for persistence. Both the notice and event omit raw hook errors. The redirect fact waits for the successor's first provider update or a successful completion without updates. The folded-steer probe in `f1937fe` shows that a later hook conflict can abandon the entire provider call without publishing an earlier message's redirect fact. The existing terminal failure transaction settles the causal bindings already committed by earlier hooks in that folded call.

At restart the pool has no in-memory running assignment. A new send to that worker reserves a fresh assignment. The test confirms that a direct attempt to continue the old binding conflicts and that the first new send dispatches under its own ID. Recovery of abandoned work without committed final evidence remains O5b.

## ACP delivery and evidence

The ACP scan stages committed finals and delivers pending ACP notices. A committed result uses the repository's projected final text. A blank or absent final produces `worker_failed` with reason `worker produced no saved result`. On the target conversation the message uses `worker-result:<assignmentId>` as its record ID, and its consumer metadata carries the worker handle and item kind. Failure metadata adds the error kind and safe reason. The existing out-of-band path supplies the message to the target's next provider prompt.

The append checks the stable ID and the destination inside the append transaction. Delivery is marked only after the append returns. A retry uses the committed message without another record or publication. Missing or deleted destinations become `failed_destination`, with the saved outcome still visible through worker check and list. An unconfirmed append keeps delivery pending for a subsequent flush.

The ACP fixture verifies reservation from a read-only connection at provider receipt. Separate SIGKILL tests stop the writer after final commit and before stage, and after the out-of-band append and before the delivered transition. Direct database reads prove each boundary. Reopening twice yields one record, a delivered transition and one copy in the next provider prompt. The tool barrier tests cover continuation, redirect, replacement, actual reservation conflict and a throwing hook after continuation writes, including transaction rollback. Both refusal cases record exactly one predecessor notice and exactly one directed failure with no successor provider call. Other tests cover blank and failed results and a deleted target.

`conversation-manager.ts` fell from 1,081 to 1,013 lines by extracting the existing append implementation. `agent-session.ts` stayed at 4,564. The native host grew from 914 to 916 lines for the callback registration and its import. No live provider was used.

## Clean archive gates

All gates used `bun test ./test` with `TMPDIR` on `/dev/shm`.

| Commit | Full suite | Logs |
| --- | --- | --- |
| `1c5829a` | 1,559 tests across 145 files in 123.01 s | `/tmp/acp-o1-o3a-merge.uA4Ouc` |
| `41a225d` | 1,560 tests across 145 files in 115.77 s | `/tmp/acp-o1-o6-production-hook.wWXHWE` |
| `0e9c79b` | 1,563 tests across 145 files in 111.62 s | `/tmp/acp-o1-o6-sender-trim.1XdagP` |
| `ae54682` | 1,574 tests across 147 files in 108.75 s | `/tmp/acp-o1-o3a.IzmsHD` |
| `f1937fe` | 1,575 tests across 147 files in 108.66 s | `/tmp/acp-o1-o3a-redirect.1XxBDk` |
| `ee6026e` | 1,576 tests across 147 files in 112.49 s | `/tmp/acp-o1-o3a-sender-ownership.Vg4WtH` |

Every archive passed typecheck and all 35 snapshots. The A1 snapshot hash matched across the gates.
