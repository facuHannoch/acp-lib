# Operation lifecycle

Provider turns, internal inference and adoption recaps now expose their current operation stage and
last output time. Silent inference requests fail with `OperationStalledError` (`code: stalled`), carrying
the silence phase, captured messages, operation ID and metering record. Agent-owned conversations
persist an error record and mark any partial assistant reply failed.

Cancellation answers pending permissions as cancelled, aborts the handler's optional second
`AbortSignal` argument, resends the notification halfway through the adapter's grace period, and
force-stops an unresponsive process. Cancelled prompt results expose `cancel: acknowledged | forced`.
Interrupt and steer results keep their normal cancelled behavior after a forced stop.

The next provider operation reconnects automatically after an exit or forced stop. It first loads the
same session; Agent-owned conversations can recover from a checkpoint under their existing recovery
policy, preserving the conversation object. Observe `state.providerConnection` and
`provider_reconnected` (`via: loaded | recovered`). Consumers that previously retired a disconnected
conversation can now keep it and send the next prompt normally. A failed reconnect is retryable on the
next operation. SessionManager's manual recovery after the library process itself dies is unchanged.

After a stall or error, explicit queue messages are held. Pending steers run after recovery with
`via: stall`; the next successful turn releases the held queue. Inspect `state.pendingHold`,
`pendingMessages[].heldBy`, and `message_held` / `message_released` events. With `busyDelivery: queue`,
every prompt sent after a failure joins the hold, so the conversation stays held until you send one prompt
with `delivery: steer` (or withdraw). Withdrawal still works.

Configure `AgentConfig.operationLifecycle` (or the same field on a detached conversation) with
`turns`, `internalInference`, and `recap`. First/next-output limits default to 120/180 seconds;
`false` disables an individual inference limit. Tools and permissions explain silence and suspend
those limits; optional `toolMs` bounds a tool. Adapter `cancelGraceMs` defaults to 30 seconds.
Control requests (initialize, new, load, list, delete, config, authenticate) have no deadline: they end when the
harness answers or the process exits.

Codex measurements on 2026-10-18 (three throwaway sessions, default model): first protocol output
8–12ms, longest observed tool-free silence 3260–4128ms, acknowledged cancel 32–72ms, and session load
514–621ms. Claude (three sessions): first output 3–15ms, silence 1989–4296ms, cancel 4–5ms, and load 828–848ms. These are short-history measurements and do not cover automatic compaction; conservative
defaults are retained. See `smoke-tests/test13-operationLifecycle/` for reproducible scenarios and results.

Known measurement gaps: OpenCode's default upstream refused ACP model calls under its free-tier
policy. Codex's permission smoke prompt did not generate a native permission request; the mock
permission scenario verifies cancellation and handler aborts. Initialization excludes launcher
preparation; downloads inside a spawned installer command still count unless moved into launcher
preparation. Turn-ending persistence beyond the existing message status remains the separate
requirement 3 referenced by the lifecycle spec.

Degraded PTY mode observes raw terminal output for visibility and keeps output silence deadlines
disabled by default because it has no ACP tool/permission signals. Explicit limits still apply there,
and cancellation remains bounded. Handoff operations use the target adapter's cancellation grace.

A separate Codex run with 24 additional short turns replayed 53 updates in 554ms (maximum replay gap
535ms, including initial wait). No automatic-compaction stress run was performed.
