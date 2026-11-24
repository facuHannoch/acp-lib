# 0035 — Web search and fetch, transport and cost evidence

## Problem

Public research needs two portable tools, a bounded complete model-facing result,
independent backend selection, and honest durable evidence of a paid dispatch.
The HTTP transport must enforce public destinations at the socket, not merely
validate a URL which can resolve differently later. The reviewed working scope
and staged implementation plan are [the spec](../docs/web-tools/0001-DESIGN/SPEC.md)
and [plan](../docs/web-tools/0001-DESIGN/PLAN.md). This is contract review only.

## Options

A hosted-only tool would conflate search and fetch credentials; direct HTTP as
an automatic fallback could silently create costs or change source access.
Recording usage from current configuration after recovery would misattribute a
previous dispatch. Truncating a JSON string in context makes invalid previews.
Choose independently enabled backends, checked dispatch with frozen attribution,
and a complete size-budgeted JSON result before recording it.

## Choice

### Tools, admission, and result

Reserve `web_search` and `web_fetch` names even when disabled; conflicting host
registrations are rejected as for other reserved local names. Arguments are
exact objects with no additional keys: `web_search` has `{ "query": string }`,
nonblank after trimming and at most 1024 UTF-8 bytes; preserve the supplied query
when sent. `web_fetch` has `{ "url": string }`, an absolute public HTTP(S) URL,
at most 2048 UTF-8 bytes. Reject controls, whitespace, backslashes, userinfo,
fragments, ambiguous or noncanonical numeric IP spellings and URLs whose
normalization alters authority interpretation. Normalize the URL using the URL
parser; retain path/query and the normalized initial URL as the source. A URL
is data, never an instruction; search and fetched text are untrusted external
content. Search hit URLs also must be well-formed public HTTP(S) URLs with no
userinfo; omit invalid hits, without fetching them. Hostnames require destination
checks at fetch time; search does not resolve every hit.

Success content is exactly UTF-8 JSON, no Markdown fence:

* search: `{ "results": [{ "title": string | null, "url": string, "excerpt": string | null }] }`, in provider rank order; empty is valid;
* fetch: `{ "url": string, "title": string | null, "text": string, "truncated": boolean, "coverage": "full" | "partial" | "unknown" }`. The source URL is the normalized requested URL; redirects, where supported, do not replace attribution. Empty extracted content is `page_unavailable`, not success.

Only the listed keys occur, including explicit nulls. Coverage describes the
extraction before clipping: `full` only with affirmative completeness evidence,
`partial` only when known incomplete, and otherwise `unknown`. `truncated` is
true only for known backend or harness clipping. A backend maximum reached
without a reliable signal leaves coverage `unknown`; do not infer either complete
or clipped from a length alone. Direct HTML extraction that excludes script,
style, navigation or dynamically rendered content is `unknown` unless evidence
proves a narrower result; a completely decoded plain text response can be `full`.

Defaults and hard maxima: five search hits (configurable 1–5), 512 UTF-8 bytes
per excerpt (configurable 1–512), and 15 seconds total per invocation
(configurable 1000–60000 ms). Use a 2048-byte maximum for the *entire serialized
UTF-8 JSON content*, counting escaped control characters, URLs, keys, nulls and
punctuation. Shorten textual values on Unicode scalar boundaries by checking the
actual serialized bytes; retain required fields and source URL. Fit search in
rank order, shortening optional title/excerpt first and then dropping trailing
hits; never claim an invalid or partial JSON object. For fetch, shorten title
then text, setting `truncated` on known shortening. If required fetch fields and
URL with empty text do not fit, return paired `result_too_large` as a small
bounded error, never truncate the URL or emit malformed JSON. No retained full
result or `read_tool_result` reference is promised. Persist precisely this
preview as the paired tool content; active-context selection must pass it intact
as a single tool result rather than applying byte slicing or a shortening suffix.
If the overall inference context cannot fit the whole active exchange, use the
existing typed context-limit behavior; never silently fragment the JSON. Historical
context selection may omit an entire completed exchange according to existing
rules, while inspection keeps the committed result.

Implement a generic checked local registration with a definition, availability,
strict validator, executor, and dispatch attribution supplied by the capability;
assembly enumerates registrations and applies existing policy/lifecycle rules,
without importing Exa/HTTP protocol details. Check offer, current availability,
and argument validity before asking for approval; recheck availability, arguments
and policy after approval and immediately before durable dispatch. Disabled,
malformed or unoffered calls get one paired `tool_unavailable` or
`invalid_arguments` rejection, without prompting or dispatch. Denial remains
`policy_denied`. Use typed `rate_limited`, `provider_error`, `tool_timeout`,
`page_unavailable`, `unsupported_content`, `blocked_destination`,
`response_too_large`, `result_too_large`, and `tool_interrupted` failures as
applicable. The paired outcome code is stable and the bounded model-facing
message is actionable and secret-free. No retries, speculative redirects, or
paid fallback. One explicit invocation sends at most one Exa request.

