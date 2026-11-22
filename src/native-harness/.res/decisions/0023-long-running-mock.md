# 0023 Long-running mock scenarios

## Problem and options

Short fixtures use several JSON wrappers and long rehearsals need schedules.
Separate file formats or a file-driven command language would split validation
and duplicate lifecycle behavior. Use one JSONL script and keep barriers and
control commands in the consumer's test code.

## Record and attempt contract

Use UTF-8 JSONL without BOM. Accept LF or CRLF and an optional final newline.
Reject blank records, duplicate keys (including nested duplicates), unknown
fields, invalid UTF-8, unsupported versions and invalid types. Diagnostics
identify the file and one-based line. The first record is exactly
`{type:"scenario",version:1,name}`. IDs, names and failure messages are nonblank
strings. Require at least one model record. Sends have nonblank text and
globally unique input IDs. Delays and offsets are nonnegative safe integer
milliseconds. Usage counts obey decision 0019. Calls take nonblank IDs and
names and an arguments object, with unique IDs within the attempt.

A model has exactly one terminal form: `content` with optional `calls`,
`failure:{kind,message}` using existing neutral failure kinds, or
`wait:"cancel"`. Optional `delayMs`, `usage` and ordered
`chunks:[{afterMs,text}]` apply to all forms. After the initial delay emit
accepted and any usage, then nonempty chunks at relative delays. On success
their concatenation must equal content. A failure follows its chunks. A wait
has no terminal until the runner cancels it. Delays and waits honor abort.
Success without chunks emits only the complete response. A response with calls
uses tool_calls; all others use complete. Calls use ordinary dispatch.
Selection is the exact channel sequence if one exists, otherwise the default
sequence. Exhaustion is a nonretryable neutral provider failure identified as script_exhausted. Each durable
attempt reserves its channel's next index. A retry and an abandoned reservation
each consume one record. Request capture is opt-in. A lightweight attempt
observer reports channel, reservation, and frozen taken input IDs independently
of capture. The runner supplies the frozen IDs as local request metadata. Neither observation nor scheduling can select a response.

## Identity and compatibility

The model digest is lowercase SHA-256 of canonical JSON of the default
sequence and sorted channel/sequence pairs. Keep per-sequence order and call
order, sort object keys recursively, omit discriminator and channel fields
inside sequences, and normalize omitted delays, chunks and calls to zero or
empty. Exclude the header name, send records and formatting. The separate
file digest hashes the original bytes. Parse and validate once per open.

Persist the digest in the existing session compatibility key
`scripted-jsonl-v1:<digest>:<sha256 of JSON.stringify(system)>`. Pass
`requiredScriptDigest` for scripted owners. Both adapters compare the digest
against the stored key while holding ownership, before recovery or writes.
A missing digest or mismatch returns incompatible, including after crashes
with pending inputs and no checkpoint. A matching digest with a changed
system leaves existing checkpoint compatibility checks in force. The format
versions and archives remain unchanged. Existing scripted sessions without a
digest require fresh sessions. OpenRouter and other storage callers keep
their existing behavior. The previous on-disk JSON wrapper is unsupported.

## Completion

The driver issues sends by monotonic offset with ties in file order. It keeps
its action position in memory across child replacements. Resolve accepted
inputs by ID to terminal turns and retain their grouping. Then require no
unexpected running, pending or checkpointed work on any channel, including
notice targets. Idle alone is insufficient. Use session/status plus targeted
reconcile and bounded history. Capture the settled status revision, page
delivery within the expected channel windows, and verify the same revision
and settled state again. If they changed, discard that comparison and retry
within the deadline. No additional public wire method is needed. On deadline
report blockers before bounded child cleanup. Report unused model records
separately. Compare expected committed assistant IDs against consumer records.
