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
- `config/validate` and session-file import validate the reference without
  requiring its value. The execution host resolves it from its own environment
  at open, before enabling execution; a missing or empty value produces an
  actionable `invalid_config` error naming the variable, without replacing the
  saved config. Import does not require the credential; managed execution and
  reopen need the destination to provide it. The endpoint remains the existing
  OpenRouter adapter endpoint.
- New OpenRouter turn compatibility uses SHA-256 of
  `JSON.stringify([system,{protocol:"openrouter",model,apiKeyEnv}])`, plus
  decision 0016's canonical contributing policy definitions. Provider, model,
  and environment reference changes make a checkpoint incompatible; a change
  to an unrelated policy does not. Credential values are not fingerprinted, so
  rotating the destination secret under the same variable permits resume.
  Scripted compatibility remains SHA-256 of `[system,parsedScriptContent]`.
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
- Pre-0017 development checkpoints used SHA-256 of
  `JSON.stringify([system,model,scenarioToolNames])`. Migration records a
  legacy compatibility marker for those turns. Only those marked checkpoints
  may compare against the original legacy key; new turns use the new key. This
  preserves a compatible pre-managed checkpoint while avoiding a permanent
  fallback for new checkpoints. Legacy comparison did not bind a credential
  reference, so changing that reference cannot be detected for a legacy turn.
  No tool or approval is replayed merely because the config migrated.

## Compatibility and verification

The existing scripted session file and SQLite migration behavior is unchanged.
The session-file envelope remains version 1; the saved config carries the
OpenRouter tag and reference as data. A fresh destination must supply the named
credential; import does not need it. Verify create/export/import/reopen with no
sidecar and a fake or injected provider, assert the selected model and secret
are used only at dispatch, and assert the secret is absent from persisted bytes,
wire data and logs. Exercise missing environment, sidecar precedence, model or
reference changes, legacy checkpoint resume, and unrelated policy changes.
No live provider keys or network are used in automated tests.
