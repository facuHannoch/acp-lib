# Implementation plan for the managed inspector

Status proposed. See [SPEC.md](SPEC.md) for the public behavior and acceptance
criteria.

## 1. Define the launch and wire contract

- Record the additive native protocol decision in `.res/decisions/`. Add
  `InspectorStatus` to the harness contracts and re-export it through
  `src/client.ts`. Add the optional field to `OpenResult` in
  `contracts/operator-controls.ts` and `StatusResult` in
  `contracts/protocol.ts`. The MCP and web status projections in
  `interfaces/protocol/server.ts` show where to expose the new field.
- Parse the three trusted environment settings once in
  `interfaces/cli/serve.ts`, using a parser next to the inspector server.
  Pass the parsed result into `createScriptedServer()` in `src/testing.ts`,
  which currently assembles both real managed stdio sessions and fixtures.
  The parser represents disabled, valid and invalid settings explicitly.
  Omitted port disables inspection. Validate wildcard authority before
  attempting any bind.
- Keep `serve(home)` and native create/open request shapes as they are. Use
  the existing launch environment in ACP-client. Verify
  `NativeHarnessHost.status()` preserves the new field on the host path and
  after an executable reopen.

## 2. Reuse the existing inspector and capture hooks

- Extend `interfaces/inspector/server.ts` with managed bind options. Preserve
  the positional port argument used by development startup and its tests.
  Reuse the same HTML, GET routes, live event stream and no-store responses.
  Compare Host with the actual bound loopback authority or the configured
  wildcard authority. Make the HTML a build-time asset if the compiled
  binary cannot serve it through the existing `Bun.file` lookup. Check both
  the source runner and the compiled entry.
- In `src/testing.ts`, create the existing inspection projection from
  `interfaces/inspector/state.ts` using the effective prompt and the live
  session's storage reads. Assemble the pre-turn tool list from the same
  built-in definitions and configured callback, web, and MCP catalogs the
  managed session receives. Use the actual inference offer for per-turn
  tool details. Inspection must have no effect on authorization or dispatch.
- Feed `captureContext` and `observeModelCall` in `createSession()` and use
  the invalidation subscriptions in `interfaces/inspector/observe.ts`.
  Compose with the existing scripted-fixture context observer instead of
  replacing it. Keep captures and subscriptions inactive while the inspector
  is disabled, unavailable, or stopped.
- Join managed request and response captures to the current channel, turn,
  and model attempt. The compatible gateway and OpenRouter attempt factories
  already accept request observers in `capabilities/model/openrouter-stream.ts`.
  Add the equivalent body-only hook to `inferenceRelayAttempt()` and feed the
  scripted model's input at its attempt boundary. Capture final response
  events as they pass through each attempt wrapper. Preserve the existing
  stream and retry behavior, and keep the inspector's current capture bounds.
  Redact exact resolved credential echoes and inline image bytes before
  retaining captured content. Never pass authorization headers to the
  inspector. Run canaries against the managed capture paths, including
  user-visible request and response details.

## 3. Own binding and shutdown at the managed session boundary

- Give the managed assembly an inspector resource with start, status, and
  idempotent stop. Expose it on `OpenedSession` in
  `interfaces/protocol/server.ts`. Bind once on successful executable create
  or open after fallible session setup and before building the result.
  Convert a failed bind to fixed status locally so the open can complete.
  Report the existing resource on repeated open or status requests.
- Use one cleanup path from open rollback, explicit stop, successful
  conditional stop and endpoint disposal. The conditional stop branch
  currently returns directly from `session.reminders.conditionalStop()`.
  Await inspector cleanup only when the outcome says it stopped. Terminate
  live HTTP streams and detach observers before storage close, including
  on a transport failure. Suspension and refused conditional stop keep the
  inspector active. Check that `serve()` disposes the endpoint on stdin
  closure and on a failed stdio serve.

## 4. Verify through the real entry points

1. Extend the inspector HTTP tests for exact authority, invalid launch
   settings, read-only methods, and event-stream cleanup. Keep the
   development inspector tests as compatibility coverage.
2. Add a native ACP-client stdio scenario using the existing scripted rig
   in `test/native/support.ts`. Check disabled and unavailable status,
   simultaneous port-0 binds, prompt and tool list before the first turn,
   Timeline and Channels after a turn, bounded capture details, and the
   stopped listener before the stop RPC resolves. Exercise successful and
   refused conditional stop, failed begin-open, and transport shutdown.
   Reopen a saved session in a fresh process and read the reported port.
3. Exercise the model capture paths with offline provider and relay fixtures,
   including vision and credential echoes. Verify both typechecks and the
   root and harness regression suites. Confirm installer and package output
   still contains the inspector assets needed by the public serve entry.
4. Pass the exact build and launch settings to agents-core. First run the
   compiled agents binary from a directory without the source tree. Then
   verify that the Docker launcher maps an isolated container listener to
   a loopback host URL, that direct mapping and proxy forwarding use the
   expected Host authority, and that the full inspector loads with live
   updates. The launcher owns the published URL and the webapp link.
