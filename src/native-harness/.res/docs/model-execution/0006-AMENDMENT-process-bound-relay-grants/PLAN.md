# Implementation plan for process-bound relay grants

Start from an integration base that contains the trusted relay runtime
from `fb89e57` or its landed equivalent and the native provider-error
fix. Confirm the relay base by code before branching. The local
`alpha` ref at `b5c06aa` is not a descendant of `fb89e57`.
Keep service proxy egress and platform issuer changes out of this
candidate. See the [amendment](SPEC.md).

## 1. Grant shape and session ownership

- Extend `src/native-harness/src/contracts/protocol.ts` with the
  exclusive wire lifetime union. Keep the existing numeric form and
  use the existing create and open fields. Update the public exports
  and `util/inference-relay.ts` so validation rejects both lifetime
  fields, neither field, invalid numbers and unknown process modes.
- Keep `grantRef` in the ACP-client provider result type in
  `src/native/inference-relay.ts`. Construct the wire grant from the
  approved fields before handing it to the client. Test the actual
  serialized request rather than just the provider object.
- `src/native-harness/src/testing.ts` already owns the executable
  grant for each protocol session and validates it at the storage
  recovery boundary. Give that open a small in-memory grant state
  with a local identity and an invalidation operation that checks
  the captured identity. Reuse the same endpoint validation.
  Reopening starts a new state. Keep grants and their local identity
  out of durable storage, archives and checkpoint identity.

## 2. Relay refusals and retry safety

- `src/native-harness/src/capabilities/model/inference-relay.ts`
  already wraps the generic Chat Completions attempt with its own
  direct dispatcher. Check numeric expiry only for numeric grants.
  Capture the grant identity and the dispatch boundary in the relay
  attempt. Parse the bounded relay error envelope at this boundary
  using the fixed status/type pairs in the spec. Keep error-body
  diagnostics out of the generic provider path.
- For the exact revocation pair, invalidate the captured grant only
  if it is still current. Emit a fixed failure for that inference.
  Subsequent attempts with the revoked grant fail before network
  dispatch. Test a late response against replaced authority in the
  grant state, without adding a live replacement RPC.
- Inspect the retry classification in
  `capabilities/model/runner.ts`. It can currently retry a transient
  failure before model output, even when transport dispatch already
  happened. Have relay attempts signal terminal failure when the
  request may have reached the relay. Do not reuse absence of a
  stream frame as evidence of no dispatch. In particular, check
  lost responses and ambiguous 503s. Preserve the original attempt
  record and existing settlement. Leave retry rules for ordinary
  providers at the common boundary intact.

## 3. Failed-open cleanup and deadlines

- Expose the optional cleanup hook and deadline in
  `src/agent/config.ts` and `src/native/host-config.ts`, with exported
  types through the existing native API. Default to 10,000 ms.
- In `src/native/inference-relay.ts`, scope delivery state and
  cleanup to one provider result. Once it has a reference, cover
  all failure and cancellation paths after acquisition. In
  `src/native/recovery.ts`, mark possible delivery at the handoff
  immediately before the first executable client request that
  can put the grant on the transport. In particular, while the
  MCP material hook is still pending, the relay grant is
  `not_sent`. Partial writes and lost replies are `unknown`.
- Await one cleanup for each failed issuance, even across
  `openOrCreate` fallback and retry paths. Keep open cancellation
  separate from the cleanup timer. A resolved cleanup preserves
  the original failure. Timeout or rejection surfaces
  `relay_cleanup_unconfirmed` and prevents further acquisition for
  that open. Never include the reference or bearer in the outward
  error.
- Account for the outer startup deadline in `src/native/host.ts`.
  It currently races against the open promise and can return before
  work in that promise has settled. Propagate cancellation promptly,
  close failed transport as needed, and wait for the tracked issuance
  cleanup within its own budget before reporting the final failure.
  Preserve the typed unconfirmed outcome across the outer timeout and
  startup error mapping. If the provider itself is still pending,
  keep its original issuance scope for any late grant and prevent
  that grant from being sent after cancellation. Avoid waiting
  indefinitely on an unresponsive provider.

## 4. Verify and hand off

1. Extend `src/native-harness/test/inference-relay.test.ts` and
   `test/native/inference-relay.test.ts` for both lifetime forms,
   strict shape, actual stdio payloads, the fixed refusal pairs, and
   no replay after possible dispatch. Check that an already admitted
   stream settles and that a later executable open can use fresh
   authority.
2. Test cleanup at the ACP-client boundary with an observable
   transport. Cover cancellation before handoff, partial writes,
   lost replies on create and reopen, retry and fallback branches,
   and the outer host startup deadline. Verify cleanup with an
   already cancelled open signal, positive acknowledgment versus
   timeout or rejection, late provider and cleanup results,
   unreferenced grants, and no reissue on unconfirmed cleanup.
   Use canaries for the host reference and bearer across stdio,
   storage, diagnostics and archive output.
3. Run focused relay and provider-error tests, both typechecks,
   and the root and harness regression suites. Send Clad1a the
   exact candidate SHA and local fixture results. Node and Hub
   acceptance stays with the platform workstream.
