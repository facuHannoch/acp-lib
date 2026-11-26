# Managed inspector implementation log

## 1. Launch settings and native status

Completed the launch-only parser, decision 0043, and the optional
`InspectorStatus` contract. The public harness client and ACP-client expose
the typed status. The launcher owns the browser-facing URL.

**Verified.** Parser tests cover disabled, invalid port, and missing wildcard
authority. Real ACP-client stdio checks disabled, two concurrent port-0
binds, and occupied-port failure followed by a successful turn.

**Limits.** This covers local processes and the low-level HTTP Host check.
The consumer's Docker publisher and UI link have no integration run yet.

## 2. Full inspector and inference capture

Reused the existing HTML, Live Context, Timeline, Channels, model-call
details and live events. The managed session supplies prompt and tool
definitions before the first turn. Scripted and provider attempts feed the
same bounded inspector views. The inspection projection removes exact known
runtime credential echoes and inline image data while retaining context and
response details. The HTML uses a text import so it is bundled into a compiled
entry point.

**Verified.** Real stdio stacks load HTML, read prompt and tools before
inference, receive live events, and read a completed turn from Timeline,
Channels and model calls. The scripted capture test checks a known runtime
key echoed in request and response content and a synthetic inline image
payload. Existing development, relay and attachment tests cover their
ordinary paths. A standalone Bun-compiled executable importing the public
serve entry returned HTML and context from a temporary working directory.

**Limits.** The redaction test uses deterministic content rather than live
provider credentials. It does not exercise every provider and tool adapter
with inspection enabled. The compiled fixture is not the full agents binary.
HTTP responses were checked directly, without browser interaction.

## 3. Listener lifecycle

Binding happens after session setup. Repeated open and status reads report
the current listener. Explicit stop, successful conditional stop, open
rollback and endpoint disposal use the same cleanup. Cleanup detaches
observers and stops the listener with active HTTP streams before storage
closes. The managed stdio entry disposes the endpoint even if serving throws.

**Verified.** Real processes exercise explicit stop with an open event
stream, successful conditional stop with the RPC endpoint still live, and
EOF on a replacement process. The conditional-stop test verifies the
listener is closed when the stop result arrives and reopens the saved
session in a fresh harness.

**Limits.** Startup rollback and refused conditional stop are not separately
fault-injected with the inspector enabled. Docker restart is unverified.

## 4. Consumer handoff and regression verification

Updated the consumer guide with the launch opt-in, status fields, and
loopback and container setup. Local verification results are listed below.
The actual agents-core binary and Docker launch/link remain consumer gates.

- Root and harness `bun run typecheck` passed.
- Six final inspector-specific tests passed across unit, native stdio and
  ACP-client entry points. An earlier related run passed 23 tests including
  development, relay, and attachment regressions.
- `bun run pack:dry` includes the inspector HTML asset. The separately
  compiled serve fixture served both the HTML and the context API.

### Teardown correction

The first full combined run passed 2,419 tests and found one checkpoint
failure. Awaiting an absent inspector postponed storage release on the
inspector-disabled path. Endpoint disposal now waits only when the optional
resource exists. The failed checkpoint case and eight related provider
and inspector tests passed on the correction.

The corrected revision passed both typechecks and all 569 native harness
tests. The full combined suite was not rerun after the teardown correction.
