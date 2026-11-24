# Review: native MCP, acp-client side (`m4` at 65fbb25)

Reviewer: clad2a-s. Clean `git archive` of 65fbb25 on `/dev/shm` (re-pulled after the packaging commit); no edits to the branch; probes and mutants on separate copies.

Verdict: **the library side is sound and I could not make a credential leak: approve it, with one serious finding in the harness runtime that the new MCP transport exposes (a remote MCP server can crash the whole native harness) and three untested guards.** The packaging and smoke script are good.

## Gate

- Root `tsc --noEmit`: exit 0. Harness `bun run typecheck`: exit 0 (after `bun install --frozen-lockfile` in `src/native-harness`).
- Plain `bun test`: **2,369 pass / 0 fail, 261 files, 35 snapshots** (matches core-p).
- `test/native/agent-mcp.test.ts` (4 tests): whole file x20 green, each test isolated x20 green (160 runs).
- Library diff vs base `25d9eb9` (non-harness): `agent-session.ts`, `agent.ts`, `agent/config.ts`, `agent/native-operations.ts`, `index.ts`, `native/{capabilities,connection,controller,host-config,host,mcp,recovery}.ts`, `native/reminders/{routine-guard,routine-wire}.ts`, `steering/{combine,contracts}.ts`, tests and guide. Protected-file growth over the base: host 978 to 988, agent-session 4,528 to 4,537, agent 658 to 661, native/controller 592 to 593 (the base alpha was already above the old R7-era ceilings; M4 adds a net +10/+9/+3/+1).

## (1) Secret leaks: I tried to break it and could not

How it works: `executableMcpOpen` calls the provider before every create/open request (including timeout retries and the batch-strip retry), passes the material only in the request, replaces a provider failure with a generic `mcp_runtime_headers_failed` error without the cause, and replaces any harness error with one of an allow-listed set of codes and a fixed message (`Native harness executable open failed`). Harness stderr is replaced by `{ redacted: true }` when a provider is configured. The material is never put in the journal, startup retry records (only reminder entries are stored), or events.
My probes (real harness child, real loopback HTTPS server, then a scan of events, logs, `nativeMcpStatus()`, `restartNative()` result, error text and stack, and **every file** in the Agent and harness directories including the model-request capture):
- Server echoing the exact credential in: a text block, an `isError` block, tool description, `serverInfo.name`, an HTTP 500 body, `structuredContent`, a resource link URI, a body split across two text blocks, and a base64-encoded form: **no occurrence anywhere** (the exact echoes are redacted; base64 is not echoed back, as expected for an exact-match redactor).
- Provider returning wrong types: `undefined`, `null`, a string, a string server entry, number/array/object header values, CRLF-injected value, case-duplicate names (`authorization`, `Authorization`, `AUTHORIZATION`), an unknown server key, a `__proto__` key: all fail the open with a generic `invalid_config` and **no leak**; `undefined` is treated as "no material" and the entry reports `unavailable / config`. A throwing provider whose message echoes the secret, and one that rejects with an object: generic `mcp_runtime_headers_failed`, no leak. A 2 MB header value: the connection is closed (`transport_closed`, generic), no leak (see notes).
- Header names are case-folded by the harness (uppercase `AUTHORIZATION` against a configured `Authorization` works in the existing test).
Mutants: passing a provider error through: **killed**; passing the harness message through: **killed**; caching the provider result: **killed**; sending the material only on create: **killed**. Survived: removing the stderr redaction (the test run never produces harness stderr, so it cannot see it).

## (2) Policy

The wire policy comes only from the explicit `nativePolicy` field, forwarded per item (and kept in the submission record, so replays after a reconnect keep it). Nothing in the library derives it from a participant id, display name or text: mutant making `policy: message.nativePolicy ?? message.participantId` is **killed** by the spoofing test (participant named `owner` without a policy is denied); dropping the forwarding is killed. The real mixed owner + guest turn denies MCP (tool absent from the tool list, paired `policy_denied` result). Omitting `nativePolicy` falls back to the channel's selected policy, then the session default (the guide says so explicitly and the test pins it: channel policy `owner` plus an omitted item policy is allowed). That is a consumer hazard the guide already warns about ("An owner channel still needs an explicit guest policy on guest input"); the wording "legacy/omitted denies" in the request is true only when the channel/default policy has no MCP grant. `nativePolicy` on a non-native conversation is rejected, but removing that check survives all tests.

## (3) Config pass-through and the guard merge

`mcpServers`, `policies` (including `mcp`) and `limits.mcpCallTimeoutMs` reach the create request and both open requests unchanged (the first test compares the three requests with the original config). I probed `configForOpen`: `{ mcpCallTimeoutMs, unattendedTurns: "unlimited" }` sends both with `9007199254740991`; after a guard is bound, the same config (either spelling) re-sends only `mcpCallTimeoutMs`; a different value is sent and refused by the harness as before; numeric-only and no-limits configs are unchanged. Mutant dropping the other limits: killed.

## (4) Provider on every open

