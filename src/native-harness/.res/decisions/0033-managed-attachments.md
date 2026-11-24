# 0033 — Managed attachments and ordered image input

Status: proposed for A1 review; no runtime behavior is claimed by this record.
Base: 4dad65e6534401ceb28ee9f4dbb3e56c672847be. This decision narrows the
[attachment spec](../docs/attachments/0001-DESIGN/SPEC.md) to managed storage,
input images and general-file download. Consumer stores and outgoing tools are
later gates.

## Problem, options and choice

A string-only inbox loses part order and cannot prove file durability. Embedding
bytes in messages or archives without bounds would make history, retries and
provider diagnostics unsafe. Choose immutable session-owned files, ordered
reference parts and a bounded complete archive. Keep text-only input on its
existing normalization and retry identity. Separate publication from inbox
commit, serialized by the exclusive session owner. This is a contract decision;
implementation and conformance changes follow independent approval.

## Identity, parts and capabilities

1. The harness generates a cryptographically random opaque attachment ID and
   upload ID; neither is a path nor an authorization token. Metadata is immutable:
   ID, owner channel, display filename, declared media type, byte length and
   lowercase SHA-256. The filename is display-only, valid UTF-8, 1–255 bytes,
   with no control characters; it never supplies a path. Media type is a
   lower-case type/subtype without parameters, at most 127 ASCII bytes. For
   image parts, verify actual PNG, JPEG or WebP format against the declared type,
   including safe header parsing and dimensions; reject malformed or mismatched
   input. General files remain opaque and are never asserted to be safe to run.
2. `channel/push` keeps its existing item envelope. Content is a nonempty
   ordered array of `{type:"text",text}` and `{type:"attachment",id}`. Each
   attachment is ready and belongs to the sending channel. Any image media
   type is an image input; other files are references only. Text-only content
   retains the existing newline join, text validation, 8 KiB admission and
   signature, even if text part boundaries differ. For mixed inputs preserve
   exact text, part boundaries, order and IDs in the signature. A mixed input
   has at most 32 parts, at most 8 attachment references, and at most 8 KiB
   of UTF-8 text plus IDs and part tags; an attachment-only item counts as one
   item and its encoded references count toward that byte budget. No empty
   text part; repeated attachment IDs are allowed and consume the limit each
   time. Existing item ID, channel, sender, policy and delivery identity rules
   remain in force. Acceptance atomically associates every referenced ID with
   the item. Stored inbox, taken timeline entries, checkpoints, recovery and
   provider-neutral model input preserve parts; text-only legacy reads retain
   their existing string projection. New history and live projections expose
   ordered parts and metadata only; assistant text replies retain their current
   representation. Inspector, retrieval and recovery never inline file bytes.
3. Duplicate lookup and signature comparison precede lifecycle, capability,
   quota and file availability checks: an exact accepted retry returns its
   original ID, current milestone and duplicate flag even when suspended or
   reopened, including withdrawn items. A changed payload conflicts. A new
   item checks lifecycle and all references before committing; failure commits
   nothing. Lost acknowledgements are recovered by retry or tracked item read.
   No duplicate lookup may bypass the original channel/sender authorization.
4. Initialize advertises managed upload/download, ordered parts, limits and a
   separate `imageInput` capability only when the selected configured model
   path explicitly supports these image formats. Omission means unsupported.
   Scripted fixtures must explicitly opt in. A new image push against a text-only
   configuration fails `unsupported_image` before inbox acceptance. General
   files remain usable there. Do not infer vision from a model name.

## Transfer, ownership and durability

5. The authenticated owning host acts on behalf of a specified channel on
   every operation. Upload, finalize and new attachment use require that owner
   channel. Before a durable timeline-visible association exists, only the
   owning channel may download or render the ready file, even if another
   channel knows its ID. Acceptance alone creates a retained association but
   a pending item is not yet timeline-visible. Once an associated item is
   taken into the shared timeline, any channel authorized to read that timeline
   may download or render it. Withdrawal of a pending item never grants shared
   access; the owner retains access, and a separate visible association can
   grant shared access. Taken associations remain visible for the session
   lifetime. Apply this same predicate to metadata and bytes on every surface.
   The current v1 session timeline is shared, not private per channel. An
   unknown ID or a reference outside that session's
   permitted scope returns `not_found`; never authorize from an ID alone.
   Web chat and stdio use the same owner and admission operations. Access to
   the host connection is the existing trust boundary; this adds no user login.
