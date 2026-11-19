# Managed OpenRouter configuration

## Problem and options

Decision 0016 restricted managed configuration to scripted models, but the
existing explicit development `--db` flow also runs OpenRouter. The user chose
to preserve that flow and make it portable without saving credential values.
Options are to exclude it, embed credentials, or save provider and model data
with a reference to a destination environment variable. Choose the reference;
this amends decision 0016 without adding a configured tool adapter.

## Choice

- `ManagedConfig.model` is a tagged union: the existing
  `{protocol:"scripted",script:string}` or
  `{protocol:"openrouter",model:string,apiKeyEnv:string}`. OpenRouter's model
  is a nonempty model identifier retained verbatim. `apiKeyEnv` names a
  destination environment variable matching `[A-Za-z_][A-Za-z0-9_]*`; the name
  is portable, its nonempty value is a runtime secret. Unknown fields and raw
  credential values fail validation. Do not include credential values in the
  saved config, SQLite session, session file, events, errors or logs.
  The default model is `deepseek/deepseek-v4.1-flash`, and the default reference
  is `OPENROUTER_API_KEY`. Ports and socket paths remain process settings.
- `config/validate` and session-file import validate the reference without
  requiring its value. The execution host resolves it from its own environment
  at open, before enabling execution; a missing or empty value produces an
  actionable `invalid_config` error naming the variable, without replacing the
  saved config. Import does not require the credential; managed execution and
  reopen need the destination to provide it. The endpoint remains the existing
  OpenRouter adapter endpoint.
- OpenRouter compatibility remains exactly the existing development key:
  SHA-256 of `JSON.stringify([systemPrompt,modelId,scenarioToolNames])`, plus
  decision 0016's canonical contributing policy definitions. Neither the key
  value nor its environment-variable name enters either fingerprint. A change
  to a credential reference alone does not block a checkpoint; a model or
  system change does. An unchanged pre-managed OpenRouter checkpoint resumes
  with the same key and needs no legacy marker. Scripted compatibility remains
  SHA-256 of `JSON.stringify([system,parsedScriptContent])`.
- Preserve existing `openDevelopment` provider options and the CLI's
  `OPENROUTER_MODEL` and `OPENROUTER_API_KEY` behavior. A newly created managed
  OpenRouter database saves the selected model and an environment-variable
  reference (default `OPENROUTER_API_KEY`), never the key. An existing
  pre-managed provider database with no saved config may still open using its
  explicit runtime provider settings. When managed config is available, the
  sidecar/open precedence of 0016 applies, and saved config supplies provider
  and model on a later open without a sidecar or inline config. Caller-supplied
  legacy `provider.apiKey` remains usable for that current development open;
  it is never saved and a later saved-config reopen requires the named env var.
- At open, sidecar wins over inline config, then saved config is used. The
  `OPENROUTER_MODEL` environment value supplies the model only if no saved model
  exists, including a format 2/3 development database. It never overrides a
  saved model. The referenced credential variable, defaulting to
  `OPENROUTER_API_KEY`, is resolved at every OpenRouter open. A missing key
  fails before inference and leaves an existing database unchanged. `--script`
  continues to require no key. No tool or approval is replayed by migration.

## Compatibility and verification

The existing scripted session file and SQLite migration behavior is unchanged.
The session-file envelope remains version 1; the saved config carries the
OpenRouter tag and reference as data. A fresh destination must supply the named
credential; import does not need it. Verify create/export/import/reopen with no
sidecar and a fake or injected provider, assert the selected model and secret
are used only at dispatch, and assert the secret is absent from persisted bytes,
wire data and logs. Exercise missing environment, sidecar precedence, model
changes, reference changes that preserve compatibility, legacy checkpoint resume,
and unrelated policy changes. Scripted saved-config reopen remains an offline
acceptance gate and never needs a provider key.
No live provider keys or network are used in automated tests.
