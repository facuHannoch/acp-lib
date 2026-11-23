# Attachment tools

Date: 2026-11-22

Status: Proposed for v1.

Build on [attachments](../../attachments/0001-DESIGN/SPEC.md), the
[shell runner](../../shell-execution/0001-DESIGN/SPEC.md), and the existing
[tool lifecycle and permission gate](../0001-DESIGN/SPEC.md). Both tools use
the same contract with managed files and a consumer-managed attachment store.

## `copy_attachment`

`copy_attachment({ id, destination? })` checks read access using the calling
channel and streams the attachment into the same runner environment used by
`shell`. Return the actual runner path once the copy is complete and verified.
Remove incomplete copies on failure or cancellation.

The default destination is under `/tmp/.harness/<session-id>/<channel-id>/`
in the runner. Use safe path components and keep same-name attachments distinct.
Later commands and turns can reuse the copy while the runner retains it. A
workspace copy requires an explicit destination within the permitted filesystem.
Refuse an existing destination unless it already holds the same verified copy.
The original remains in the attachment store independently of the runner copy.

## `share_attachment`

`share_attachment({ source, filename?, caption? })` publishes a downloadable
attachment to the current channel. `source` is either `{ path }` in the shell
runner or `{ id }` for an existing attachment.

- For `{ path }`, check access and stream the file from the runner to the
  attachment store. The retained copy remains downloadable after runner cleanup.
- For `{ id }`, check that the caller may share it into the current channel.
  Reuse the bytes and add the new message association.

The optional `filename` controls the displayed name. Once the attachment is
durable, the harness commits the outgoing message with the attachment and
optional caption, then emits the normal channel event. Return the message ID
and attachment ID. Repeating a committed invocation returns the same message
ID. History can recover a missed event. A consumer-managed store can use a
callback to transfer or resolve bytes. The harness owns publication.

## Runner lifecycle and acceptance

The runner owns staging and temporary cleanup. Use bounded streaming and reuse
tool cancellation and deadlines. Coordinate cleanup with active commands and
define retention and runner-replacement behavior in the implementation plan.
File previews and a separate `read_file` tool are follow-up work.

1. Copy a CSV into the default temporary directory, reuse it in two shell calls,
   and share an output. Verify the shared file survives runner cleanup.
2. Exercise an explicit workspace destination and transfer between separate
   filesystems. Verify channel isolation, same-name files, destination collisions,
   and incomplete transfer cleanup.
3. Share a runner file and an existing attachment. Verify access checks, one
   durable message per invocation, and recovery of a missed event. Exercise
   the same publication path with the consumer-managed adapter when available.
