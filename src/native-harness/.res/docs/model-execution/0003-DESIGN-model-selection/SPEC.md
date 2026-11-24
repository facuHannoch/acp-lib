# Model catalog and live selection

Status: Proposed for v1.

An Agent configures named providers and their model catalog. All native
channels can list the same catalog. An Agent has a default selection and
each channel can inherit it or select its own model and request settings.
Selection changes are live. Running turns keep the model and settings
they started with.

## Catalog configuration

Accept the catalog in the existing typed managed configuration passed at
`session/create` and executable `session/open`, alongside instructions,
policies and tools. The caller can construct it directly in code. Save a
validated portable copy in the harness session database and include it in
session export. No separate catalog file is required.

- A provider entry has a stable ID, a protocol, an endpoint where needed,
  and a credential reference. Define provider connection settings once.
  Resolve secret values only at runtime and keep them out of storage,
  session files and inspection.
- A model entry has a stable key within its provider, the exact upstream
  model ID, a display label, capabilities, supported request controls,
  and request defaults. Use the provider and model keys together as the
  stable selection identity. Distinguish the upstream ID from the picker
  label and selection identity.
- Every catalog has one configured default pointing to an existing model.
  It seeds the current Agent default for a new session and is the fallback
  when a saved selection can no longer resolve. A catalog with an invalid
  configured default fails validation before replacing the saved config.
- Start with OpenAI-compatible Chat Completions and the existing OpenRouter
  behavior, using the same catalog shape. Share request assembly where
  semantics match and let adapters translate provider-specific controls.
  Existing single-model configurations keep their existing behavior and
  can appear as a one-entry catalog. Scripted execution remains available
  for tests.

Catalog replacement takes effect at executable open in v1. An open without
a new catalog uses the saved one. Resending the same catalog on reopen
keeps live selections. No automatic provider discovery or network lookup
is required to populate the configured list.

## Live selections and request settings

Expose SDK operations to list models and their supported controls, read
the effective Agent or channel selection, and write Agent or channel
settings. Resolve the effective model as `channel.model ?? agent.model`.
The channel field is nullable. Writing null inherits the Agent model.
Use the ordinary settings write for both values. In a patch, an omitted
field leaves the current value alone. The read view includes the stored
channel field and the effective model. Use the same operations from the
standalone picker and acp-client. The owning host authorizes writes
under the existing operator boundary.

Persist the Agent default, channel choices and model-specific overrides
as live session state in SQLite, separately from catalog defaults. A
channel can inherit the Agent's model and still set its own supported
request options for that model. Changing the Agent default affects
inheriting channels. An explicit channel selection keeps its chosen model.
A switch does not carry another model's overrides across.

Resolve settings in this order, with later values taking precedence:

1. Defaults on the selected model entry.
2. Agent overrides for that model.
3. Overrides for that model on the current channel.

V1 exposes reasoning effort, temperature and maximum output tokens where
supported. The catalog describes accepted values and ranges. Only offer
reasoning Off when the adapter can honor it for that model. Hiding returned
reasoning is a separate control. When no configured value applies, omit the provider field.
Reject unsupported settings before committing a live update. Advanced
provider-specific settings, if exposed, use a validated adapter-owned shape.
The harness owns request identity, message and tool payloads, credential
handling, and tool permissions. Per-message overrides are deferred.

Keep the model's context window separate from maximum output tokens.
The context builder reserves space for the effective output budget and
its estimation margin when sizing the input, including instructions,
history, tools and the active exchange. Increasing the output cap reduces
the available input budget. The adapter translates the cap according to
provider semantics, including reasoning tokens where counted. When no cap
is sent to the provider, the harness still needs a bounded context reserve.
Pin its fallback at contract review.

## Turn binding and catalog replacement

When a turn starts, resolve and bind its provider, model, effective
settings and compatibility identity. Store this binding with the execution
record. Tool follow-ups, retries and checkpoint resume use the binding. A
live selection change applies only to subsequent turns. Concurrent channels
can use different models. Requests and usage records identify the provider
and model that actually ran. Do not forward provider-specific reasoning
state to a different provider or model.

At catalog replacement:

- If the saved Agent default has disappeared, use the catalog's configured
  default. If an explicit channel choice has disappeared, clear it so the
  channel inherits the effective Agent default. Report the resulting
  effective choices. Removal alone does not require an explicit replacement
  or prevent the session from opening.
- A checkpoint keeps its original binding. If that binding is unavailable
  or incompatible, use the existing incompatible checkpoint path. Preserve
  it for inspection and expose the reason. The fallback applies to new
  turns. It does not resume a checkpoint on another model.
- Never silently drop already accepted images. Refuse a live selection
  change that would make an affected channel's queued images unsupported.
  An Agent default change checks all affected inheriting channels. When a
  replacement catalog forces a text-only fallback on reopen, keep affected
  queued inputs durable and held. Allow the session to open and other
  channels to run. Expose the hold so the operator can select a compatible
  model or withdraw the input.

## Acceptance

1. Start a session with two providers and multiple models. Two channels list
   the same catalog and use different selectors over real stdio. Verify the
   actual provider request contains the exact resolved upstream model and
   supported settings.
2. Change the default and a channel override during concurrent work. Running
   and resumed turns retain their binding. New turns use the new selection.
   Writing a null channel model restores inheritance. Reject an unsupported
   setting with no change to the stored selection.
3. Reopen and export/import the session. Verify catalog and live selections
   survive, a repeated catalog does not reset choices, and credentials are
   excluded. Replace the catalog with one whose valid default survives and
   a previously selected model has disappeared. Verify fallback without
   blocking open and no cross-model checkpoint resume.
4. Verify image admission under the effective model and the queued-image
   fence for channel changes and Agent default changes. Verify the reopen
   hold and release path for an incompatible fallback.
5. Verify output caps in provider requests and context budgeting with the
   same selected model and different output caps. Verify an omitted cap
   still leaves a bounded context reserve.
6. Verify legacy single-model and scripted configurations. Extend the
   cumulative real-stdio rehearsal with a live switch witnessed at the
   fixture provider. Run both typechecks and the full suites.

Record the exact SDK shapes, storage and archive compatibility, settings
translation and precedence, and checkpoint and queue behavior in a numbered
contract decision before dependent implementation. Coordinate with
[billing-grade accounting](../0002-AMENDMENT-accounting/SPEC.md) on execution
identity.
