# Model catalog and live selection implementation plan

Status: Proposed. Contract review comes first.

Implement a typed catalog passed in existing create/open arguments, followed by
live Agent defaults and channel overrides. Prove that two channels can use
different providers concurrently and switch independently while the same
session stays open. [Model selection spec](SPEC.md)

## S1 · Freeze the contract

- Base the runtime on a reviewed revision that contains decision 0034's
  OpenAI-compatible adapter and A1's attachment admission. Check current
  integration refs at dispatch. Coordinate shared config, context and storage
  edits with web tools and MCP. Assign storage and archive versions after
  checking active allocations.
- Define the named providers, named model entries, required catalog default,
  stable selection IDs, and legacy single-model normalization. Pass the catalog
  in the existing managed configuration argument. Preserve current single-model
  and scripted callers and the standalone config loader. Select the portable
  shape independently of request credentials.
- Define typed operations to read the catalog and effective selection, update
  Agent state, and write a nullable channel model. Resolve it as
  `channel.model ?? agent.model`. In a patch, omission preserves the field.
  Pin ownership, idempotency, revision and ordering against turn start. Exposing options on the channel
  means the caller can read the Agent's catalog and see that channel's
  effective model and options.
- Define supported values for reasoning effort, temperature and maximum output
  tokens. Pin both adapters' wire translation and omission behavior. The
  capability matrix must distinguish an unsupported option from a supported
  option with the provider default. Treat text-only support for the initial
  0034 adapter as authoritative until a vision contract adds support. Define
  the context window and output cap independently. Pin input budgeting,
  the reserve when no output cap is sent, and provider-specific counting.
- Pin fallback and recovery semantics. For removed selections use the catalog
  default through Agent inheritance. For surviving selections with stale
  option overrides, specify how a replacement catalog reports invalid settings
  and resolves defaults. Keep incompatible checkpoints inspectable. Specify how
  an operator clears a blocked checkpoint using existing lifecycle controls.
- Define the image guard for live changes and reopen. Selection writes and
  inbox admission must agree on the effective model. Accepted images that
  cannot run under a forced fallback stay queued. Pin how steering with an
  image is handled when the active turn uses a different pinned capability.
  Check actual provider support before accepting new image input.
- Record exact public shapes, storage compatibility, fallback, and checkpoint
  behavior as a numbered decision before runtime edits.

## S2 · Catalog and provider execution

| Area | Proposed module ownership |
| --- | --- |
| Types and validation | Add a focused provider-neutral catalog contract under `src/contracts/`. Extend `config-permissions.ts` and `src/util/config.ts` for strict validation and legacy normalization. Resolve credentials through the existing runtime config boundary. |
| Catalog resolution | Add a small resolver in `src/capabilities/model/` for resolving provider/model identity, inherited settings, and capabilities. Return a detached nonsecret execution binding. |
| Wire request | Keep wire-field translation in the OpenRouter and OpenAI-compatible model adapter paths. Keep connection fields and credentials outside model-controlled arguments. Reuse existing request assembly and model attempt recording. |
| Assembly | `src/index.ts` already configures the model through `configureTurn`. Make the executable entry points and scripted fixtures choose the adapter from the turn binding. Keep provider-specific branching outside the kernel. |

Use fixture providers to assert endpoint, upstream model ID and exact request
fields. Check option omission, zero values, unsupported settings, credential
resolution, and a missing runtime credential. Keep model credentials and
provider-specific continuation data out of other providers' requests. Preserve
OpenRouter vision and its security and redaction behavior, and the existing
OpenAI-compatible text-only path. Keep legacy fingerprints stable.

## S3 · Durable live selection and turn binding

- In the memory and SQLite adapters under `src/state/storage/`, save the
  catalog through the existing managed config path. Store Agent default and
  optional per-channel selections as separate live state. Preserve a user's
  selection when the host resends the same managed config. Apply catalog
  replacement and fallback consistently with recovery.
- Extend `SessionStorage` and its engine to resolve and commit the binding
  with `beginTurn`. At present the engine copies the session owner's
  compatibility key into each turn. For catalog sessions split that binding
  into per-turn model identity and existing non-model compatibility checks.
  Use the stored turn binding for retries, tool follow-ups and
  `resumeChannel`, including after an Agent or channel selection changes.
  Write the actual provider and model identity to model-call evidence, with
  legacy absence handled explicitly. Coordinate with the accounting amendment.
- Implement the live selection mutation under the session owner's transaction.
  Check affected channels' accepted queued inputs before updating the default
  or channel selection. Resolve reopen holds before taking inputs and keep
  unaffected channels runnable. Verify the hold clears with a compatible
  selection or withdrawal. Use bounded channel reads or a maintained summary
  to find pending image inputs.
- Define lazy activation and archive compatibility around the first persisted
  catalog selection or turn binding, as required by the contract. Keep older
  imports and image, reminder and web-tool archive behavior intact. Test exact
  integrated runtime fixtures instead of inferring migration parity.

Verify memory and SQLite parity, inheritance, reopen, catalog fallback,
legacy archives, pinned checkpoints, and selection racing turn start and
image admission. Verify that a suspended turn can resume on its original
model while another channel runs a new model. Exercise export/import and
credential-free persisted state.

## S4 · Public SDK, consumers and acceptance

- Add SDK and protocol support in `src/interfaces/client.ts` and
  `src/interfaces/protocol/`, with public types re-exported through
  `src/client.ts`. Keep reads focused. A picker should be able to list the
  catalog, determine the effective model and inherited state, and show only
  controls that apply to it. Return the committed effective state on a write.
- Connect native acp-client through its public harness SDK. Integrate the
  standalone selector using the same operations. A live change should reach
  the already running session. Preserve the existing restart path for catalog
  replacement. A separate launcher UI card can present model and settings
  from this API.
- Add a phase to the cumulative real-stdio rehearsal. Start two channels on
  one catalog and call distinct fixture providers. Change one channel's model
  and reasoning effort live. Assert the original in-flight turn's follow-up
  uses its original binding. Assert the next turn sends the new model and
  settings. Write a null channel model and verify inheritance. Preserve existing
  phases and exact script consumption.
- Verify unsupported updates, missing model fallback at open, queued-image
  hold and recovery, and an incompatible pinned checkpoint with no cross-model
  dispatch. Check model identity in usage and inspector records after the
  switch. Change the output cap and verify the actual provider field and
  the input budget used by the context builder.

For each gate submit the exact revision and focused offline evidence. The final
gate includes both typechecks, memory and SQLite conformance, archive migration,
real-stdio acceptance and the full harness and root suites. Provider-specific
settings can be tested using fixture endpoints without live credentials.
