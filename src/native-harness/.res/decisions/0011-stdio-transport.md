# Stdio transport and connection lifecycle

Carry the existing experimental protocol as newline-delimited UTF-8 JSON. Reuse
one scripted server factory for in-process and stdio. Only protocol goes to stdout;
diagnostics go to stderr. No HTTP listeners or credentials are required.

Client transports report closure/errors, rejecting pending and future calls
immediately. The stdio transport accepts host-owned byte streams/write/end
operations and optional process-exit promise; it never launches or kills processes.
Frames are bounded at 1 MiB and queued writes at 4 MiB, with serialized async writes.
Malformed client JSON returns a parse error; malformed server output terminates
the connection. An unfinished frame at EOF is a framing failure.

EOF stops request admission, drains accepted work and writes within a five-second
deadline, then exits. Timeout is a nonzero failure, not interrupted-and-persisted
shutdown. No persistence, replay, cancellation or restart guarantees are added.

Superseded in part by [0013](0013-durable-delivery-contract.md): once persistent
stop is wired, EOF is an immediate stop that interrupts active turns, with no
drain. The current server keeps the five-second drain until then.
