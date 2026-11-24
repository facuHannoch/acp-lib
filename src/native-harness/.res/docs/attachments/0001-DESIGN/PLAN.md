# Managed attachment and image input plan

Status: Design review complete. Contract review is the first implementation gate.

The first slice delivers managed uploads, ordered message parts, image input,
and file download after reopen. It can proceed alongside routines. Base it on
the current `aiagent/haurness-l`, then verify compatibility with the routines
candidate before integration. [Attachments spec](SPEC.md)

## Findings from the design review

1. **Ordered parts need an end-to-end contract.** The current stdio push parser
   accepts text parts and joins them. Model user messages carry a string.
   Preserve legacy text-only input and its existing retry identity. Specify
   the representation for ordered text and attachment references in accepted
   items, timeline, recovery, and provider-neutral requests before implementing
   either transport or rendering.
2. **The SQLite commit and file publication need a defined failure boundary.**
   Ready metadata must follow durable bytes. Specify recovery for a published
   file with no metadata, a ready but unreferenced file, and a lost acceptance
   receipt. Finalize, push and cleanup must coordinate under the session owner.
   A cleanup race must never remove bytes for acknowledged input.
3. **Authorization is ambiguous across surfaces.** The spec refers to both
   channel ownership and shared timeline visibility. Freeze which channel may
   attach, download, or render a reference and how the owning host acts on
   behalf of a channel. Align web chat, stdio, and model rendering. Keep v1's
   shared timeline behavior explicit and avoid promising channel privacy.
4. **Vision needs its own capability and byte budget.** Format support, verified
   image type, size and decode bounds, multiple images, per-inference budget,
   context selection, and missing bytes need typed behavior. Establish the
   text-only failure boundary before inbox acceptance. Keep bytes out of
   history, captures, exports of diagnostics, and ordinary inspector frames.
5. **Archive layout and transfer limits need coordination.** Existing
   session-file transfers chunk the envelope for stdio, while the envelope
   codec takes a bounded byte buffer. Decide how retained file bytes fit the
   export cap and memory budget before choosing an archive layout. Coordinate
   SQLite and archive versions with reminders and routines. Preserve older
   imports and define compatibility for attachment-free sessions.

## A1 · Contract and independent review

- Pin identity, ordered input and reply projections, negotiated capabilities,
  ownership checks, limits, typed errors, upload offsets, retry and finalize,
  and bounded downloads. Specify how an attachment-only input counts toward
  admission limits and how a duplicate accepted push is recognized during
  suspension or after reopen.
- Define the managed file root for a managed session, explicit `--db`, and
  memory-backed development. Specify durable publication and cleanup, generated
  filenames, validated metadata, export completeness and atomic fresh import.
- Pin vision projection and provider selection. Choose the active input
  images and report individual unavailable references explicitly. Represent
  old images by references in ordinary history.
- Submit a numbered decision before dependent runtime changes. Recommended
  assignment is cod3a to draft and implement, cod3b to review exact revisions.
  Coordinate version allocation and shared protocol/storage edits with cod1a.

## A2 · Managed input implementation

| Area | Expected modules |
| --- | --- |
| Contracts and admission | `src/contracts/`, storage admission in `src/state/storage/engine.ts`, and protocol server/client. Keep the legacy text path compatible. |
| Managed bytes and archive | `src/state/storage/` for metadata and archive integration. Keep byte staging and cleanup in the owning attachment module. Reuse bounded transfer mechanics from `src/interfaces/protocol/transfers.ts` where their lifecycle fits. |
| Context and model | `src/capabilities/context/` and `src/capabilities/model/openrouter.ts`. Resolve selected image bytes at the provider boundary. |
| Frontends | `src/interfaces/web-chat/`, protocol history and inspector projections. Use the same upload finalization and input admission path on both transports. |

Gate A2 with the following cases:

1. Over real stdio, upload an image larger than one frame, then push
   text–image–text and an attachment-only input. Assert the actual provider
   request contains the image in order. Verify duplicate acceptance, changed
   payload conflict, stable IDs, and metadata-only reads.
2. Exercise interrupted and overlapping upload, cleanup and push, invalid
   length or digest, and process death before and after ready and input commits.
   Reopen and verify acknowledged files remain downloadable.
3. Reject unsupported image input on a text-only configuration. Test missing
   bytes, wrong scope, file and request budgets, and no image bytes in ordinary
   history or captured diagnostics. Upload and download a general file through
   standalone chat.
4. Round-trip an attachment-bearing session into a fresh destination and
   verify bytes and references. Exercise missing and oversized export,
   interrupted import, and older archives. Run both typechecks and full suites.

Extend the cumulative real-stdio rehearsal with this phase. Drive upload
and download from its host-side setup and assert the real model request at
the fixture provider boundary. Keep script records text-only where they
only drive model decisions. Preserve the earlier phases and exact consumption.

## A3 · acp-client integration and attachment tools

Ground the consumer-managed adapter against acp-client's existing
`src/media/store.ts` and native controller preflight. Review capability
forwarding, durable retain and resolve behavior, and export when the host
store is unavailable. Keep harness imports independent of acp-client.
Verify a real acp-client send and download over stdio once its adapter lands.

Schedule runner-backed `copy_attachment` and path-based `share_attachment`
after the foreground shell runner provides a bounded transfer seam. Freeze
path and collision semantics, retention, and atomic outgoing publication
with the tool result before implementing that slice. [Attachment tools spec](../../tools-and-callbacks/0003-DESIGN-attachment-tools/SPEC.md)