6. `attachment/begin {channel,filename,mediaType,bytes,sha256}` returns
   `{uploadId,attachmentId,offset:0}`. Size is 1–20 MiB; digest is 64 lowercase
   hex. At most four open uploads per session, with a 60-second idle expiry.
   `attachment/write {channel,uploadId,offset,data}` takes canonical base64
   of 1–512 KiB decoded bytes at the exact current offset; it returns the next
   offset. Wrong offsets or overlapping writes fail `offset_mismatch` and return
   the expected offset without mutation; a lost write acknowledgement is
   resolved by `attachment/status {channel,uploadId}`. Status and writes are
   scoped to the originating channel. Staging is ephemeral across process
   death; expired or unknown upload IDs return `not_found`, requiring a new
   begin. `attachment/finalize {channel,uploadId}` verifies exact length,
   SHA-256 and image constraints and returns immutable ready metadata. Repeated
   finalize for a live completed upload returns the same ID and metadata;
   after reopen use the returned attachment ID or start a new upload. Invalid
   content never becomes ready. `attachment/abort` is idempotent for an owned
   active upload; it cannot delete a ready attachment.
7. For a managed session use its directory's `media/`; explicit `--db PATH`
   uses sibling `PATH.media/`; memory-backed development uses an isolated
   temporary root removed when its owner closes, and promises no reopen.
   Staging and publication use generated names under that root, exclusive
   creation and no symlink following. Flush completed bytes, atomically rename
   within the filesystem, then flush the parent directory before the SQLite
   ready metadata transaction. Failure before ready commits is not success.
   After a crash, remove abandoned staging files and published files lacking
   metadata during owner recovery; ready but unreferenced metadata and files
   can be reclaimed after 24 hours, using a durable ready timestamp. Serialize
   finalize, acceptance and cleanup under the session owner: cleanup removes
   only an unreferenced ready record and its bytes, fenced against admission.
   Once an item is accepted its files remain for the session lifetime, even
   after withdrawal or completion. Missing committed bytes leave metadata and
   references intact and yield `attachment_unavailable`, never silent success.
8. `attachment/read {channel,id,offset}` returns metadata, base64 data of at
   most 512 KiB and nextOffset when more remains; offset is a nonnegative safe
   integer at most the recorded length. Reads are bounded and do not expose
   paths. Missing/corrupt bytes report `attachment_unavailable`; malformed
   requests `invalid_params`, mismatched digest or length `invalid_attachment`,
   and quota violations `transfer_limit`. All errors preserve committed state.

## Vision and archive

9. At admission enforce at most 8 images, 20 MiB each, 40 MiB total per input,
   dimensions at most 8192 per side and 20 million pixels per image. A turn's
   active images are all image references in items taken by that turn. Keep
   them selected, in their original message and part positions, for every
   inference in that turn, including after tool results and after checkpoint,
   reopen and resume. Reconstruct selection from durable taken-item/turn links;
   never persist image bytes in a checkpoint. On turn completion, failure or
   interruption, its images become ordinary historical metadata references in
   later turns. Preserve ordered text and image positions in the neutral request.
   General files and old images are represented as metadata references, not bytes.
   A provider adapter resolves selected images only at the final boundary,
   validates each again and enforces the 40 MiB aggregate bound across all
   active references of the turn. Count each occurrence, including duplicates.
   Unsupported configuration, missing/corrupt bytes or an
   exceeded inference budget fails the turn with a typed error identifying
   every unavailable reference; do not silently omit it or send a partial
   provider request. Intake takes the longest FIFO prefix that fits both the
   existing intake limits and the remaining active-image budget; it must not
   skip an earlier item. When the next pending item does not fit because of
   images already active in this turn, leave it pending, allow the current turn
   to finish despite that pending item, and schedule a new turn for it. This
   budget-specific completion rule must be durable and work after resume; it
   does not change normal finish behavior for other pending inputs. Once that
   turn completes, its active budget is released and the scheduler starts a
   fresh turn for the still-pending FIFO head, subject to existing lifecycle
   controls. Failure or interruption also releases that budget and leaves
   untaken items pending for the next eligible turn; taken items retain their
   existing terminal and receipt semantics. A single item exceeding the budget
   is rejected before acceptance with `transfer_limit`, without reserving a
   place in the queue. Images use
   provider-native parts in order. Binary and
   encoded image data are excluded from persisted model calls, captures,
   diagnostics, ordinary inspector frames and logs; only IDs and metadata
   may be recorded. Never persist the provider request with inline data.
