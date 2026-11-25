# Model-aware context budget implementation plan

Status: Implemented in the working tree. See [decision 0037](../../../decisions/0037-managed-context-budget.md).

The native harness currently subtracts output and estimation reserves from
16,384 and compares the result against serialized UTF-8 bytes. All offered
tool definitions count before optional history. The usual request therefore
has a 13 KiB ceiling independent of the model. Fix the request budget at the
harness boundary, and make it configurable through acp-client. Use the
same budget when the model catalog and live selection land.
[Budget amendment](SPEC.md) ·
[Model catalog and selection](../../model-execution/0003-DESIGN-model-selection/SPEC.md)

## B1 · Contract and configuration

- Add an opt-in, typed budget profile to the current managed model config
  passed through `harness.config.model`. Pin the public field spelling in
  the contract. Allow the existing OpenRouter and OpenAI-compatible model
  paths to use it before the catalog ships. The catalog later owns the
  profile per model, with the effective profile bound to the turn.
- Define the model context window in tokens, the requested output cap and
  the input estimation margin separately. Compute the input token budget
  from the context window minus the output reserve and margin. Keep an
  explicit reserve when no provider output cap is requested. Validate
  finite positive limits, a positive input budget and any supported model
  ceilings. The adapter maps a configured generation cap to the correct
  upstream field. A setting the endpoint cannot honor needs an explicit
  contract outcome.
- Keep an independent serialized request-size cap in bytes. It protects
  resource use even with a large token window. Preserve inbox admission,
  attachment and storage-read limits. A configured context window should
  not silently enlarge those limits.
- Keep the legacy profile for configurations that omit the new fields.
  Verify the existing managed config, archive and reopen behavior. Pin which
  budget changes affect checkpoint compatibility and which apply only to
  new turns. State whether a format or archive version actually needs to
  change before reserving one.

## B2 · Estimate the request the model will receive

| Area | Proposed changes |
| --- | --- |
| Public config | Extend `src/contracts/config-permissions.ts` and `src/util/config.ts`. Use the existing managed validation and portable projection. Add context profile types to the public SDK. |
| Request sizing | Put an injectable sizing contract under `src/contracts/context.ts`. Resolve it with the model adapter in `src/capabilities/model/`. Use a verified model tokenizer or a documented conservative estimate for unsupported tokenizers. Keep UTF-8 byte measurement as a separate value and flag estimated sizing in diagnostics. |
| Assembly | Make `src/index.ts` pass the effective budget and sizing strategy to `src/capabilities/context/session.ts` for the current model or stored turn binding. Keep provider-specific handling in the model adapter. |
| Context and inspector | Fit messages and offered schemas using the bound profile, and report the effective window, output reserve, tool cost and omitted history through the existing capture path. Include units and the estimator mode. |
| Host | Pass the managed model fields unchanged in the native acp-client open path. Document the same input for standalone config and acp-client. |

Size the provider-equivalent request, including instructions, input, tool
names and schemas, tool call/result messages, provider framing and selected
images. The contract must define how to account for image tokens without
counting their encoded bytes as text tokens. Count encoded payload bytes
for the separate byte cap. Preserve the retry snapshot. Avoid repeated
tokenization of a large unchanged tool list during history fitting. Check the
final assembled request at the model boundary and bound estimation work.

## B3 · Fit tool definitions predictably

- Apply policy and availability before costing the offer. Budget the exact
  resulting tool set. Keep active input and required call/result exchanges
  intact. Shed optional history before failing a required request.
- In this slice, an offered definition is part of the request contract.
  Do not silently remove it just to fit the budget. If required material
  still cannot fit, return `context_limit` before provider dispatch. Include
  safe structured diagnostics for the measured tool, required input and
  available budget components.
- A launcher can configure a core set while exposing a larger configured
  set where the model budget allows it. On-demand discovery or an explicit
  optional-tool selection strategy is a separate increment. It should use
  the same budget and policy checks.

## Acceptance

1. Capture the actual Hub tool offer after policy filtering or use a sanitized
   snapshot of it. Record measured bytes and estimated tokens. Reproduce
   `context_limit` at the current default and verify the same offer reaches
   a fixture provider in full with the intended deployment window and byte cap.
2. Run through acp-client and real stdio. Verify configured limits reach the
   executable harness and that the provider receives the full expected tool
   offer. Lower the configured limit and verify a typed failure with zero
   provider calls. Check a denied tool contributes zero to the offer budget.
3. Test exact budget boundaries, multibyte content, token-estimation fallback,
   images, optional history trimming, and the active web/MCP exchange rule.
   Verify raising the output reserve reduces the input allowance. Verify the
   byte cap still applies when the token estimate fits.
4. Verify legacy configs, reopen, export/import, and selection of another model
   profile when the catalog is available. No model-selection implementation
   dependency is required for the first managed-config slice.
5. Run both typechecks, focused context and catalog tests, the cumulative
   real-stdio rehearsal, and the full harness and root suites.

First deliver the config and sizing contract. Then implement the configured
larger window end to end against the existing model adapters. Compose with
live model selection when its turn-binding contract lands.
