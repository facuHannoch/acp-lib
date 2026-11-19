# Configuration, policy and approval contract

## Problem and options

Tool instructions cannot enforce permissions, and pending inputs and notices
must retain the restrictions under which they were admitted. Choose durable
policy references and a synchronous dispatch gate. The older protocol proposes
harness-to-host permission callbacks; this increment instead uses an always-on
approval event plus an answer request keyed by request ID. It fits the existing
one-way notification and host request transports; it is an experimental subset,
not the older callback's wire shape. Disconnect explicitly closes this owner's
outstanding requests. No model-supplied text or tool argument grants rights.

## Configuration and persistence

- Version 1 config is `{version:1, system:string, model:{protocol:"scripted",
  script:string}, defaultPolicy:string, policies:Record<string,{fallback:
  "allow"|"ask"|"deny", tools:Record<string,"allow"|"ask"|"deny">}>}`.
  Names and script path are nonempty after trimming, names and exact tool keys
  are retained verbatim, duplicate/unknown fields and unknown policy references
  are validation errors naming the field. `tools` may be empty. `system` may be
  empty. No secret values or functions are stored. The scripted path is a
  destination resource under decision 0015; credentials in later providers are
  environment references, resolved at runtime, never copied as values.
- `config/validate` accepts `{config}` and returns `{valid:true}` or a typed
  `invalid_config` error with field and message, without opening a session or
  starting inference. The typed client exposes it. On create an inline config
  wins when supplied; otherwise the per-session `config.json` is required.
  On open a present sidecar wins; otherwise an explicitly supplied inline config
  is used, and otherwise the saved config is required. Both `session/load` and
  development open use saved config when neither inline config nor sidecar is
  supplied, for managed directories and explicit `--db` files. The
  open session owns a defensive copy, saved atomically with successful open;
  invalid sidecar, missing resource, incompatible stored references, or failed
  open leaves the previous saved config and session unchanged. Edits are read only
  at the next open. `session/load` needs no inline config for managed sessions.
  Managed path is `<home>/<sessionId>/{config.json,session.sqlite}`; IDs cannot
  escape the home. Default home is `~/.harness`, `--home` overrides it. The
  old flat managed path is not migrated; explicit development `--db` remains.
- Save active config with a created or opened session, and export the in-memory
  copy in the session-file payload. Import publishes config and snapshot as one
  unit; imported sessions open from it without a sidecar. SQLite and memory
  share the same rules. SQLite formatVersion 4 and logical archive revision 3
  add policy fields. Opening format 2 or 3 first applies its existing recovery
  rules, then publishes format 4. Adapter-level import still accepts logical
  archive 1. A session-file envelope still rejects archive 1; archive 2 and
  the scripted config without policy fields from `7e49bd5` migrate to archive
  3 and the legacy policy. The envelope stays version 1; new exports contain
  archive 3 and full ManagedConfig. Standalone JSON remains `invalid_archive`.
- Name the legacy policy `__legacy_allow`. An upgraded config sets
  `defaultPolicy` to that name and defines it with fallback `allow` and empty
  `tools`. Migrated channels have no channel policy; migrated items have no
  explicit policy, resolved `__legacy_allow`, and inherited `[]`. Accept the
  pre-0016 signature `JSON.stringify([kind, channelId, senderId,
  sourceChannelId ?? null, text])` during migration, then rewrite it to
  `JSON.stringify([kind, channelId, senderId, sourceChannelId ?? null, text,
  explicitPolicy ?? null])` under the existing SHA-256 encoding. New acceptance
  and archive 3 use only the extended signature. Omitted and null explicit
  policy are the same absence, so an unchanged retry still matches.
- On reopen validate every stored channel, item and inherited policy reference
  against the candidate config before enabling execution. Missing references
  produce an `incompatible` execution state without changing saved config or
  starting work; status, timeline and checkpoint reads still succeed. While
  incompatible, `acceptItem`, `beginTurn`, `resume`, and `resumeChannel` report
  `incompatible` and write nothing. Pending inputs and checkpoints remain
  untouched. The config may change rules for future turns. A checkpoint's
  fingerprint is the existing compatibility key (SHA-256 of
  `JSON.stringify([system, parsedScriptContent])`) plus definitions of its
  contributing policy names, canonically compared by sorted policy names and
  sorted tool keys within each policy. A changed contributing definition makes
  resume `incompatible` with no writes; unrelated policy changes do not block it.
  Compare only when that checkpoint would actually continue: session resume
  checks the channels it restarts; channel resume checks when the session is
  running. An individually suspended incompatible channel does not block session
  resume or change its checkpoint. Migration records the existing turn key and
  legacy allow definition, so an unchanged upgraded session can resume.

