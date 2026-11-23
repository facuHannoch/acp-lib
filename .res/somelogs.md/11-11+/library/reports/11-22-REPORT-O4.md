# O4 worker permission forwarding

Implemented on `orchestrator` after bringing in alpha `3c28130` through merge `8575a10`. The work follows the latest orchestrator-status brief and the approved one-line exception in `agent-session.ts`.

## O2 follow-up

`efb3aae` carries a copy of callback `policyNames` in the conversation actor and passes it into the assignment port at the existing dispatch boundary. Delegation policy composition intersects use, scope and redirect, and takes the smallest specified maxOpen. The caller supplies defaults for an empty list. Worker permission composition matches the incoming request independently against each policy's own rules and fallback, then uses R2's restrictive ordering. This preserves exact kind and command semantics when two policies match different fields. Tests cover policy composition, provenance, same-giver steer with a redundant redirect, and stable busy age.

A restricted conversation sees workers it opened or currently gives work to. Its no-free-slot listing is filtered the same way. A scoped actor that may use workers can open one subject to maxOpen. The original opener remains visible even after an accepted redirect. A same-giver redirect follows ordinary steering with no retargeting or redirect permission check.

Clean gate of `efb3aae` passed typecheck and 1,529 tests in 142 files in 109.16 s, with all 35 snapshots unchanged. Logs are in `/tmp/acp-o1-o2-followup.MLn7Dk`.

## Conversation bridge and worker path

`ea33f22` is the reviewable coordinator bridge. The existing session initializer adds `this` as the WeakMap key on its original line, with a lazy reader for the giving conversation's runtime permission options. The event's source field is a worker handle and conversation ID. A forwarded request has no receiving turn ID. It uses the existing R3 requested and resolved events, answer claims, timer and abort path. The worker ACP ingress time survives option filtering. An unrelated giver turn ending leaves the forwarded entry open. Giver stop or worker abort closes it.

`8da9dc7` installs the assignment actor's handler on each dispatched worker message. Worker runtime policy enters the handler even if the Agent's inherited policy allows requests by default. The handler evaluates the actor's worker policies first and answers automatic allow or deny directly using R2's option selection. Ask uses the live giving conversation's coordinator. The Agent wiring passes an in-memory lookup to find the giver without opening another provider. A missing giver refuses, and a headless giver emits the request and immediate refusal without a deadline. Consumer-started work also refuses asks because it has no giving conversation.

The offline ACP fixture verifies automatic allow and deny, consumer answers with no receiver turn running, the worker source and ingress deadline, expiry, headless refusal, and one cancellation when the giver stops. It checks the exact option reaching ACP and rejects repeated answers.

## Persistent-grant options

`a7f0bbd` preserves `allow_always` on forwarded asks only when the trusted actor attests owner authority. Policy names and redirect authority grant no owner status by themselves. The non-owner's filtered list governs both display and answer validation. The future callback route must supply owner attestation when it can establish it. Automatic allow continues to prefer `allow_once` and fall back to `allow_always` when necessary, independently of the forwarded-ask filter. Tests cover both owner states, a rejected hidden answer with a subsequent valid answer, and automatic fallback.

`agent-session.ts` stays at 4,564 lines. The Agent wiring changed by one line, and the manager is 1,081 lines. No native host, worker-delivery repository, or snapshot source changed. No live provider was used.

## Clean gates

| Code commit | Full offline suite | Logs |
| --- | --- | --- |
| `8da9dc7` | 1,535 tests across 143 files, 128.86 s | `/tmp/acp-o1-o4-step1.6zzoSC` |
| `a7f0bbd` | 1,538 tests across 143 files, 136.86 s | `/tmp/acp-o1-o4-step2.YnpUI8` |

Both clean archives passed typecheck and all 35 snapshots. Their A1 snapshot hashes matched the baseline.
