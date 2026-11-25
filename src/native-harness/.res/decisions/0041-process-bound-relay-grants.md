# 0041 · Process-bound inference relay grants

Native executable create and open carry a runtime-only relay grant. Require
exactly one lifetime. A legacy numeric expiry keeps its validation and dispatch
checks. A process lifetime is exactly `{ mode: "process" }` and has no clock
expiry. Each executable open starts a new in-memory authority. Nothing about
the grant enters checkpoint identity, portable config or the archive.

Capture the local grant and its attempt before the relay call. Set the
possible-dispatch flag immediately before initiating the request, with no
intervening await. Do not retry a failure after that point, including a
synchronous transport throw or a lost response. Match only the documented
status and type pairs on the relay route. Read at most 16 KiB for at most one
second, within the model deadline. Never report remote text. The exact
`401 + native_grant_revoked` pair fails the inference with
`Inference relay refused: native_grant_revoked` and revokes the captured
authority only if still current. No automatic reopen follows revocation.
Further dispatches under that authority fail locally.

An optional host reference is a nonblank string of at most 256 UTF-8 bytes
without control characters. Construct the wire grant explicitly and retain
the reference only in the host's issuance scope. Mark possible handoff before
the executable RPC. Cleanup of referenced, failed or cancelled issuance uses
`not_sent` before that boundary and `unknown` thereafter. A late provider
result after cancellation gets one `not_sent` cleanup and cannot be sent.

The outer startup timeout waits for the host issuance fence. Bound a stalled
provider wait by the configured cleanup budget. If cleanup starts within
that wait, the callback keeps its own independent deadline. The default is
10,000 ms. A rejection or unconfirmed deadline produces
`relay_cleanup_unconfirmed`, fences all later acquisitions on the same host
object and its native process, including manual calls and grant-bearing
reopen. A late acknowledgement never clears it. Other processes and hosts
remain independent. The Hub automatically closes the fenced execution.
Verified process exit revokes its grants under the Node contract, and the
Hub can then start a new process and SDK host. If the process cannot be
ended, report a stuck agent and keep it fenced. No Hub or Node changes
are part of this ACP-client amendment.

See the [contract and verification plan](../docs/model-execution/0006-AMENDMENT-process-bound-relay-grants/SPEC.md).
