# Web search and page fetching

Date: 2026-11-22

Status: Proposed for M2. Define the rest of the initial tool set before starting implementation.

## Scope

Give the agent two tools for public web research. Exa is the first backend for
both tools. The harness process calls Exa over HTTPS through its existing tool
execution path. Standalone chat and acp-client use the same implementation.
The tool contracts expose web results independently of the backend.

## Tool contracts

| Tool | Arguments | Successful result |
| --- | --- | --- |
| `web_search` | `query`, a non-empty string | A ranked list of results with title, URL, and short excerpt when available. An empty list is a valid result. |
| `web_fetch` | `url`, a single public HTTP(S) URL | The source URL, title when available, readable text, `truncated`, and `coverage`. |

The adapter calls Exa `/search` with highlights and `/contents` with bounded text
for a single URL. Keep the number of search results and the amount of text
bounded before handing the result to the model. The operator controls these
limits and the request deadline. Record initial defaults in
[Business rules](../../BUSINESS_RULES.md) when implementation is planned. The
fetch tool can open a URL supplied by the user or returned by search. Returned
page text and excerpts are external data, with source URLs retained for citations.
`truncated` indicates known clipping, whether at the backend or in the harness.
`coverage` describes the extraction before clipping. It is `full` when evidence
supports that the backend extracted the full readable page, `partial` when the
extraction is known to be incomplete, and `unknown` when the backend gives
insufficient evidence. Reaching a backend cap without a reliable clipping signal
does not establish full coverage.

Return a complete structured preview whose serialized UTF-8 content fits the
context builder's current 2 KiB inline tool-result limit. Budget structural
fields, source URLs, and JSON escaping before filling excerpts or page text.
Shorten text on a valid UTF-8 boundary and set `truncated` for known fetch
clipping. For search, reduce the number of hits when needed. If the required
fetch metadata alone cannot fit, return a small typed failure. Larger retained
results through `read_tool_result` need a separate retention contract.

The initial Exa fetch policy allows cached content with live crawling when
cached content is unavailable. The contract decision pins the explicit Exa
request options and acceptable cache age. A successful API response with a
failed status for the requested URL is a tool failure. Preserve any reported
request ID and cost even when extraction fails.
[Exa Search API](https://exa.ai/docs/reference/search) ·
[Exa Contents API](https://exa.ai/docs/contents/quickstart)

## Independent HTTP fetching

When implementation starts, assign a separate agent to build a direct HTTP
backend for `web_fetch` in parallel with the Exa adapter. Select the fetch
backend independently of search. Both backends use the same tool contract,
permission checks, cancellation, and result limits. Keep Exa as the initial
default and comparison backend while the direct fetcher is evaluated.

Start with public HTML and plain text. Bound response size, redirect count,
and request time. Validate the destination for the initial request and each
redirect. Bind validation to the address actually connected to and apply a
decoded-body cap while reading. Keep provider credentials out of requests to
source sites. The contract decision pins raw and decoded limits, redirect
handling, and cancellation across connection and body reads. With Exa the harness connects to
Exa's API and Exa performs the fetch. Report unsupported pages explicitly. Include
JavaScript-heavy pages and PDFs in the comparison to see where a hosted fetcher
still adds value.

Maintain a repeatable set of URLs and compare usable text, source attribution,
failures, latency, and paid requests. Turn extraction failures into offline
regression fixtures and rerun a small live comparison after meaningful changes.
Use the results to decide when direct HTTP can become the default. Automatic
paid fallback requires a separate decision so it is visible in policy and cost.

## Configuration and credentials

Managed session configuration has independent optional entries for search and
fetch. Each enabled entry selects a backend. Omit an entry to disable its tool.
Exa uses an environment variable reference, `EXA_API_KEY` by default. Direct
HTTP fetch can be enabled on its own and requires no provider credential. Reuse
the pattern in [configuration and permissions](../../_/11-19-config-permissions/SPEC.md).
Validate and resolve only credential references for selected backends when
opening the session. For a missing or empty required key, report the variable
name in the configuration error.

For standalone use, the launching shell or service supplies the environment.
For acp-client, the launcher supplies the environment to the native subprocess,
including when it runs in a container. The saved configuration and session
export carry backend choices and credential references. Authorization headers
and secret values stay out of tool results, inspector output, and logs. An imported session
uses the credential available in its destination process.

## Execution and metering

Keep the Exa adapter in `capabilities/tools/`. Standalone and stdio compose
the same harness-owned registrations, each with a definition, validator, and
executor. Both tools use the existing permission gate, turn and channel
ownership, dispatch record, cancellation, and paired results. Apply the existing
availability and argument checks to these registrations before asking for
approval and recheck at dispatch. Calls to disabled tools and invalid arguments
receive a paired rejection without a provider request. Report actionable errors
for rate limits, provider errors, deadlines, and unavailable page content. Pass interruption through to
the request. The initial adapter makes one provider request per invocation,
with no automatic retries. An operator or model can decide whether another
explicit call is worthwhile.

Record the selected backend, operation and paid-request classification
durably with dispatch evidence before issuing the request. Recovery uses that
record even when the configured backend has changed. Extend the shared
execution result with optional usage metadata. Commit known metadata in the
same transaction as the paired result, keyed by the existing invocation ID.
Record the provider request ID and reported USD cost when supplied. Store Exa's `costDollars.total` as a
provider-reported estimate, including when the response yields a paired tool
failure such as unavailable page content.

Distinguish no paid request, provider-reported estimate, and unknown cost from
a dispatched paid invocation. Permission denial and argument rejection happen
before dispatch. Direct HTTP has no paid provider charge. When a crash or
interruption wins before the result and metadata commit, use the durable dispatch
record to report unknown cost for the paid invocation. A timeout without cost
evidence is also unknown. An explicit reported zero remains zero. Keep one
meter entry per invocation across restart.

Expose metering as inspection metadata for the channel and turn. Keep it out of
the text returned to the model. Model token accounting remains in the model-call
records. OpenRouter cost capture, spend budgets, and invoice reconciliation are
follow-up work. Pin any new public metering or storage fields in a contract
decision before implementing them.

## Acceptance

1. An offline fake API verifies both tool calls, normalized results, bounded
   output, clipping and extraction coverage, and paired errors. The cumulative
   stdio rehearsal runs real tool dispatch with injected fixture responses at
   the provider transport. Inspect the next inference for parseable previews,
   source URLs and clipping metadata. Disabled tools
   are absent from the offered set. Attempt a disabled or malformed call under
   `ask` on standalone and stdio and check that neither prompts nor dispatches.
2. Verify policy denial, cancellation, unknown cost on deadline, and retained
   cost for failed extraction. Reopen SQLite after a committed result and after
   process loss between dispatch and result commit. Reopen the latter case
   with a different backend configured. Verify the original attribution, one
   meter entry per invocation, and unknown cost. Verify explicit zero and a
   failed URL inside a successful Contents response with cost evidence.
3. Enable HTTP fetch alone with no Exa key. Verify backend choices through
   export and reopen. Verify that the saved config, session file, and inspector
   omit credential values. For direct HTTP, test public and blocked destinations,
   including a redirect to a blocked address, and decoded-body overflow.
   A blocked destination receives no request. Test fixtures are injected by
   test assembly. Production configuration keeps normal destination checks.
4. Run a live search and then open a selected result through the existing web
   chat. Verify source links, tool lifecycle, and reported costs in the inspector.
   Keep the live check outside the automated suite.
