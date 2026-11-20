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
  Validation order: a file shorter than the 14-byte header, a wrong marker,
  or an unknown version is `invalid_archive`. Next compare bytes actually
  present to exactly 14 plus the declared payload length; any mismatch is
  `invalid_archive`, including a short file declaring a huge length and any
  trailing bytes. Never allocate or read based on the declared length. Only
  after lengths match, reject files over `maxBytes` (268435456 bytes by
  default), header included, as `transfer_limit`. Only then decode one CBOR
  item and validate the logical records. Malformed CBOR or records and old
  standalone JSON files are `invalid_archive`. Path and stdio use the same
  order and whole-file limit.
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
  tests; no runtime package or native codec dependency is required. A stored
  snapshot outside this profile fails export with `serialization_error`; a
  file outside it fails import with `invalid_archive`.
- The active config is the exact validated `ProtocolConfig` value captured
  when the source session is opened: `{ version: 1, system, model: { protocol:
  "scripted", script } }`. No subsequent sidecar or script read can change the
  exported value. Unknown config fields, invalid types and empty script paths
  fail validation, including empty or whitespace-only script paths. Paths are retained verbatim, not rewritten or dereferenced by
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
  imported config: a read succeeds with an absent value. This slice does not automatically load the saved config for
  session open; callers still supply config until the configuration integration.
- Export eligibility and channel/session lifecycle rules remain those of 0014.
  Path and chunked transfer use the same codec and hash the complete file bytes.

## Compatibility and verification

SQLite `formatVersion` stays 3. Format 2 upgrades once as before and format 3
continues to open; saved config is extra storage beside the logical snapshot,
not a new schema revision. The external JSON archive encoding is intentionally no
longer accepted. Verify the CBOR profile against fixed independent vectors,
malformed inputs and the whole-file bound, plus atomicity on both adapters,
fresh-home public path and chunked stdio round trips, active config after source
file removal, destination script requirements, and suspended channel checkpoints.
