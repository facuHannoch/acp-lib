# 0029 — Bounded model-call pages

## Problem

The model-call RPC snapshots the session. The existing storage page operation
also decodes all of the model history. R5 uses the RPC on turn close, so these
reads put history-sized work on the ordinary execution path.

## Options

Using the existing page operation alone removes the snapshot but still reads
the history blob. Moving canonical writes to a new model-store schema would
expand scope and affect recovery and older writers.

## Choice

Expose the existing model-call page seam on the assembled session and use it
for the RPC. Keep the wire contract and frame handling. Read a bounded page
of complete summaries, fetching at most limit plus one rows in oldest-first
order. Resolve the exclusive cursor through a unique call-ID index. An
unknown cursor remains not_found. If the first summary cannot fit the frame,
return transfer_limit. Otherwise return the complete summaries already packed
and a continuation when the next summary cannot fit.

SQLite stores an indexed side projection of summary JSON by call order.
Backfill under the owner transaction and update it atomically with canonical
modelState writes. An older writer marks the projection dirty for the next
open, following the reply-ID projection precedent. Steady-state reads query
only the indexed projection. Memory pages the existing array and uses the
monotonic call ID ordering for cursor lookup.

## Compatibility

SQLite format 6 and archive semantics stay unchanged. The canonical blob
remains authoritative for recovery, archive and writes; the side table
adds write maintenance and storage. Legacy files open without a format
migration and older writers keep their existing table layouts.
