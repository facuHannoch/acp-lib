# Attachments and image input

Date: 2026-11-22

Status: Proposed for v1. Managed attachments and image input are the first
increment. The consumer-managed adapter follows on the same contract.

## Ownership and scope

Use one attachment model for images and general files. The harness owns the
attachment identity, channel attribution, and association with a message.
The configured store owns the bytes. Select the store for the session at
open and keep the selection across reopen.

- By default, the harness keeps files under `media/<attachment-id>` in the
  managed session directory. SQLite stores attachment ID, session and channel
  ownership, original filename, media type, byte length, and SHA-256 digest.
  The filename is display metadata. References identify immutable bytes.
- A consumer-managed session can use a store supplied by its host. acp-client
  can adapt its existing media store through a public harness contract. The
  host retains and serves the bytes across reconnect and restart. It registers
  an opaque store reference linked to the harness-owned attachment ID. The
  harness continues to work standalone with its default store.

Message parts in the inbox and timeline carry attachment IDs and preserve
their order alongside text. History, live events, and the inspector expose
references and metadata. Clients retrieve bytes separately when opening a file.

## Prepare and send

1. **Prepare the bytes.** Stage managed uploads in the session directory. Use
   bounded transfers over stdio, borrowing the existing session-file transfer
   mechanics for chunks, offsets, and digests. The standalone web server uses
   the same attachment admission and finalization rules. Apply size and type
   limits before making an attachment available.
2. **Finalize.** Verify the declared length and digest and make the managed
   file durable before recording it as ready. In consumer-managed mode the
   host makes the copy durable before registering it. Registration is an
   operation on the trusted host connection. The reference identifies bytes
   the host has already committed and agreed to retain.
3. **Send.** `channel/push` can carry ordered text and attachment-reference
   parts, including an attachment-only message. Verify that each attachment
   is ready and may be used by the sending channel. Commit its association
   with the input as part of durable inbox acceptance before acknowledging
   the message. Include the ordered parts in retry identity so the same input
   ID can reuse its attachment IDs and a changed payload reports a conflict.

An interrupted upload or unreferenced finalized file can be reclaimed. Cleanup
must coordinate with message acceptance so it cannot remove a referenced
attachment. Always retain accepted attachment bytes, including after the turn
settles. The first version has one retention behavior for accepted attachments.

## Read and present attachments

Resolve an attachment by ID through the configured store using the requesting
channel and the attachment's recorded ownership. Use the same visibility
boundary planned for [timeline retrieval](../../timeline-retrieval/0001-DESIGN/SPEC.md)
when applying conversation access policy. An ID identifies an attachment.
Authorization comes from the request's channel or trusted consumer scope.

Download retrieves bounded chunks. A missing file or disconnected consumer
store yields an explicit unavailable outcome while the message and metadata
remain readable. Verify size and digest when ingesting and when checking
integrity for relocation. Ordinary history paging does not load the bytes.

Image input is the first model-facing path. The context builder selects which
image references an inference needs and the provider adapter resolves those
bytes for an image-capable model. Advertise image input only when the configured
model path supports it. Give an explicit error for an unsupported image input.
Keep older images as references in shared history. Selection of older images
for reinjection belongs to bounded context. Keep image bytes out of persisted
provider diagnostics and ordinary history reads.

General files are first-class attachments. They use the same upload, storage,
and download path. Making a file available to a shell runner requires an
authorized handoff, including when it runs on a separate filesystem. The
[attachment tools](../../tools-and-callbacks/0003-DESIGN-attachment-tools/SPEC.md)
define that handoff. Document parsing and image generation are separate features.

## Reopen, relocation, and outbound sharing

Reopen preserves the attachment IDs and message associations. A
consumer-managed session supplies the same store on reopen to resolve its
references. A complete `.harness` export packages retained bytes from either
store alongside the timeline. Fail explicitly if a retained file is unavailable
or the export exceeds its configured limit. Import validates and restores the
files before making the imported session available. A metadata-only export
would be a separate mode.

The outbound increment uses `share_attachment` to publish a runner file or
an existing attachment through the normal channel event path. The harness owns
the outgoing message and the selected store owns the bytes.

## Acceptance

1. Upload an image larger than one stdio frame, finalize it, and send it with
   text. Verify ordered parts, stable IDs, idempotent retry, and history reads
   that return metadata without loading bytes.
2. Interrupt an upload and a publish attempt between file finalization and
   message commit. Verify orphan cleanup and that reopening preserves the
   bytes for every acknowledged message.
3. Exercise image input through the standalone web chat with fake vision
   inference. Verify a text-only model rejects image input explicitly. Upload
   and download a general file through the same attachment contract.
4. Export and import a managed session into a fresh home. Verify the metadata
   and bytes, explicit failure for missing bytes or an oversized export, and
   access checks on downloads by ID.
5. For the consumer-managed increment, run the attachment contract through
   acp-client's store. Verify reopen and export, the explicit unavailable
   outcome when the host cannot resolve a file, and one harness-owned message
   for each accepted input.