### Configuration, credentials, and transport

Add independent optional managed configuration entries `webSearch` and
`webFetch`. Omission disables the respective tool. `webSearch` selects
`{ backend: "exa", apiKeyEnv?: string, maxResults?: integer, excerptBytes?: integer, deadlineMs?: integer }`;
`webFetch` selects either `{ backend: "exa", apiKeyEnv?: string, deadlineMs?: integer }`
or `{ backend: "http", deadlineMs?: integer }`. Reject unknown fields, invalid
limits and invalid environment variable names. Exa's absent `apiKeyEnv` means
`EXA_API_KEY`; HTTP has no credential. Enabled Exa is the initial hosted default
when explicitly selected, never an implicit tool enablement. Strictly validate
configuration at validate/import without reading secrets; at executable create/open
resolve only references actually required by enabled entries, fail `invalid_config`
with the missing or blank variable name, and never include its value. Inspection
open and import need no secret. Freeze the resolved backend and limits for the
open session; credentials come from that launching process including containers.
Persist/export only choices and references. Do not expose secrets or authorization
headers in results, errors, captures, inspector, logs or archives. Test with a
synthetic canary. A destination process resolves its own environment on open.

Exa uses HTTPS `https://api.exa.ai` only, rejects provider redirects, sends
`x-api-key` only to Exa, and uses bounded JSON parsing with a 2 MiB wire and
2 MiB decoded response cap. Search POST `/search` body is
`{ "query": query, "type": "auto", "numResults": N, "contents": { "highlights": { "maxCharacters": 512 } } }`.
The adapter converts highlights to a short excerpt and applies the local byte
caps regardless of provider behavior. Fetch POST `/contents` body is
`{ "urls": [normalizedUrl], "text": { "maxCharacters": 16000 }, "maxAgeHours": 24, "livecrawlTimeout": 10000, "subpages": 0 }`.
The cache policy accepts a cache up to 24 hours old before requesting a fresh
crawl, but Exa documents a possible older-cache fallback after crawl failure:
this is a freshness target, not an age guarantee. Do not set deprecated
`livecrawl` alongside `maxAgeHours`. The single overall deadline can expire before
livecrawlTimeout. Require a matching requested URL status of `success` and a
matching result with readable text; a failed/missing/ambiguous status or result
is `page_unavailable` even on HTTP 200. Capture available `requestId` and valid
`costDollars.total` before interpreting extraction success. A response's actual
freshness is not inferred from the setting. Exa alone performs the source fetch;
this harness does not claim to pin its DNS or redirects. API reference:
[Search](https://exa.ai/docs/reference/search),
[Contents](https://exa.ai/docs/reference/get-contents).

Direct HTTP is separately selected and receives no Exa or model credentials,
cookies, authorization, proxy credentials, or ambient proxy configuration.
Allow only GET of public HTTP(S), at most five redirects, one request at a time,
with the same total deadline covering DNS, connect, TLS, headers and streamed
body. Resolve A/AAAA for each hop, reject non-global, loopback, private, link-local,
multicast, unspecified, reserved, documentation, carrier-grade NAT, IPv4-mapped
and other special-use addresses according to current IANA special-purpose
registries, and fail closed on unclassifiable addresses. A mixed public/private
answer is rejected. DNS failure is typed; no URL may use a Unix socket, local
name, proxy, or userinfo. Bind the socket to an address from that validated answer
without a second DNS lookup, check the connected peer matches it, and preserve
original host for HTTP Host and HTTPS certificate verification/SNI. Check every
redirect target before opening a connection, prohibit HTTPS-to-HTTP downgrade,
and strip origin-sensitive headers across redirects. Reject invalid, looping,
or excessive redirects and do not issue a request to a blocked destination.
Disable connection reuse across separately validated destinations; enforce the
same checks for IPv4 and IPv6. Use no production configuration for fixture hosts,
private-address exceptions, custom resolver, or alternate transport.

Cap raw response bytes at 2 MiB and decompressed body bytes at 4 MiB while
streaming, independently of Content-Length; enforce limits on every redirect
response and final body, with decompression bombs and unsupported content
encodings failing closed. Support `text/plain` and `text/html` with supported
charset, report unsupported MIME/charset, PDFs and binary as `unsupported_content`.
Bound parser memory by the decoded cap; do not execute scripts or load resources.
Cancel and destroy DNS/connection/body/decompression work on signal or deadline;
await cleanup and emit exactly one paired result. An injected test assembly may
supply a fixture transport and resolver, never via production managed config.
Transport contract tests exercise the actual connect-and-read boundary including
peer pinning; a fake response alone does not establish that property.

### Durable paid dispatch and paired-result usage

Extend `markToolDispatched` atomically to bind the invocation ID
`<turnId>:<toolCallId>` to immutable `{ backend: "exa" | "http", operation:
"web_search" | "web_fetch", paid: boolean }` before the first external request;
`paid` is true only for Exa. A failed mark starts no request. No policy grant or
secret is stored in the evidence. No dispatch for refusal or denial. Exactly one
request follows an Exa mark, at most once; a crash or interruption after marking
and before issuing it remains conservatively unknown and is never replayed.
Do not reclassify from the current config on reopen. Preserve original behavior
for legacy/non-web tool dispatches with no evidence, and do not fabricate cost.

Extend `ToolExecutionResult` with optional structured usage containing bounded
provider request ID and finite nonnegative USD provider-reported estimate, both
optional; numeric zero is valid. Commit content, outcome and known usage in the
same transaction through `appendMessage`, keyed by invocation ID. Malformed cost
is not zero and is omitted; parse valid metadata on failed extraction and other
responses when supplied, including non-2xx bodies within bounds. Interruption or
timeout after dispatch with no committed reported cost is unknown. If result
commit loses a race to interruption, only the winning durable transaction governs;
late replies never amend the already paired result or cause a second request.
A storage failure must not expose an uncommitted result as durable.

Extend invocation inspection for channel/turn with at most one usage projection
per invocation: `cost: { kind: "none" }` for no paid dispatch (including HTTP,
refusal, denial); `{ kind: "provider_estimate", usd: number }` for committed
reported Exa cost, including zero; or `{ kind: "unknown" }` for a paid dispatch
without committed reported cost. Include original backend/operation when marked,
and the committed provider request ID if present. Legacy invocations without
classification have no new usage projection, not a fabricated zero. Usage stays
out of model-visible content and ordinary diagnostics. The paid status is an
estimate, not billing-grade accounting. Existing invocation authorization and
channel/turn visibility continue to govern inspection.

### Storage and compatibility

Keep dispatch evidence and committed result usage in canonical durable session
state, not ephemeral process state or a projection derived from configuration.
Memory and SQLite adapters implement the same atomic transitions. Session export
and fresh import preserve evidence, attribution, usage, and absent-versus-zero
without persisting credentials; validate all new archive fields and references.
On reopen with another backend a lost-result invocation remains one unknown-cost
entry attributed to its original mark. Old archives/configs and legacy dispatches
remain readable. New feature-bearing snapshots require a versioned format which
older strict readers refuse, never silently drop evidence. Feature-free sessions
continue to export the appropriate preexisting archive (including A1 and routines
features where present), with no new usage fields. Do not allocate SQLite or
archive version numbers in this decision: agree the next numbers and actual
integration base with the A1 and routines owners before runtime schema work.
Envelope version remains unchanged unless a separately reviewed decision changes
it. A1 format 9/archive 8 and R-H4 format 8/archive 7 cannot be overwritten.
Coordinate shared config, assembly, storage, archive and inspector files with A1
and 0034; compose against their actual accepted revisions without changing 0034's
text-only endpoint or A1 vision validation, redaction and archive semantics.

## Verification and gate

Offline fake Exa verifies exact JSON requests, one request per invocation, empty
and ranked search, each URL status, failure with reported ID/cost, explicit zero,
response and preview bounds, escaping and multibyte boundaries, coverage versus
truncation, and parseable complete 2048-byte content as actually delivered in
the next provider inference. Exercise valid and invalid/disabled calls under ask
on standalone and stdio, denial without dispatch, deadline/cancellation and
paired results. Restart SQLite on both sides of mark/result commit, including a
changed configured backend, and assert one attributed entry, unknown on a lost
paid result, none for direct/denied, atomic result plus usage, and no replay.
Round-trip feature-bearing and feature-free archives, legacy archives, routine and
A1 state; verify credential canary absent from config, exports and inspector.

The real transport suite tests public and blocked IPv4/IPv6 including mapped and
mixed DNS results, rebinding/peer mismatch, redirect to blocked/downgrade/loop,
no request to blocked targets, TLS host validation, cancellation at DNS/connect/
body and compressed/decoded overflow. Offline fixture injection cannot weaken
production checks. The cumulative real-stdio rehearsal adds search then fetch,
asserts exact script consumption, source URLs, clipping and coverage, parseable
preview at the next inference and invocation usage; direct-only mode verifies no
paid cost and no Exa key. Compare a documented corpus including JavaScript and
PDF limitations separately. Both typechecks and both full suites are runtime
gates. A separately authorized live search/fetch check is reported separately,
not part of the offline suite. Independent approval of this exact decision is
required before assigning dependent hosted and HTTP implementations.
