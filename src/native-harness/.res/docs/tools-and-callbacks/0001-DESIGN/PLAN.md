# Tools and host callbacks implementation plan

Date: 2026-11-20.
Status: proposed for review.

## Scope and base

Implement [SPEC.md](SPEC.md) on the accepted acp-client integration revision.
Record that revision at assignment. Deliver one consumer-registered function
over the public stdio connection, with equivalent behavior in process.
Keep the same permission gate and tool-result pairing for built-in and
consumer tools. Other executor types and user-entered code stay separate.

## Code ownership

Paths are relative to the native harness package unless identified as acp-client
paths.

| Area | Code seam | Work |
| --- | --- | --- |
| Contracts and config | Existing tool, session, permission, storage, and protocol contracts in `src/contracts/` and managed config in `src/runtime/config/` | Define catalog entries, binding and availability, invocation identity, lifecycle, callback envelopes, and result references. Validate configured registrations when opening the session. |
| Tool catalog and execution | Existing `src/capabilities/tools/`, `src/governance/permissions/gate.ts`, and session assembly in `src/index.ts` | Add the shared catalog, request tool snapshots, argument validation, and callback executor binding. Extend the existing dispatch path for availability and deadlines. Core and runtime tools use the same path. |
| Kernel and model adapter | Existing `src/kernel/` and `src/capabilities/model/` | Feed the tool snapshot into inference. Preserve it across model retries. The provider adapter renders the fixed and changeable groups. The kernel coordinates the existing iteration and lifecycle without knowing callback or filesystem details. |
| Durable state | Existing `src/state/storage/` and archive contracts | Reuse the committed assistant request, dispatch evidence, and paired result. Extend those records for invocation lookup, terminal outcomes, and configured revocations. Persist references as metadata. The process serving the result owns its bytes and retention. |
| Bidirectional protocol | Existing `src/interfaces/protocol/`, live queue, framing, and public client | Add reverse requests, response correlation, cancellation, and connection cleanup within the existing frame limits. Keep callback handler execution independent from reading requests and events. |
| acp-client | Existing host and controller under acp-client's `src/native/` | Bind the consumer's functions, supply runtime selections on open, route callbacks by invocation, and store and read host-owned results. Use harness phase and outcome for native turn supervision. |

Keep the dependency direction in [ARCHITECTURE.md](../../../../ARCHITECTURE.md)
and [AGENTS.md](../../../../AGENTS.md). acp-client uses public harness
exports. The kernel depends on contracts. The callback transport delivers
calls authorized by the existing gate. Tool results use a scoped reader
through that same tool path. Reuse `session/status` for connection probes and
phase reporting.

## Implementation stages and acceptance gates

| Gate | Work | Evidence required |
| --- | --- | --- |
| **1. Contracts** | Record catalog and reconnect semantics, invocation IDs versus wire request IDs, result and event shapes, and scope and retention for result references. Define optional deadline precedence and the order of revocation, approval, and dispatch. Record contract decisions before dependent code changes. | Typecheck. Walk through reconnect with a missing handler, revocation while waiting for approval, a callback with no deadline, and a large result whose producer is on a separate filesystem. Verify each case has one owner and an observable outcome. |
| **2. Catalog and lifecycle** | Compose the catalog and a test executor behind the existing dispatch gate. Add invocation records and status phases. Preserve configured revocations in storage and archives. | Fixed registrations survive runtime removal attempts. Revocations survive reopen. Runtime tools are supplied at open. Denied tools are omitted and retries retain the same offered list. Invalid or revoked calls skip without dispatch. Recovery before dispatch evidence and recovery between that evidence and transport send report distinct outcomes. Existing built-in tool tests still pass. |
| **3. Callback and result transport** | Implement reverse requests and cancellation in both transports. Add producer-owned result storage and the scoped reader. Wire the native host and controller to callback and phase events. | Concurrent callbacks correlate to the correct requests. A quiet callback does not trigger native turn cancellation under the host's ordinary ACP silence timer. Optional deadlines and explicit cancellation close the correct call. A large result crosses the wire by reference, with no shared filesystem. Reject cross-channel reads, arbitrary paths, and expired references. |
| **4. Public checkpoint and review** | Run acp-client with a real scripted stdio child. Update architecture, usage, and published business rule locations. Run harness and host verification. | Run the scenarios below, typecheck and run the full harness suite, and run the relevant acp-client and controller conformance tests. Record the independently reviewed revision and evidence. |

## End-to-end acceptance

1. Start Alice and Bob in one session. Alice requests a host function and
   receives approval for the exact call. Hold its handler at a deterministic
   barrier. Verify Bob finishes, status reports Alice's tool and elapsed phase,
   and ordinary silence does not cancel the call. Release it and verify the
   result commits once and reaches Alice's next inference.
2. Revoke a tool while its approval is pending. Verify the old request cannot
   authorize dispatch, the call is recorded as skipped, and the next inference
   omits the tool. Reopen and verify the revocation persists.
3. Return a result larger than one stdio frame. Save it on the host, verify the
   callback succeeds with a preview and ID, and retrieve it through the
   producing channel. Test with no shared result directory. Verify the scoped
   reader rejects access from another channel, arbitrary paths, and expired IDs.
4. Lose the callback outcome after dispatch. Reopen and verify the record
   reports uncertainty and the handler does not run again. Separately time out
   a stalled callback while its turn is live and verify the next inference
   receives exactly one paired timeout result. Deliver a late reply and verify
   it cannot replace that result or start another inference. Interrupt a whole
   turn and verify a late reply starts no further work for it.

Use controlled handlers, scripted inference, and timing barriers so automated
tests need no provider key or long wall-clock waits. Cover timeout precedence,
interrupt, and suspend against the same lifecycle used by the public test.

## Handoff and closure

Use one implementer and one independent reviewer. Record the base, exact
stage revisions, evidence, and review outcomes in `LOG.md` once work starts.
Review each gate before building on it. Check that the existing gate remains
the only path to dispatch, readers cannot expand their result access, and
an unresponsive callback does not block connection handling. Record the
accepted revision, limitations, and a short retrospective at closure.
