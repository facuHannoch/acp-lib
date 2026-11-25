# OpenCode Go implementation plan

Status: Native provider implemented. Upstream template and gateway acceptance
are pending. See the [amendment](SPEC.md).

1. **Contract and config.** Record the contract decision. Add the preset
   to `src/contracts/config-permissions.ts` and its validation and secret
   resolution to `src/util/config.ts`. Wire the public SDK and reuse the
   existing managed-config round trip. Extend checkpoint key handling in
   `src/runtime/config/inference-key.ts`.
2. **Request binding.** Add the preset to the Chat Completions adapter in
   `src/capabilities/model/openrouter-stream.ts`. Assemble it at the
   native protocol and standalone CLI entry points. Use the session and
   channel IDs those entry points already have to bind the routing header.
   Carry safe provider failures through the model runner and ACP-client
   turn outcome so callers can diagnose setup and service failures.
3. **Offline acceptance.** Exercise the exact endpoint, Bearer auth and
   User-Agent, redirect refusal, streaming tool calls, paired results and
   usage. Verify header stability across turns, retries and reopen, and
   isolation between channels. Check sanitized 4xx and rate-limit output,
   normal channel recovery, archived credential references, and unchanged
   legacy compatibility keys. Run both typechecks and the regression suites.
4. **Template and live acceptance.** Migrate the upstream native template
   to the preset after its ACP-client dependency exports the new config arm.
   Map the existing default Go source to `opencode-go` in
   `agents-core/src/agent/chat/native-config.ts`, preserving the configured
   upstream model, environment variable name and context budget. Launch
   through the actual gateway path with a Go-enabled
   key. Require the native model to list connectors, call a harmless fixture
   connector, receive its result, and finish the turn. Record the gateway
   verdict separately from the already successful direct inference probe.
