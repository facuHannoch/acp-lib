# 0042 — Inline function result budget

ACP-client used to measure only the serialized function output. The harness
measures the complete success result, so it could reject an output that the
host had already decided to send inline.

Keep the managed default at 16 KiB and share the success envelope and its
UTF-8 measurement through the harness client entry point. ACP-client treats
its configured inline threshold as a ceiling up to that default. Above the
effective limit, it stores the output JSON and returns a reference. The harness
keeps its own validation for other executors and in-process limits.

Raising the default would also change how much result data is admitted without
addressing the measurement disagreement. The existing reference and paging
format still measures the stored output JSON, and the wire frame and inference
context limits are independent. No persisted format or wire fields change.
