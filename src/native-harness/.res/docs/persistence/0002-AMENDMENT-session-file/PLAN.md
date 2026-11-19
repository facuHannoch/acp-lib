# Session-file amendment plan

Date: 2026-11-19.
Status: proposed for review.

## Scope and code areas

Implement the [file-format amendment](SPEC.md) on the accepted
channel-controls revision after its final gate. Record the base before work
starts and use its logical snapshot contract.

| Area | Work |
| --- | --- |
| Storage and archive contracts | Define the versioned envelope, portable config payload, and contract for storing imported config. Record a decision before dependent changes. |
| `src/state/storage/` | Add the shared binary codec next to logical archive validation. Validate and publish snapshot and config together through atomic import. Preserve the existing export eligibility and SQLite compatibility rules. |
| Session assembly | Supply the config already loaded by the session and verify its exact value after import. The configuration slice owns managed reopen from the saved value. |
| `src/interfaces/protocol/` and the typed client | Reuse bounded byte transfer and file-path operations for the new encoding. Keep the codec shared across transports. |
| Verification | Extend the existing portability and transfer tests. Use scripted stdio for the fresh-home round trip. |

## Implementation and review

1. Define the header and encoding, whole-file limit, stored-config contract,
   and referenced-resource rules, including what happens to the scripted
   model file. Record the archive contract decision.
2. Implement the codec, active-config export, and validated atomic import.
   Test both file paths and bounded stdio transfer. Exercise invalid headers
   and payloads, including files in the old standalone JSON encoding.
3. Run typecheck and the harness suite. Have an independent reviewer check the
   exact revision. Include a fresh-home round trip with the source config
   file missing. Verify export eligibility and preservation of individual
   suspension across session resume after import.

Use one implementer and at least one independent review. Record assignments,
gate evidence, and the accepted revision in `LOG.md` once implementation
starts. The configuration slice verifies managed reopen without a sidecar
when its loader is connected.