## Policy and identity

- Channel create with an omitted policy stores no channel policy. On edit,
  omitted leaves it unchanged, null clears it, and a string sets it. An unknown
  name is `invalid_policy`, with no change. Participant input accepts
  an optional trusted-consumer `policy`, never one derived from its text.
  Resolve explicit, then channel, then session default when accepting. Store
  `explicit` including absence and the resolved name. Dedup identity extends the
  existing signature with explicit policy or null: identical retry is answered
  before current policy validation, retains the original resolution even after
  edit, and a different explicit policy is `item_conflict`, even if equivalent.
- A notice is emitted with the actual source turn identity from the executor,
  not a model-provided policy or caller-supplied claim. In its acceptance
  transaction store the deduplicated union of all source turn taken items'
  resolved and inherited policy references, as well as the target policy
  resolved at acceptance. Inherited references propagate transitively to later
  notices. Reopen/export/import preserve them. A notice cannot grant rights the
  source lacked under the current open config. A waiting item contributes
  nothing until take; each taken item's resolved and inherited names contribute
  for the remainder of that turn, including subsequent notices. Tool-specific
  decisions combine as `deny > ask > allow`; exact override precedes fallback.
  Already-dispatched tools are unaffected; a fresh turn starts with its own
  taken inputs. Shared-history read access is unchanged.

## Approval and lifecycle ordering

- The gate evaluates immediately before each tool dispatch against the current
  taken-item policies. `deny` produces one paired tool result with code
  `policy_denied`, no dispatch and no `tool_call:started`. `allow` dispatches
  once. `ask` publishes an always-on `approval_requested` event containing
  `{requestId, channel, turnId, toolCallId, tool, arguments}`; IDs identify
  exact calls, including argument text, and are never reused during the server
  lifetime. One `approval/respond` request `{requestId, decision:"allow_once"|
  "deny"}` returns `{accepted:true}` only for the first live answer. Unknown,
  late or duplicate IDs return `not_found` and cannot dispatch. The client
  declares approval handling at initialize; no handler produces a paired
  `approval_unhandled` result without waiting. A disconnect closes its requests
  with `approval_disconnected`; timeout defaults to 10 minutes and closes with
  `approval_timeout`. Explicit deny produces `approval_denied`. These results
  include `{ok:false,code,message}`, explain no execution, and are recorded as
  the matching tool result before the loop continues. No skipped call emits
  `started`. Initialize keeps `callbacks` an empty array, rejecting any
  nonempty list, and adds optional `approval:boolean`: only `true` declares
  the connection to be the approval consumer. Without it an ask immediately
  closes as `approval_unhandled`; with it, disconnect closes its outstanding
  requests as `approval_disconnected`. An unanswered approval is never durable
  or executable on restart.
- Decision, lifecycle cancellation and dispatch are serialized without an await
  between the final cancellation check, grant consumption, `started` emission
  and invoking the executor. The linearization point is that dispatch step.
  A grant answers the request but is unused until that step; it is consumed once.
  If channel or session suspension wins first, close a pending request or discard
  the grant and record `approval_cancelled_by_suspension`, with no started event
  or effect. Any later ask in that finishing iteration gets the same paired
  result without opening a request. If dispatch wins first, the started event
  appears once and the running tool finishes under existing suspension rules.
  Suspension waits for the iteration, then completes or checkpoints normally.
  A later retry after resume is a new call and new request. A second channel
  continues while one turn awaits approval.
- Interrupt and stop cancel requests for their affected turns, fence grants and
  late answers, abort running tools and fence late results under decision 0014.
  An undispatched request is not added to `uncertainCallIds`: its tool did not
  run. A call that already emitted `started` retains decision 0014's uncertain
  effect semantics. No paired result is written after a turn has ended. Denial, timeout and disconnect
  cannot cause a dispatch. No request or grant survives a restart.

## Traces and verification

1. Accept ID `x` with no explicit policy under channel `A`; edit channel to
   `B`; retry identical `x` returns its original receipt and `A`. Retry with
   explicit `A` conflicts because absence and explicit override differ.
2. Source turn has taken `strict`, including `inherited`; its notice stores
   those names plus the target's resolved policy. Restart, take the notice,
   and evaluate the union for each tool; `deny` wins even if target allows.
3. Ask resolves allow-once. If suspend commits before dispatch, discard grant,
   record cancellation result and checkpoint; no started/effect. If dispatch
   commits first, emit started once, finish the tool and checkpoint. Late or
   repeated answer cannot start another call.

Run validation and typecheck at this contract gate, then the stage-specific
storage, scheduler, transport and end-to-end gates in the plan. Review each
named revision independently before starting its dependent stage.
