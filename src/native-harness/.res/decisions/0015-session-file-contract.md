# Session file and imported configuration

## Problem and options

The JSON export omits the active configuration. A portable file must retain it
and publish it atomically with the snapshot. Options are a JSON wrapper, a ZIP
container, or a versioned binary envelope with CBOR. Choose the envelope in
amendment 0002. It has no ZIP, encryption, embedded credentials, or embedded
destination resources. Managed reopen remains the configuration slice's work.

## Choice

- File version 1 is `HARNSESS` (eight ASCII bytes), uint16 version 1, uint32
  payload length, both big-endian, followed by exactly one CBOR item. The
  whole file, header included, is subject to the existing transfer limit.
  Reject short headers, wrong marker, unknown version, mismatched lengths,
  trailing bytes, malformed CBOR and malformed records as `invalid_archive`;
  oversize files are `transfer_limit`. Standalone JSON files are rejected.
- The payload is a map with exactly `archive` (logical archive version 2) and
  `config` (the active portable config). Logical archive version 1 remains an
  adapter-level import compatibility feature, not a legacy session-file format.
  Validate the entire payload before publishing either record.
- CBOR supports JSON data only: null, booleans, finite IEEE-754 numbers, UTF-8
  text, arrays, and maps with unique string keys. Reject tags, byte strings,
  undefined, non-finite numbers, duplicate keys, indefinite lengths, invalid
  UTF-8, non-string keys, unsafe integers, extra CBOR items, and nesting beyond
  128 containers. Encoder emits definite lengths and interoperable standard
  CBOR; canonical map ordering is not required. Decode a bounded file in memory.
  Implement the small profile in the storage module, with independent byte-vector
  tests; no runtime package or native codec dependency is required.
- The active config is the exact validated `ProtocolConfig` value captured
  when the source session is opened: `{ version: 1, system, model: { protocol:
  "scripted", script } }`. No subsequent sidecar or script read can change the
  exported value. Unknown config fields, invalid types and empty script paths
  fail validation. Paths are retained verbatim, not rewritten or dereferenced by
  export or import. The destination must supply the referenced scripted model
  file at that path (relative paths resolve in the destination process working
  directory) with compatible content before opening/resuming; its contents are
  not carried by the file. The existing compatibility key prevents resuming a
  checkpoint with different script content or system prompt. Import validates
  config structure without requiring the resource to exist. Other future config
  schemas, credential references and host functions require a separate decision;
  credential values and host functions are destination-owned and never exported.
- Add a storage adapter operation to import the validated logical archive and
  portable config as one atomic publication, and a storage read for the imported
  config. Reads return defensive copies. Existing logical archive operations
  remain for adapter compatibility. A fresh imported SQLite session keeps the
  config in its database; memory storage keeps it with its session. Failed
  validation, occupied destinations, or failed publication leave no partial
  destination and never modify an existing one. Legacy sessions have no saved
  imported config. This slice does not automatically load the saved config for
  session open; callers still supply config until the configuration integration.
- Export eligibility and channel/session lifecycle rules remain those of 0014.
  Path and chunked transfer use the same codec and hash the complete file bytes.

## Compatibility and verification

SQLite format 2 and 3 remain openable; storing imported config must not invalidate
existing databases. The external JSON archive encoding is intentionally no
longer accepted. Verify the CBOR profile against fixed independent vectors,
malformed inputs and the whole-file bound, plus atomicity on both adapters,
fresh-home public path and chunked stdio round trips, active config after source
file removal, destination script requirements, and suspended channel checkpoints.
