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
[Exa Search API](https://exa.ai/docs/reference/search) ·
[Exa Contents API](https://exa.ai/docs/contents/quickstart)

## Independent HTTP fetching

When implementation starts, assign a separate agent to build a direct HTTP
backend for `web_fetch` in parallel with the Exa adapter. Select the fetch
backend independently of search. Both backends use the same tool contract,
permission checks, cancellation, and result limits. Keep Exa as the initial
default and comparison backend while the direct fetcher is evaluated.

Start with public HTML and plain text. Bound response size, redirect count,
and request time. For each connection, including every redirect, the direct
transport must connect only to a validated public address. Keep provider
credentials out of requests to source sites. With Exa the harness connects to
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
the pattern in [configuration and permissions](../../11-19-config-permissions/SPEC.md).
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

Extend the shared execution result with optional usage metadata. Commit known
metadata in the same transaction as the paired result, keyed by the existing
invocation ID. Record the provider, operation, provider request ID when supplied,
and reported USD cost when supplied. Store Exa's `costDollars.total` as a
provider-reported estimate, including when the response yields a paired tool
failure such as unavailable page content.

Distinguish no paid request, provider-reported estimate, and unknown cost from
a dispatched paid invocation. Permission denial and argument rejection happen
before dispatch. Direct HTTP has no paid provider charge. When a crash or
interruption wins before the result and metadata commit, use the durable dispatch
record to report unknown cost for the paid invocation. A timeout without cost
evidence is also unknown. Keep one meter entry per invocation across restart.

Expose metering as inspection metadata for the channel and turn. Keep it out of
the text returned to the model. Model token accounting remains in the model-call
records. OpenRouter cost capture, spend budgets, and invoice reconciliation are
follow-up work. Pin any new public metering or storage fields in a contract
decision before implementing them.

## Acceptance

1. An offline fake API verifies both tool calls, normalized results, bounded
   output, clipping and extraction coverage, and paired errors. Disabled tools
   are absent from the offered set. Attempt a disabled or malformed call under
   `ask` on standalone and stdio and check that neither prompts nor dispatches.
2. Verify policy denial, cancellation, unknown cost on deadline, and retained
   cost for failed extraction. Reopen SQLite after a committed result and after
   process loss between dispatch and result commit. Verify attribution, one
   meter entry per invocation, and unknown cost in the latter case.
3. Enable HTTP fetch alone with no Exa key. Verify backend choices through
   export and reopen. Verify that the saved config, session file, and inspector
   omit credential values. For direct HTTP, test public and blocked destinations,
   including a redirect to a blocked address. A blocked destination receives no
   request.
4. Run a live search and then open a selected result through the existing web
   chat. Verify source links, tool lifecycle, and reported costs in the inspector.
   Keep the live check outside the automated suite.
