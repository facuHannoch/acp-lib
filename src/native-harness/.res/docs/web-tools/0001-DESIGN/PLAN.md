# Web tools implementation plan

Date: 2026-11-24

Status: Ready for contract drafting. Timeline retrieval and one-off reminders
are integrated at `4dad65e`. Attachments and routines are in flight.

Ship independently configurable `web_search` and `web_fetch` through the
checked native tool path from Gate 1. The first hosted backend is Exa. Develop
the direct HTTP fetch adapter in parallel once the fetch contract is approved.
The cumulative script exercises both tools over real stdio with fixture
responses at the provider boundary.
[Web tools spec](SPEC.md) · [Timeline retrieval plan](../../timeline-retrieval/0001-DESIGN/PLAN.md)

## G2a · Contract review

The session assembly in `src/index.ts` already checks the current offer,
availability and arguments for timeline and reminder tools. Reuse that
admission behavior and its policy and result lifecycle for the web tools.
The contract should identify the smallest registration change needed to
avoid adding provider logic to session assembly.

Existing dispatch evidence records that the invocation started.
`ToolExecutionResult` carries content and outcome, and the paired result
is committed through `SessionStorage.appendMessage()`. Pin how the dispatch
commit records the resolved provider and operation for a potentially paid
call. Recovery must be able to classify a dispatched invocation even if its
result is missing and the session later opens with a different backend.
The inspector reads structured usage from the invocation, while model
context receives the content and ordinary tool outcome.

Contract drafting and adapter fixture design can run in parallel with
attachments and routines. Coordinate shared storage, archive and session
assembly changes before implementation. Use the next available decision
number after the current allocations and agree on compatibility before
assigning any new format numbers.

- Ground local registration and availability against the final Gate 1
  contract. Pin normalized result fields, error codes, validation, and the
  output byte cap. Proposed starting defaults for review are up to five search
  hits, up to 512 UTF-8 bytes per excerpt, and a 15-second request deadline.
  The complete serialized preview fits the context builder's 2 KiB inline
  limit, including URLs, metadata and JSON escaping. Apply the overall cap
  before returning the result, preserving complete JSON. Pin raw and decoded
  response bounds and the redirect count independently. Retained results can
  follow under a separate contract using `read_tool_result`.
- Pin the Exa cache and live-crawl request settings. Inspect per-URL Contents
  statuses separately from HTTP status and preserve cost evidence on a failed
  extraction. Keep coverage unknown when the backend cannot establish it.
- Define independent optional managed-config entries for search and fetch.
  The selected adapter resolves its own credential references at open.
  Disabled tools are omitted from the catalog. The launcher provides the
  environment in both standalone and acp-client deployments. Saved config
  and exported session files carry only backend choices and references.
- Define paid dispatch evidence and optional result usage in the existing
  invocation lifecycle. Commit result and known usage together. Specify how
  the inspector distinguishes an invocation that did not dispatch a paid
  request, one with a provider estimate (including zero), and one with unknown
  cost. Commit the resolved backend, operation and paid classification with
  dispatch evidence before issuing a request. An interruption, timeout or
  crash after that commit can leave cost unknown, even after reopening with
  another backend. Use one usage record or projection per existing invocation
  ID. Pin archive
  compatibility and legacy behavior before any storage schema change.
- Define HTTP transport validation, cancellation and error behavior for
  the direct backend. A connection uses a validated public address for the
  initial request and each redirect. Pin how the transport binds validation
  to the actual connection, follows redirects and bounds decoded bodies while
  reading. Specify an injected fixture transport for test assembly. Keep
  fixture endpoints and any test-only address policy out of production
  configuration. Keep JavaScript rendering, PDF extraction and automatic paid fallback
  outside the initial implementation.

Publish a numbered contract decision and review it before implementation.
The initial tool cost evidence is independent of billing-grade model usage.

## G2b · Hosted adapters and usage

| Area | Proposed changes |
| --- | --- |
| Tools | Add definitions, validators and provider-neutral results in `src/capabilities/tools/web/`. Keep the Exa adapter in that directory and use the checked local dispatch introduced in Gate 1. |
| Configuration | Extend `src/contracts/config-permissions.ts`, `src/runtime/config/managed.ts`, and the existing portable configuration paths. Wire standalone and stdio through the same registrations and keep secrets out of returned errors and diagnostics. |
| Usage | Extend the runtime tool outcome and storage contracts in `src/contracts/`. Use existing dispatch and result persistence in `src/state/storage/`. Add focused invocation inspection in `src/interfaces/inspector/` through the existing read projection. The model receives the tool content. |
| Tests | Add adapter fixtures and managed-config, dispatch, restart and inspection coverage in `src/native-harness/test/`. Extend the Gate 1 scenario in `test/native/fixtures/` and run it through the root rehearsal harness. |

Assert no provider call for unavailable, malformed or denied calls. Cover a
successful and empty search, result and byte bounds, sources, known clipping,
unknown extraction coverage, deadlines and cancellation. Test one provider
request per invocation. Verify usage for success, paid failure, an explicit
zero estimate and a lost result after dispatch. Reopen SQLite and check that
usage stays attributed to the original backend after changing configuration
and that a lost result never reissues a request.
Verify session-file and inspector output with a synthetic credential value.

## G2c · Direct HTTP fetch

Give the HTTP adapter separate file ownership. The Exa implementer owns hosted
adapters, managed setup and usage plumbing. Both use the reviewed fetch contract.
The HTTP adapter starts with public HTML and plain text and reports unsupported
page types. Test address and redirect validation, cancellation, transfer bounds,
readable text extraction, and output bounds offline at the transport seam.
Verify direct fetch works with no Exa credential.

Keep an offline comparison corpus with the expected readable blocks and source
attribution. Use an explicitly enabled live comparison on a small shared URL
set to measure coverage, clipping, failure, latency and paid requests. Include
plain text, article pages, noisy HTML, and representative unsupported pages.
Turn stable failures into offline regressions and keep improving the extraction
adapter as an independent workstream. Exa remains the initial default for
configured hosted fetch. A default change follows evidence from the corpus.

## G2d · Cumulative script and release gate

Append a search-to-fetch phase to the Gate 1 fixture. The scripted model emits
a real `web_search` call, opens a stable fixture URL returned by search with
`web_fetch`, and cites the source. Keep model calls deterministic. Inject
fixture responses at the provider transport in the stdio test assembly. Assert
that the next inference receives parseable results with source URLs, text and
fetch clipping metadata intact. Include a result near the serialized byte
limit. Record exact script consumption and inspect per-invocation usage. Run a companion
configuration with direct HTTP fetch only and verify that it reports no paid
provider charge.

Run focused tests, both typechecks, the cumulative scenario over real stdio,
and both full suites. Get independent review of the exact revision. Run one
separately authorized live search and fetch from development chat before
claiming live validation. Record offline acceptance and live status separately.
