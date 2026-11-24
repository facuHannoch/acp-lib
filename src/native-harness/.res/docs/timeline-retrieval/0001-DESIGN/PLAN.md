# Timeline retrieval implementation plan

Date: 2026-11-24

Status: Ready for contract review. Base: integrated `alpha` at `7fde493`.

The first tools gate delivers `search_timeline` and `read_message` through
the same native registration and dispatch path in development chat and stdio.
A scripted model searches a second channel's old decision, opens the source
with neighbors, and answers with the original attribution.
[Timeline retrieval spec](SPEC.md)

## Findings from the current code

- `src/index.ts` assembles tool offers and dispatch. Host catalog entries
  already check the current offer, availability and arguments before approval.
  Direct built-ins and supplied executors currently follow a different branch.
  Extract the small checked native registration behavior for the two new tools,
  with local handlers. Reserve their names even when disabled. Keep existing
  host callbacks, the result reader, and debug and notice behavior compatible.
- `OperatorStorageReads.readTimeline` already supports channel and sequence
  ranges. Operator message projection has eligibility and ID rules. Reuse
  those rules for search, lookup and neighbors. Add focused lookup for each
  supported message ID where the current storage port lacks it.
- The bounded context pipeline currently puts completed tool exchanges into
  historical projections. Retrieval exchanges need to remain paired in the
  active turn and inspector, then be excluded as complete exchanges from
  later inference. A mixed assistant message may contain other calls or
  assistant text that must survive the projection.
- `start --script` swaps the model and can assemble configured tools.
  `test:scenario` currently wires an echo-only executor. The root rehearsal
  already drives a real acp-client host over stdio. Reuse those paths as
  described below.

## G1a · Contract review

Record checked native registration, focused reads, and retrieval projection
semantics before runtime changes. Pin text eligibility, token normalization
and case rules, deterministic candidate ordering and tie-breaks, and the
ranking guarantees shared by memory and SQLite. Define query, candidate,
neighbor and response byte limits, and when a partial result is reported.
Ensure index tokenization produces a conservative candidate set for the
specified tokenizer. Explicitly cover Unicode, diacritics, punctuation and
case validation in fixtures. Keep FTS expressions internal.

Define point ID lookup and window cursors that carry a fixed timeline revision
and verify the target and window on every page. Use the existing operator IDs.
Pin the SQLite migration, recovery and archive strategy for a derived index.
Check FTS5 on the supported Bun environment. The reviewer signs off on the
contract revision before dependent work.

## G1b · Implement and verify

| Area | Files and expected changes |
| --- | --- |
| Tool assembly | `src/index.ts`, `src/contracts/tools.ts`, and `src/capabilities/tools/runtime/` for checked registration and local dispatch. Use a small `timeline/` directory under `capabilities/tools/` for definitions, validators and handlers. |
| Storage | `src/contracts/storage.ts`, existing operator read/projection helpers, and `src/state/storage/{engine,memory,sqlite}.ts`. Index eligible committed text in the same transaction as the timeline write. Rebuild only where migration, recovery or import requires it. |
| Context | `src/capabilities/context/` and the focused inference read projection as needed. Filter retrieval calls and results together before historical window budgeting. Keep the canonical trace and active exchange. |
| Entry points | `src/interfaces/cli/` and stdio session assembly. Run checked tools through the same configuration and admission path with live or scripted models. |
| Verification | Harness storage conformance and focused tool/context tests. Root native rehearsal for the real-stdio consumer run. |

Acceptance covers both adapters on a common corpus and includes matched and
unmatched cases, case-sensitive search, attribution, ranking and equal-score
ordering, partial results, eligible text only, long messages and paged
neighbors. Concurrent appends cannot move an existing read window. Reopen,
migration and archive round-trip preserve IDs and retrieval. On a 10,000-entry
SQLite timeline no retrieval call takes a session snapshot or scans intervening
messages to resolve an ID. Report common-term ranking cost separately from
the cap on verifying candidates.

Under an ask policy a malformed or disabled invocation creates one paired
rejection and no approval or execution. Policy denial prevents execution.
Test normal dispatch and cancellation, including a subsequent turn that retains
the original messages but omits the retrieval exchange. Inspect the stored
call and result to confirm the exchange remains available to operators.

## G1c · Growing end-to-end script

Add one cumulative fixture under `test/native/fixtures/` and run it through
the existing rehearsal harness over real stdio. Keep the time-based load
rehearsal and the focused echo smoke test usable. The cumulative scenario
uses completion barriers between phases and exact model record consumption.
The script supplies model decisions. Real tool dispatch, storage, policies,
events, and result pairing still run. Later phases may use fixture provider
endpoints, runner workspaces, or a controlled clock at the edge.

For the first phase, send a decision and a correction on channel A, then on
channel B script a real search, a real read with neighbors, and a sourced reply.
Use stable fixture input IDs for the scripted read. Assert that search returned
that ID and the expected channel, and that the real read result was visible to
the next inference. Avoid fixture interpolation or a new scenario language for
this gate. If assertions need access to an attempt, attach them to the existing
scenario observation or durable tool trace.

Make the reusable script-mode assembly offer the normal configured tool
catalog, with optional tools enabled by the fixture's safe config. Verify the
first phase over stdio and document how to try it in development chat. Future
gates extend this fixture when their tools land. Each addition must assert an
observable real tool result or effect and exact consumption. Focused tests
continue to cover edge cases.

## Submission

Submit the contract SHA first and the runtime SHA after approval. Include
both typechecks, focused storage, tool and context results, the cumulative
real-stdio run, and full harness and root results. The reviewer reruns the
key checks on the exact runtime revision. Integration follows review.
