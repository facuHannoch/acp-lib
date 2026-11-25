# Proposal: a model-provider registry for the native harness

Status: DRAFT revision 2 (harness feedback folded in), 2026-11-25 (core-p, from the user's requirement 5 and a check of how opencode, Hermes
and pi do it). Not a decision. Answers to the open questions are marked as ASSUMPTIONS so the harness team can start and the
user can correct them.

## Why

The user wants the native model to be as flexible as in opencode, Hermes or pi: choose where the model runs (provider,
endpoint, model), without a harness code change per provider. Today `ManagedModel` is `scripted | openrouter | openai-compatible`
(decision 0034, one inline provider per model). All three reference tools instead have a named provider registry.

## What the three tools do (public docs, verified 2026-11-25; check field names against current docs before copying)

- opencode: a named provider (any ID) with its own base URL and an adapter package (`@ai-sdk/openai-compatible` for any
  OpenAI-compatible API); a models map per provider (key = ID used by opencode, optional `modelID` = what is sent upstream);
  models can be hidden by allow/deny lists; keys from config or a login command.
- Hermes: `provider: custom` + `base_url` in `~/.hermes/config.yaml` or a `custom_providers` list; keys in `~/.hermes/.env`
  referenced as `${VAR}`; default model name and optional context length.
- pi: custom providers in `~/.pi/agent/models.json`, each with `baseUrl` and `api` (`openai-completions`, `openai-responses`,
  `anthropic-messages`, `google-generative-ai`), a model list (only the ID is required), compatibility flags for server quirks
  (for example `supportsDeveloperRole: false`), keys by login or auth file.

Shared shape: named provider + wire protocol + base URL + key by reference + model IDs + small compatibility flags.

## Proposal: three layers

1. **Wire protocols** (harness code, a short fixed set). First `openai-completions` (Chat Completions: OpenRouter, Ollama,
   vLLM, LM Studio, most gateways). Then `anthropic-messages` and `openai-responses`. Later `google-generative-ai`. The harness
   owns streaming, tool calls, usage, retries and redaction for each protocol.
2. **Provider registry** (data). `harness.config.providers: Record<providerId, Provider>`:
   ```
   Provider = {
     protocol: "openai-completions" | "anthropic-messages" | "openai-responses",
     baseUrl: string,               // HTTPS, or literal loopback HTTP (decision 0034 rules)
     apiKeyEnv?: string,            // reference only; resolved when the session opens; optional for keyless endpoints
     headers?: Record<string, { env: string }>,   // follow-up, NOT in the first slice; values ONLY by env reference (no literals), never logged
     compat?: {},   // empty on day one: no flag is justified by the current code; first candidates if a fixture rejects the request:
                    // `streamUsage` (stream_options.include_usage) and `toolChoiceAuto` (explicit tool_choice:'auto').
                    // A developer-role switch or token-field selector does not exist in the serializer today.
     models?: Record<modelId, { name?: string, upstreamId?: string, contextWindow?: number, maxOutputTokens?: number,
                               input?: ("text" | "image")[], reasoning?: boolean }>
                               // DESCRIPTIVE only (for a picker) until the selected adapter really supports the field
   }
   ```
3. **Model selection.** `harness.config.model` becomes either the existing arms (unchanged, compatible) or a registry
   reference `{ provider: providerId, model: modelId, options?: { reasoningEffort?, temperature? } }`; an optional
   `fallbackModel` of the same shape. The inline `openai-compatible` arm of 0034 stays and is defined as an anonymous provider.

Checkpoint/fingerprint key: protocol + provider ID + normalized endpoint + model (as in 0034), excluding env names and
credentials. Usage, context-window budgeting and image support read the model entry when present.

## What acp-client does

- Typed pass-through of `providers` and the new `model` shape from the harness SDK types (no hand-copied shapes).
- Optional read side for a hub picker: `agent.nativeModels()` returning the configured providers/models (from the harness
  status, no secrets, no env values).
- A model or registry change needs a native restart; the existing `restartNative({ config })` already carries it.
- Tests with a loopback fake provider (real stdio), as for 0034.

## ASSUMPTIONS to confirm (the user's six questions, with my answers)

1. Registry lives inline in the Agent's config (`harness.config.providers`), assembled by the hub. A file in the harness home can
   come later.
2. First protocols: `openai-completions` + `anthropic-messages` (+ `openai-responses` next).
3. Keys by environment-variable reference only, resolved when the session opens; subscription/OAuth logins are a separate, later
   piece.
4. The model stays per Agent (bound at session open). Per-channel models need a harness change and are out of scope until the
   hub asks for them.
5. One fallback model, optional.
6. Model discovery: only the configured list; querying a provider's own model list endpoint is later.

## Open for the harness team

- Which compatibility flags are needed on day one (developer role, token field name, stream usage, tool-call quirks)?
- Interaction with 0034: keep the inline arm as sugar, or deprecate it once the registry exists?
- Does the runtime (`openai-compatible` execution, now implemented) already structure its client so a protocol is a module?
- Redaction and headers: same rules as 0034 (no URL credentials; secrets by env reference; nothing in durable/diagnostic surfaces).

## Revision 2: harness feedback (haurness-l, against alpha 8068558) and what it changes

- The runtime has a shared `ModelAttempt` runner; Chat Completions is one concrete implementation (`openrouter-stream.ts`, with
  OpenRouter and 0034 wrappers and `chat-request.ts` serialization). There is no configured protocol registry yet. A new wire
  protocol is its own adapter module behind `ModelAttempt`. So layer 1 is "add adapter modules" and layer 2 is new work.
- Compat flags: none justified on day one. `compat` starts empty; the first candidates, only if a target fixture rejects the
  existing request, are `stream_options.include_usage` and explicit `tool_choice:'auto'`. No developer-role switch or token-field
  selector exists in the serializer, so those are removed from the draft.
- Model `input`/vision/reasoning metadata is descriptive until the selected adapter supports it.
- Headers: env references only, no literal strings (the type is now `{ env: string }`), and headers are NOT in the first slice.
- First slice proposed for the user to approve: protocol `openai-completions` only (what exists), a `providers` registry with
  `protocol`, `baseUrl`, `apiKeyEnv?`, `models?` (descriptive), and the `{ provider, model }` selection; then a small
  reviewed TYPE-ONLY SDK commit, separate from runtime and picker wiring.

### Decisions still needed (the harness team asked for explicit choices)

1. **Fallback timing and checkpoint identity.** When does a fallback model take over (before any output only? after a transient
   failure budget? never mid-stream), and does a turn resumed from a checkpoint keep the model it started with? Proposal: no
   fallback in the first slice (drop `fallbackModel`), so checkpoint identity stays "protocol + provider ID + endpoint + model".
2. **User approval of the first protocol and scope** (above), so the type-only SHA can be requested.
