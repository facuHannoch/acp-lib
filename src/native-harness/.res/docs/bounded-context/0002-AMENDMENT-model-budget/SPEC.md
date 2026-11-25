# Model-aware context budget

Status: Implemented in the working tree under [decision 0037](../../../decisions/0037-managed-context-budget.md).
Amends [bounded context](../0001-DESIGN/SPEC.md).

The native harness should size an inference request using the selected
model's configured context window. Today the default window and reserves
leave 13,312 units for input, and the initial estimator charges one unit
per serialized UTF-8 byte. Instructions and the Hub's full tool offer can
exhaust that budget before any optional history is included. This amendment
defines a configurable budget and a way to identify which limit was hit.

## Managed configuration

Pass the budget profile through the existing typed `harness.config.model`
argument on executable create and open. Support it for the current OpenRouter
and OpenAI-compatible configurations. It works before the model catalog
ships. When the catalog and live selection are available, the selected
model supplies the same profile and the turn pins it with its execution
settings. Persist the validated nonsecret profile with managed config and
carry it in session export.

Public fields under `model.contextBudget`:

| Field | Meaning |
| --- | --- |
| `contextWindowTokens` | Required when opting in. Total context capacity used for sizing this model. |
| `outputReserveTokens` | Space to reserve for generation when no explicit upstream cap is set. |
| `maxOutputTokens` | Optional provider generation cap. The adapter translates the field and applies the provider's accounting rules. |
| `estimationMarginTokens` | Extra room reserved for estimation and provider framing uncertainty. |
| `maxRequestBytes` | Independent cap on the serialized provider request. |

Keep the current behavior when the profile is omitted. For an opted-in
profile, use the explicit output cap as the generation allowance when it
is supplied. An explicitly larger output reserve may leave extra room.
When the cap is absent, reserve room internally and omit the provider
field. Validate safe integer values, applicable model limits, a positive
remaining input budget, and a bounded request byte cap. Decision 0037 sets
the defaults and the field translations. Configure an output cap only for
endpoints that support the translated field. A provider error is reported,
and the protocol cannot detect an endpoint that silently ignores a field.
The larger context window works without requesting a cap.

## Measuring and fitting a request

The input budget is the configured context window minus the effective output
reserve and estimation margin. Measure the instructions, messages, complete
offered tool definitions, required exchanges, provider framing, and any
selected images. Use verified model sizing where supported. Otherwise use a
named conservative estimate and expose that it is an estimate. An unknown
provider tokenizer gives no guarantee that an estimate matches the provider's
count. Image tokens use model sizing or a documented conservative estimate.
Encoded image bytes count toward the separate request byte cap. Preflight
large encoded bodies before allocating them.

Compute the exact offer after policy and availability filtering. Preserve
that offer and the required messages and exchanges. Trim optional history
under the existing bounded-context rules. If required material still exceeds
a limit, return `context_limit` before provider dispatch and keep the existing
taken-input and tool-result semantics. Changing the window does not change
inbox, attachment or storage read limits. Those limits can still bound how
much history and active work can be loaded.

Expose a safe breakdown in the inspector and overflow outcome. Distinguish
required storage records, estimated input tokens and encoded request bytes.
Show how much of the measured request is tool definitions, which sizing mode
was used, and the effective reserves. Recheck the encoded provider request
before dispatch. If the provider rejects it for context length, report that
as a provider-side context overflow and avoid retrying the same payload.

On-demand tool discovery and optional tool selection are separate increments.
The host can configure the set it wants to offer. The budget builder keeps
that offer intact after the normal permission and availability checks.

## Acceptance

1. Capture the actual Hub offer after policy filtering, using a sanitized
   snapshot if needed. Record its schema count, bytes and estimated tokens.
   Reproduce the existing overflow. Send the same offer through real acp-client
   stdio with the intended deployment profile and inspect the fixture
   provider's actual request for all expected definitions.
2. Check that messages plus tools fit with a larger configured window while
   optional history shrinks as needed. Exercise token, byte and required
   record overflow separately and verify each preflight failure produces zero
   provider requests.
3. Exercise explicit and omitted output caps independently. Verify that a
   larger output allowance reduces input room and that an internal reserve
   alone leaves the provider's output setting unchanged. Check a provider
   context-limit response and verify the same request is not retried.
4. Verify legacy configuration, managed config passthrough, reopen and
   export/import. Cover multibyte text, images, denied tools, and required
   web and MCP exchanges near the boundary.

The offline Hub fixture at agents `b0c9cf017` listed 36 tools. The
acceptance test replays their definitions through the ACP-client host
function catalog and native stdio. The legacy budget refuses the request.
The 128,000-token profile sends all 35 policy-allowed Hub definitions and
excludes the denied definition. Raw Hub MCP discovery has separate
compatibility limits. The fixture exceeds the 32-tool per-server discovery
limit and includes JSON Schema keywords outside the admitted subset.

See the [implementation plan](PLAN.md) for modules, staging and gates.
