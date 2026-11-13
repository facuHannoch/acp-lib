# Rule: automatic approval prefers `allow_once`, and falls back to `allow_always`

Status: current behaviour, kept (owner, 2026-11-13). A RULES file documents how the library behaves and why; it is
not a change.

## The rule

When a permission request is approved automatically (a permission setting's level is allow, or today's
`defaultPermission: "approve"`), acp-client picks the request's options **by kind, never by position**:

1. `allow_once`, if the request offers it;
2. otherwise `allow_always`;
3. otherwise the request is refused (`cancelled`).

Code: `src/client.ts:1011` (`defaultOutcome`), `src/agent-session.ts:4973` (`defaultPermissionOutcome`). The
permission matcher (integration spec, Permissions; brief N0) keeps this rule.

## Why it matters: the fallback is an escalation

`allow_always` doesn't only approve this call: the harness writes a lasting rule into its own settings (Claude Code
does), so the same tool is approved in later sessions too, outside acp-client's control. Picking it automatically
means the library makes lasting policy on the consumer's behalf, whenever a request offers no `allow_once`.

## Why it is kept

Some harnesses offer only `allow_always` for some tools; without the fallback, a consumer that chose to auto-approve
would see those calls refused. Auto-approval is the consumer's explicit choice (the default is to refuse).

## If it changes later

Never pick `allow_always` automatically (refuse instead, or make the fallback a separate opt-in). That is a behaviour
change for consumers relying on approval of such tools.