10. Routines owns SQLite format 8 and logical archive 7. Reserve format 9 and
    archive 8 for attachments, subject to coordination; do not reuse their
    versions. First durable ready metadata activates format 9 atomically with
    its transaction; older formats follow their supported migrations. Formats
    6–8 with no attachment state retain their existing version and archive
    behavior. Older binaries must reject format 9. An attachment archive 8
    includes all retained referenced metadata, associations and exact bytes,
    including references retained for withdrawn items, plus all routines state.
    It excludes stages and finalized unreferenced files; these omitted files
    and their IDs are unavailable in the restored session. If a format-9
    session has no retained associations, including one with only unreferenced
    ready files or after cleanup, export a detached snapshot projected to the
    correct pre-attachment format and archive version determined by its
    remaining durable state (format 8/archive 7 if routines or guard state
    requires it; otherwise the selection defined by decision 0031). Preserve all routines
    rows, receipts and revisions. Never label format 9 as an older format in
    place or mutate the live database for export. Import the projected snapshot
    as that prior format without fabricating attachment state. Older archives
    remain supported.
11. Keep the existing session-file envelope and 256 MiB encoded transfer cap.
    Represent bytes as bounded CBOR byte strings, not base64. Before encoding,
    preflight the full size including metadata and envelope; refuse missing,
    corrupt or oversized retained files explicitly, without partial export.
    The current codec is buffered: cap total encoded input at 256 MiB and peak
    archive working memory at 3 times that cap; fail before allocation above the
    bound. Transfer chunks remain bounded. Import validates the entire envelope,
    archive, references, lengths, digests and aggregate cap into a private fresh
    staging destination, flushes files and database, then atomically publishes
    the destination as a unit; failure or interruption leaves no visible partial
    session. Refuse an occupied destination. Explicit `--db` import must use a
    recoverable publication marker so reopen either completes a validated
    publication or removes unpublished staging, never exposes a partial session.

## Compatibility and verification

Verify the existing text-only signature and old archives unchanged. Add shared
storage and protocol conformance for retries, suspension, ownership, quotas,
ordered projections and crash boundaries; real stdio tests must exercise a
multi-frame image, text–image–text, attachment-only, duplicate/conflict,
provider request order and download after reopen. Exercise web general-file
upload/download, unsupported image, missing files, races, export/import,
limits, old archives and absence of bytes in diagnostic surfaces. Run both
package typechecks and full suites and extend the cumulative stdio rehearsal.
Exercise image → tool → second inference and checkpoint/reopen/resume with
the same image in each provider request; cover FIFO budget deferral to a new
turn. Test cross-channel access before acceptance, pending acceptance, after
take and after withdrawal, plus wrong-session reads and rendering. Round-trip
format-9 sessions with only unreferenced uploads and after cleanup, including
routines state; omitted uploads must not be readable in the restored session.
At runtime integration, record the actual final R-H4 candidate SHA and exact
migration base agreed with Cod1a. Against that exact candidate, create and
reopen a format-8 session with routines and guard state, activate attachment
format 9, and verify every existing row, receipt, revision and guard survives
migration and reopen. Import its archive 7 into a fresh destination, activate
format 9, and round-trip archive 8 with retained attachments while preserving
the same state and bytes. Separately export a format-9 session with routines
and guard state but no retained attachment associations as archive 7; import
it fresh and verify all routines and guard state, no attachment fields or bytes,
and no access to omitted ready uploads. Cover both before and after cleanup.
Also test attachment-free format-9 sessions without routines or guard state:
their detached exports and fresh imports use the legacy archive selection of
decision 0031, preserving reminder state where present, with no attachment
fields or bytes. Verify supported older archives still import. Reconcile shared
storage, archive and protocol changes without changing the assigned versions.
Integration target is `aiagent/haurness-l` after independent review.
