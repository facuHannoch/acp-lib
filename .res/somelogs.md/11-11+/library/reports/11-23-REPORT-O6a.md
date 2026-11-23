# O6a delegation tools and the O5a follow-up

## O5a follow-up

`20af857` makes the first drop of a worker whose conversation was deleted directly succeed. The drop tombstones the worker, releases any cached slot, emits one `worker_dropped` event and returns `{ providerDeleted: false, checkpointsDeleted: 0 }`. The regression uses a direct conversation delete and then drops the worker before check, list or send can reconcile it.

The changelog covers `agent.workers.delete` returning `DeleteConversationResult`, `orchestrator.workers.idleStopMs` and the idle stop event. It also clarifies that ordinary permission requests require a turn ID and that a forwarded non-owner request hides and rejects `allow_always`.

## O6 step 1

`d0a927b` adds `delegate`, `check`, `list` and `stop` to the fixed native function catalog when both the harness and orchestrator are configured. The existing function registration declares their handler names in `initialize` and supplies the catalog on `session/create` and `session/open`. Those names are reserved in that configuration. A collision with a consumer tool throws at Agent construction, and all other consumer tools continue through the same catalog and callback host. The delegate description explains `redirect` and `assignment: "new"`. Omitting the worker handle opens a worker. Supplying it sends to that worker. The open and send results return through the tool callback as soon as work is queued.

The callback identifies the giving conversation by its channel and the invocation by its wire ID. The sender lookup reconciles the callback's own channel and turn ID, then looks up the first taken item in the running turn's recorded order and reads its stored sender. A turn that takes several participants' items keeps the first taken item's attribution, including after additional takes. A turn with only notices uses the first notice's stored source, or the harness's `host` attribution if no source was set. With no confirmed sender, the route declines. Model arguments play no role in sender attribution or policy.

The call's frozen `policyNames` determine authority independently of the sender. Each name must have an entry in `orchestrator.policies`. Delegation limits intersect, and worker permissions are matched within each policy before the existing most-restrictive reduction. An explicit empty array uses the configured defaults. Unconfigured delegation defaults refuse use, and worker permissions default to ask. Missing policy metadata is rejected by the harness client, and missing or unknown names are also declined by the route. `orchestrator.ownerPolicies` defaults to `["owner"]`. Every name in a nonempty list must be an owner name to grant owner authority.

The offline in-process harness test uses a consumer callback as a barrier to add a guest notice to an owner turn before delegation. It checks the registered catalog, all four callbacks and their outputs, busy status before stop, both contributing policy names, and attribution to the first taken input from Alice. The guest policy restricts scope and redirect, makes the combined actor a non-owner, and makes a worker permission ask despite the owner policy's allow. Route tests also check explicit empty-list defaults, owner recognition, missing and unknown policy names, missing sender evidence and a consumer tool collision.

## Native wiring still held

This commit changes only `src/native/functions.ts` under `src/native/`. The other production files are `src/agent.ts` for the functions configuration and `src/orchestrator/{config,delegation-sender,native-delegation}.ts`. The test uses the real in-process harness with a stand-in host callback that supplies the optional `takenSender` lookup. Until production supplies that lookup, native delegation calls decline with `delegation_sender_unavailable`.

After the worker-delivery merge, a separate commit will pass `() => takenSender(client, call.channel, call.turnId, signal)` to `functions.call` at the host's `serveFunctions` callback. This captures the actual connection even for callbacks arriving during open. That commit needs the production-host in-process gate. O6 steps 2 and 3 wait for the reply path.

## Clean archive gates

| Commit | Full offline suite | Logs |
| --- | --- | --- |
| `20af857` | 1,547 tests across 143 files in 109.22 s | `/tmp/acp-o1-o5a-followup.BpTqzs` |
| `d0a927b` | 1,549 tests across 144 files in 104.97 s | `/tmp/acp-o1-o6a.5JfVUo` |

Both archives passed typecheck and all 35 snapshots. The A1 snapshot SHA-256 was identical across both archives and before and after each run.
