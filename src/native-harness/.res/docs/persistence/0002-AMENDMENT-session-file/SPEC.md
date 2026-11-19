# Session-file format amendment

Date: 2026-11-19.
Status: TODO, design for review.

Amends the export/import encoding and configuration payload in the
[persistence baseline](../../11-16-persistence/SPEC.md). The existing rules
for consistent export, atomic import into a fresh destination, bounded transfer,
and explicit resume still apply.

## File format

Export one library-owned binary file with the `.harness` extension. The library
encodes and decodes it directly. The proposed first format is a fixed header
followed by one CBOR payload:

```text
[HARNSESS: 8 bytes][format version: 2 bytes][payload length: 4 bytes][payload]
```

The version and length are unsigned integers in big-endian order. The session
file version is independent of the SQLite schema and snapshot schema. The
contract review confirms the version number, supported payload types, and
encoder and decoder. The format uses no ZIP layer or encryption.

Apply the existing transfer size limit to the whole file, including the
header, for both file paths and stdio. The decoder checks the marker, version,
and exact payload length before decoding. Reject truncated headers, length
mismatches, trailing bytes, and malformed payloads. This slice can decode the
complete bounded file in memory.

The binary envelope replaces the experimental standalone JSON `.harness`
encoding. Reject files in that old encoding. Reuse the logical snapshot
contract and validation from channel controls inside the new envelope. Existing
SQLite compatibility is governed by channel controls.

## Payload and config

Carry the logical session snapshot, including timeline, turns, pending work,
deduplication records, ID allocation, and any checkpoints. Use the snapshot
contract of the implementation base, including its channel-control state.

Carry the portable, validated config that the source server is using. Export
reads that active config even if its source `config.json` was edited or removed
after open. Validate both snapshot and config, then save them together as part
of the existing atomic import into a fresh destination. Reject an occupied
destination and leave it intact.

This amendment proves that the active config survives export and import. The
[configuration design](../../11-19-config-permissions/SPEC.md) owns loading the
saved copy for managed reopen without a sidecar or inline config.

Credential values and host functions come from the destination environment.
During contract review, identify which other config references are portable
data and which require a destination resource. Include a scripted model file
in that decision so a test can demonstrate what a fresh destination needs.

## Export eligibility

Keep the channel-controls rule. When the session is running, export requires
no running or checkpointed turns, no channels currently suspending, and no
pending input. A fully suspended session can export its checkpoints and
pending work. A session can report idle while an individually suspended
channel still holds work. Suspend the session before exporting in that case.

## Acceptance

- Export and import through the public API into a fresh home. Preserve the
  snapshot and exact active config, including when the source config file is
  gone. Verify failed validation of either record leaves no partial import.
- Individually suspend one channel with a checkpoint and pending input.
  Verify export is refused while the session is running, then suspend the
  session and round-trip it. On import, session resume leaves the channel
  suspended. Channel resume continues the checkpoint without replaying a
  completed tool call.
- Transfer a file larger than one stdio frame and verify path and stdio
  imports decode the same format.
- Reject old standalone JSON exports, truncated headers, length mismatches,
  trailing bytes, malformed payloads, unsupported versions, and files over
  the size limit. Verify an existing destination stays intact on failure.

The amendment can verify the config payload against the scripted server's
existing loaded config. Managed reopen from the saved config is an integration
gate for the configuration design.
