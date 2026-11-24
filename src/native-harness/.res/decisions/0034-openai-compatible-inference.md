# 0034 — OpenAI-compatible inference source

## Choice

ManagedModel adds an explicitly selected openai-compatible arm with
providerId, model, baseUrl and optional apiKeyEnv. Provider and model IDs
are nonblank opaque strings, preserved exactly and used without provider
inference or aliases. Strict managed validation rejects unknown keys,
including arbitrary headers. Scripted and OpenRouter remain separate.

## Endpoint and execution

baseUrl is the API path prefix. Parse it as an absolute URL. Reject
userinfo, query and fragment, including empty query or fragment delimiters.
Reject whitespace, backslashes and ambiguous URLs without an explicit
scheme and authority. Normalize scheme and host case and default ports with
the URL parser, and remove trailing path slashes. Preserve path case and
nondefault ports. Append /chat/completions to the normalized path prefix.
The caller provides any /v1 or gateway prefix. HTTPS is accepted. HTTP
requires a literal IPv4 address in 127.0.0.0/8 or the IPv6 address ::1.
The hostname localhost and IPv4-mapped IPv6 literals are excluded. Check
the normalized address, with canonical dotted-decimal IPv4 or bracketed
::1 in the source URL for HTTP.

Reject every redirect without following it, including same-origin redirects.
The nonretryable provider failure is redirect_refused.
Send the configured model in Chat Completions and reuse current message,
tool, tool-choice, stream and usage handling where compatible. Do not send
OpenRouter-specific headers. Resolve apiKeyEnv only at executable open,
never during validate, import or inspection-only open. An omitted name
sends no Authorization. A supplied name must be a valid environment variable
name and resolve to a nonblank value at executable open, or fail with
invalid_config. Persist and archive only the environment name. Omit
credentials from errors, captured requests and logs. Provider failures
must not echo provider response bodies or credential-bearing headers.

## Identity and compatibility

For the new arm, hash the existing system and offered-tool compatibility
inputs together with protocol, providerId, normalized baseUrl and model
using a structured tuple. Exclude the credential and environment name.
A source change can open for inspection but fences a checkpoint with a
different key. A credential reference change alone keeps its checkpoint
key. Preserve the existing scripted and OpenRouter key formulas byte for
byte. Save and import the normalized configuration using the existing
managed-config and session archive paths. Storage, archive and envelope
versions stay unchanged. Older strict readers refuse the new arm.
Legacy configs and archives remain readable.
A session saved with the new arm cannot be opened by an older binary.

## Gate

Use a loopback fake provider to check the exact path, model, messages,
tools and tool_choice, streaming text and usage, finish reasons, HTTP
4xx/5xx mapping, timeout and abort, keyless and keyed headers, and refusal
of same-origin and cross-origin redirects. Confirm validate and import
work without credentials, save/reopen and archive round-trip preserve
configuration without secrets, endpoint and model changes fence
checkpoints, and env-name-only edits preserve compatibility. Compare
legacy keys exactly. Run focused tests, both typechecks and full suites.
Before composing with A1, reconcile the shared model streaming, config,
development and stdio assembly, protocol and archive files against its
reviewed revision. Live provider calls and custom headers are outside
this gate.
