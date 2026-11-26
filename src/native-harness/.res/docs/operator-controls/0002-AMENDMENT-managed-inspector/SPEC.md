# Managed native harness inspector

Date 2026-11-26. Status proposed.

This amendment extends the [operator controls](../0001-DESIGN/SPEC.md) with the
full existing read-only inspector web app for a native harness running
`serve --stdio`. The first acceptance target is a host-launched native agent.
Docker publishing and the consumer's Inspector link use the same contract.

## Launch configuration

The trusted launcher configures inspection in the harness process environment.
The inspector is off when `HARNESS_INSPECTOR_PORT` is absent. If present, it
must be a decimal integer from 0 through 65535. Port 0 lets the OS select a free
port. The default bind host is `127.0.0.1`. An operator can set
`HARNESS_INSPECTOR_HOST=0.0.0.0` for an isolated container network. The bind
host accepts these two IPv4 literals in this version. An empty or invalid
setting produces an unavailable result and opens no listener.

The settings are executable-only. Session config, validation, imports, and
exports carry no inspector settings, address, or captured inspection data.
The process writes only native protocol frames to stdout. Development
`start` keeps its existing inspector behavior.

## Native API

Native `session/create`, `session/open`, and `session/status` expose the
same optional typed `inspector` field. When inspection is disabled, omit the
field. When enabled, use one of these shapes.

```ts
type InspectorStatus =
  | { state: "listening"; host: "127.0.0.1" | "0.0.0.0"; port: number }
  | { state: "unavailable"; code: "invalid_config" | "bind_failed" }
  | { state: "stopped" };
```

The listening result reports the actual bound port. A bind failure reports
`unavailable` and leaves session execution usable. Error details from the
socket are excluded from the response. The ACP-client managed host exposes the
same typed status through `NativeHarnessHost.status()`. The initial create
or open result is also available through the native harness client.

The bound address describes the harness network. For a host launch, the
consumer can build `http://127.0.0.1:<port>/` from it. For a container launch,
the launcher owns the browser URL and uses the published host port or its
local proxy address.

## Views and access

Serve the same inspector page and routes as development mode. Include Live
Context, Timeline, Channels, model-call details, and live updates. Live
Context shows the effective system instructions and configured tool catalog
before the first turn. Channels includes offered tools and bounded request
and response bodies at the same level of detail as development mode. Reuse
the existing storage reads, capture bounds, and update notifications.
Capture and subscription work is enabled only for an active inspector.

Provider authentication headers and resolved runtime credentials are outside
the inspector payload. Keep known credential echoes and inline attachment
bytes out of captures before the inspector retains them. Preserve rich
debugging detail, including attachment metadata. The UI shows conversation
content and tool results, which may contain sensitive material supplied by a
user, model, or tool. Anyone with access to the inspector can read that
content. The HTTP interface remains read-only.

For host mode, accept only the exact bound loopback authority in the HTTP
`Host` header. A Docker launcher uses a known container port and publishes it
on host loopback. Wildcard bind mode requires
`HARNESS_INSPECTOR_PUBLIC_AUTHORITY` before opening a listener. A missing or
invalid value reports `unavailable / invalid_config`. For a direct port
mapping, supply the exact published loopback authority. Require a canonical
`127.0.0.1:<port>` value with a port from 1 through 65535. If the browser-facing
port is known only after launch, preconfigure an upstream authority such as
`127.0.0.1:<container-port>`. The launcher's local proxy validates the browser
authority and forwards with that configured upstream Host header. Reject
other authorities at the inspector.

The Host check protects against unexpected browser authorities. It provides
no authentication. Wildcard binds require an isolated container network or a
launcher-controlled path that prevents untrusted peers from reaching the
listener directly. Host loopback publishing alone does not isolate the
container listener. The consumer owns that deployment boundary and keeps
inspection opt-in.

## Lifecycle

Bind once after successful managed session setup and before returning the
first executable create or open result. A read of the current open session
reports the existing listener. Suspension keeps the inspector available.
Stop accepting requests, close event streams, and remove subscriptions on
explicit stop, successful conditional stop, startup rollback, and endpoint
disposal, before releasing session storage. A refused conditional stop keeps
the listener active. Complete inspector cleanup before returning a successful
stop result. While the stopped RPC endpoint remains reachable, it reports
`stopped` when inspection was enabled. On disconnect, the consumer discards
the previous URL. A replacement process binds again and reports its actual
address.
An ephemeral port is not a durable identifier and can be reused by the OS.

## Acceptance

1. Launch a real native harness over stdio through ACP-client. With port 0,
   read the status from create and status, load the inspector HTML, and verify
   the effective prompt and tools before the first turn. Send a message and
   verify Timeline, Channels, request and response details, model-call
   details, and live updates in the full app.
2. Run two opted-in harnesses concurrently and verify distinct working ports.
   Reopen saved state in a replacement process and verify the result reports
   its bound address and the consumer uses that address.
3. Verify the disabled default opens no listener. Verify invalid settings and
   an occupied port report the fixed failure and leave a turn usable. Check
   that stdout remains valid protocol framing.
4. Verify repeated status and open reads leave the listener in place.
   Exercise explicit stop, successful and refused conditional stop,
   failed startup, and transport closure with an active browser stream.
   Verify unexpected Host authorities and non-GET methods are rejected.
   Check that an image-capable request keeps its inspection detail without
   inline image bytes. Check that a runtime credential and an exact echo
   stay out of captured requests and responses.
5. Run the exported serve entry from a compiled agents binary with the source
   tree unavailable. Verify the inspector HTML and API are both served.
6. In the consumer's Docker launcher, publish the known container port on
   host loopback. Verify the page and live updates through the browser-facing
   authority, rejection of an unexpected authority, and refusal to bind
   without a valid wildcard authority. For direct publishing and local
   proxy configurations, verify the accepted authority at the inspector
   and the isolated network boundary. The setting, port publishing, and
   webapp link belong to agents-core.
