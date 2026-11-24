# Handoff: upstream agents-core acceptance for native MCP ("W18-style")

Status: UNASSIGNED. Raised 2026-11-24 by core-p after haurness-l's M4 clarification. The acp-client lane (`m4`, cod2b-t) runs
independently. This item needs an owner in the agents repo.

Where: `/home/ffacu/q/apps/libs/agents/agents-core/src/harness/launch/` (a separate repo). `gateway.ts` there is existing Codex
gateway handling; callers include `agent/chat/session-spawn-inputs.ts` and `session-delivery/prepare.ts`. No pre-existing test is
named W18 and no upstream owner is known.

Acceptance ("W18-style", from the harness spec): the upstream agents-core launch path creates a REAL native session through
acp-client with
1. one deterministic agents-tools-style stdio MCP server and one loopback Streamable HTTPS fixture;
2. both servers' tools discovered and called;
3. a guest denied (policy by NAME: owner `{fallback:'allow',tools:{},mcp:'allow'}`, guest `{...,mcp:'deny'}`; the launcher selects the
   policy per input through the authenticated host path, never from participant ids or display labels);
4. after reconnect/reopen, `mcpRuntimeHeaders` reapplied ONLY to the configured endpoint (the launcher is the only party that
   supplies the header material, at every executable create/open);
5. no secret value in durable or diagnostic surfaces (SQLite, harness home, logs, events, errors).

Not certified by this fixture: real agents-tools / door approval semantics.

Dependencies: the acp-client `m4` branch (alpha + harness M3 `bac3e29`; adds the runtime headers option, capability and status
exposure). Alpha stays untouched until haurness-l releases it.

Owner and run: to be assigned by the user (the agents-core launcher maintainer). core-p coordinates: sends the exact acp-client
SHA and the API names (once `m4` reports) and collects the result.