Rotating the value across create, reopen, `restartNative()` and a missing/empty value: the tests assert three distinct values for three requests, that the HTTPS server accepted each rotated credential in order, and that a missing or empty value disables only the web entry (`unavailable / config`, no HTTPS request made) while the stdio entry stays `ready`. A provider that never resolves does not hang the host: with a 1.5 s startup timeout the start rejects `open_timeout` after 1,513 ms (the pending promise is not cancelled, which is harmless). A provider failure during a restart yields `restart_failed` with `mcp_runtime_headers_failed`. The signal check after the provider resolves is not tested (mutant survives).

## (5) Typing

`NativeInputPolicy`, `McpRuntimeHeaders`, `NativeMcpStatus` (capabilities and per-server state) and the conversation capabilities are all derived from the SDK types (`PushParams`, `CreateParams`, `InitializeResult`, `StatusResult`); nothing is hand-copied. `restartNative()` result carries `mcp` from the same snapshot; `stale` is set when the host is not running (probe and tests agree).

## (6) Packaging and the smoke script (`scripts/smoke-native-mcp-package.sh`)

- `package.json`: the diff adds only `optionalDependencies` (`@modelcontextprotocol/sdk` 1.31.0, `undici` 7.29.0); **the version line (`0.13.0-alpha.1`) is untouched.**
- I ran the script: it passes both modes. It `npm pack`s the repo, installs the tarball into a scratch directory, asserts `import.meta.resolve("@qlairoslabs/acp-client")` is under the scratch `node_modules`, and asserts the optional packages resolve in the first run and do **not** resolve in the `--omit=optional` run.
- I confirmed independently that it uses the installed copy and not the repo: `node_modules/@qlairoslabs/acp-client` is a real directory (not a symlink to the repo) at version `0.13.0-alpha.1`; the tarball contains no `test/` or `scripts/` entries; optional packages present in one mode and absent in the other.
- Omit-optional case: no crash; the configured entries report typed per-entry unavailability (`docs: unavailable / discovery`, `web: unavailable / connect`), the HTTPS server receives no calls, the model-request capture contains no `mcp__` tool, and a plain native session with no MCP config still replies. I extended the consumer to write its random credential to a file and scanned every file the run produced outside `node_modules` (SQLite databases, harness home, request captures, scripts): **the credential appears nowhere in either mode.**
- Notes on the script: it needs the npm registry (the optional packages are downloaded) and `openssl`; the scratch directory is removed by a trap, so a failure leaves nothing to inspect; it is not part of `bun test`, so CI has to call it.

## Findings

**F1 (serious, harness runtime; reproduced).** An HTTPS MCP server that answers `tools/list` or `tools/call` with a plain non-2xx response (HTTP 500 with a text body) **crashes the entire native harness process**: stderr shows `TypeError: Invalid state: Controller is already closed (ERR_INVALID_STATE) at onData (internal:webstreams_adapters)`, the host goes `stopped` ("connection lost"), the in-flight prompt fails with `Protocol output closed` for a `tools/list` failure, and every channel on that session is dropped. A 200 response with invalid JSON is handled. The cause is in `capabilities/tools/mcp/http.ts` (line 36, `Readable.toWeb(response.body)` under Bun 1.3.14): the response body stream is closed or cancelled for the error path and the Node-to-web adapter writes into the closed controller. Because stderr is replaced by `{ redacted: true }` when a provider is configured, an operator would see only "connection lost". A faulty or hostile remote MCP server can therefore take down all native conversations. Needs a fix in the transport (consume or cancel the body on non-2xx, or avoid `Readable.toWeb`), and a test with a 500 on both methods.

**F2 (untested guards).** The stderr redaction (L3), the "nativePolicy requires a native conversation" check, and the abort check after the provider resolves each survive removal. All three are cheap to pin.

**F3 (notes).** `nativePolicy` is a policy name chosen by the caller; any code that builds a prompt input from untrusted JSON and spreads it into `prompt()` could select a policy, which the guide warns about ("Do not populate `nativePolicy` from participant input"). Header material has no size bound in the library: a 2 MB value makes the harness drop the connection (generic error, no leak); a bound of a few KB with a typed error would be friendlier. A wrong-typed provider result is left to the harness to refuse (it does, generically); `undefined` is accepted as "no material" although the type forbids it.

## Docs

The new MCP section matches the code and probes: negotiated transports and per-server state, stale snapshot for a stopped host, optional-dependency behaviour with typed reasons and no secrets, the provider called on every executable open, case-insensitive names, missing/empty disabling only that entry, credentials never persisted, policy selection per item, omitted policy inheriting the channel then session default, the mixed-turn deny and the "every contributing policy must allow" rule. The sample (`withNativeMcp` with `mcpRuntimeHeaders`) compiles and `nativePolicy` accepts a string on `prompt` and `promptFrom` (a numeric value is a type error).

## Required

1. Fix F1 in the harness and add the 500-response tests (both methods). I would not merge M4 to alpha before this.
2. Optional: pin the three guards in F2; consider a header size bound.
