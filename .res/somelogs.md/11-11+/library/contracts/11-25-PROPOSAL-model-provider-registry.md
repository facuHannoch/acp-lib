# Proposal: a model-provider registry for the native harness

Status: DRAFT for the harness team, 2026-11-25 (core-p, from the user's requirement 5 and a check of how opencode, Hermes
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
     headers?: Record<string, { env: string } | string>,   // follow-up; values by env reference, never logged
     compat?: { supportsDeveloperRole?: boolean, maxTokensField?: "max_tokens" | "max_completion_tokens", ... },
     models?: Record<modelId, { name?: string, upstreamId?: string, contextWindow?: number, maxOutputTokens?: number,
                               input?: ("text" | "image")[], reasoning?: boolean }>
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
