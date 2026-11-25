# Consumer implementation brief for native harness features

This brief is for applications embedding `@qlairoslabs/acp-client`, including the `agents-core` launcher. Use a package build containing `alpha` commit `b09e352c0a318ea9fa5606418349c238b7d4c45a` or a later compatible build. That revision passed the combined ACP-client and native harness gates. The steps below describe the work still needed in a consumer to expose and use the features.

## Integration scope

| Feature | Where the consumer integrates it |
| --- | --- |
| OpenAI-compatible inference | Set `harness.config.model` on the Agent. |
| Web search and fetch | Set `harness.config.webSearch` and `harness.config.webFetch`, and grant the tool names under the relevant policies. |
| MCP servers | Set `harness.config.mcpServers`, provide `harness.mcpRuntimeHeaders` when needed, and pass trusted input policy names. |
| Managed attachments | Use the native harness web chat or add upload, download and ordered input parts to the consumer's native session adapter. The high-level ACP-client conversation API currently has no managed attachment upload method. |

Route native sessions through the existing `native-harness` launcher path and leave existing ACP launcher paths in place. Keep `harness.home` on persistent storage across process restarts. Use the package's typed `AgentHarnessConfig` and preserve the whole managed config across executable create and reopen, including `limits.unattendedTurns` and `limits.mcpCallTimeoutMs` when supplied. If the consumer launches an external harness command, verify that binary supports the features before enabling them.

## OpenAI-compatible inference

### OpenCode Go and OpenRouter

Pass one of these objects as `harness.config.model` on a native adapter.
Use a package build containing the OpenCode Go preset before enabling it.

```ts
const go = { protocol: "opencode-go", model: "deepseek-v4.1-flash" } as const;
const openRouter = { protocol: "openrouter", model: "openai/gpt-6-luna", apiKeyEnv: "OPENROUTER_API_KEY" } as const;
```

Supply `OPENCODE_API_KEY` in the native harness environment for Go. If your
launcher uses `OPENCODE_GO_API_KEY`, set `apiKeyEnv: "OPENCODE_GO_API_KEY"`
on the Go model. The preset handles the endpoint and per-channel routing.
For DeepSeek V4.1 Flash, check the Go workspace's allowed regions.
[OpenCode Go](https://opencode.ai/docs/console/go/#enable-restricted-models) · [OpenRouter GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna?view=api)

### Custom endpoint

Offer this option alongside the existing `scripted` and `openrouter` variants. Pass the following model object through unchanged:

```ts
const model = {
  protocol: "openai-compatible",
  providerId: "local-inference",
  model: "my-model",
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKeyEnv: "LOCAL_INFERENCE_API_KEY",
} as const;
```

- Use the API base URL. The harness appends `/chat/completions`. It accepts HTTPS or HTTP on a canonical literal loopback address in `127.0.0.0/8` or `::1`. URLs with credentials, a query or a fragment are rejected, as is HTTP `localhost`. Redirects are refused.
- `apiKeyEnv` is the name of an environment variable available to the harness process. Omit it for a keyless endpoint. Keep the value out of persisted settings, prompts and logs. Custom provider headers are outside this config shape.
- Select the endpoint through trusted deployment or administrator settings. A new provider ID, endpoint or model can make a saved checkpoint incompatible. Use the existing executable reopen and compatibility handling when changing those fields.
- This variant is text-only. General files and historical image references can appear as metadata. The session rejects new image inputs before acceptance.

## Web search and fetch

Set search and fetch independently. Omit either setting to leave that tool disabled.

```ts
const web = {
  webSearch: { backend: "exa", apiKeyEnv: "EXA_API_KEY" },
  webFetch: { backend: "http" },
} as const;

const research = {
  fallback: "deny",
  tools: { web_search: "ask", web_fetch: "allow" },
} as const;
```

- Exa can also back `webFetch` with `{ backend: "exa", apiKeyEnv: "EXA_API_KEY" }`. Exa needs the referenced key in the harness process at executable open. Direct HTTP fetch works without an Exa key and is limited to supported public HTML and text responses.
- Availability and policy are separate. Put `research` or an equivalent policy in `harness.config.policies`, and select it only for the intended channels or inputs. If using `"ask"`, configure the existing approval responder.
- Where the consumer exposes native tool invocation inspection, distinguish `none`, `unknown`, and `provider_estimate`. A zero estimate is valid, a lost paid response has unknown cost, and direct fetch has no paid cost. Keep these records separate from model token usage. The next inference receives a complete bounded JSON result or a typed `context_limit` failure when its required exchange cannot fit.

## Native MCP and launcher wiring

For an Agent-owned native session, map MCP servers to `harness.config.mcpServers`. Keep the existing ACP `mcpServers` array for ACP launch paths. The native map is keyed by a server name. `transport: "http"` means Streamable HTTPS.

```ts
import type { AgentHarnessConfig } from "@qlairoslabs/acp-client";

export function nativeMcp(
  config: AgentHarnessConfig["config"],
  getAuthorization: () => Promise<string>,
) {
  return {
    config: {
      ...config,
      defaultPolicy: "guest",
      policies: {
        ...config.policies,
        owner: { fallback: "deny", tools: {}, mcp: "allow" },
        guest: { fallback: "deny", tools: {}, mcp: "deny" },
      },
      mcpServers: {
        docs: { transport: "stdio", command: "/app/bin/docs-mcp", args: [] },
        account: {
          transport: "http",
          endpoint: "https://mcp.example.com/rpc",
          headers: { Authorization: { runtime: true } },
        },
      },
      limits: { ...config.limits, mcpCallTimeoutMs: 10_000 },
    },
    mcpRuntimeHeaders: async () => ({
      account: { Authorization: await getAuthorization() },
    }),
  } satisfies Pick<AgentHarnessConfig, "config" | "mcpRuntimeHeaders">;
}
```

- The policy and server names in the example are illustrative. Preserve the application's existing ordinary-tool rules and choose the MCP grant deliberately. The `mcp: "allow"` grant applies to all MCP tools in that policy. Every policy contributing to a turn must explicitly allow MCP. Empty, legacy and mixed owner/guest policy sets deny it when they lack a grant.
- At the trusted launch or request boundary, derive `nativePolicy` from the authenticated application's authority. Use object-form `conversation.prompt` or `conversation.promptFrom({ participantId, text, nativePolicy: "guest" })`. Set a guest policy explicitly on guest input to an owner-default channel. Participant IDs, display names, kinds and message text carry no authority. Direct protocol hosts set `channel/push.item.policy` themselves.
- For stdio, use a trusted executable path and argument array. Declare the environment it needs with entries such as `env: { SERVICE_TOKEN: { env: "SERVICE_TOKEN" } }`. The child's environment is explicit.
- For HTTPS headers, keep declarations in portable config and resolve secret values using `{ env: "VAR_NAME" }` or `{ runtime: true }`. The trusted launcher supplies runtime values from its credential store on each executable create or reopen, including reconnect. Header names are case-insensitive. ACP-client caps encoded material at 8 KiB total and 2 KiB per value. Oversized material fails locally with `mcp_runtime_headers_too_large`. Missing or empty required material makes the affected server unavailable before it connects. Keep values out of persisted config, status, diagnostics and exports.
- Read transport and per-server status with `agent.nativeMcpStatus()`. Treat a stopped host's snapshot as stale. Deploy with optional `@modelcontextprotocol/sdk` and `undici` dependencies present to enable the transports. Without them, affected entries report unavailable and the rest of the native session still works. Treat `mcp_uncertain` as an unknown effect and avoid automatic replay.

For `agents-core`, implement the native mapping under `agents-core/src/harness/launch/` and thread it through the native session creation and reopen paths. Keep the existing gateway and other ACP delivery paths working. The downstream launcher acceptance test remains consumer work. It should use deterministic stdio and loopback HTTPS fixtures. Confirm actual agents-tools and door approval behavior separately with their service owners before claiming deployment compatibility.

## Managed attachments

For a consumer-hosted UI, put the operations behind the trusted host that owns the native session and validates channel access. An application embedding ACP-client should expose or route these operations through its native host integration. The harness SDK methods below are available to a direct harness client. An existing ACP attachment or a local filesystem path is a different input type.

1. On initialize, check `description.capabilities.managedAttachments`, `description.capabilities.orderedParts`, and `description.attachmentLimits`. For images also check `imageInput` and `imageLimits` from the current executable create or open response. Hide or disable image submission when the session did not advertise it.
2. Compute the byte length and lowercase SHA-256 digest and call `beginAttachment({ channel, filename, mediaType, bytes, sha256 })`. Send canonical base64 chunks with `writeAttachment({ channel, uploadId, offset, data })`, advancing by the returned offset. The default maximum is 512 KiB decoded per chunk and 20 MiB per file. Use `attachmentStatus` after a lost write acknowledgement and `abortAttachment` when cancelling an active upload.
3. Call `finalizeAttachment({ channel, uploadId })` before submitting the item. Send ordered parts in `channel/push.item.content`, for example `[{ type: "text", text: "Review this file" }, { type: "attachment", id: attachmentId }]`. An attachment-only input is also supported. Reuse the same item ID and ordered parts on an exact retry.
4. Render structured parts and metadata where the harness supplies them. Download with `readAttachment({ channel, id, offset })` and follow `nextOffset` until it is absent. Before a reference enters the shared timeline, reads are scoped to the upload's owner channel. After durable timeline publication, apply normal shared-timeline access. Preserve the harness's refusal for unknown or inaccessible references.

To enable image input, explicitly set `model.imageInput: true` on the supported OpenRouter path or an offline scripted fixture. Deploy the harness with a working Linux validator environment, including `ffmpeg`, `ffprobe`, `prlimit`, and a temporary filesystem supporting `O_TMPFILE`. General-file uploads work without those decoder dependencies. Keep file bytes out of application logs, status and history displays. Back up the harness media alongside its database.

## Upgrade and rollback

- Back up the Agent database and native harness home separately before the rollout. Include the session's `media/` directory or the `PATH.media/` sibling for explicit harness databases. Use a stopped owner, a consistent snapshot, or the supported harness export for the backup. Keep the matching code version with a rollback copy.
- Feature-bearing native harness state may activate SQLite format 8 for routines, 9 for attachments, or 10 for web usage. Logical archives use versions 7, 8 and 9 for those features. Older readers may refuse the new formats. Restore the matching database and media backup to roll back a feature-bearing session. An export omits unreferenced finalized uploads.
- The four features can be rolled out independently. Existing model variants and host-side tool wrappers remain supported. Keep any feature-specific settings disabled until the corresponding deployment and authorization paths are ready.

## Consumer acceptance checklist

- Start a real native session through the consumer's launcher. Run one text turn against a deterministic OpenAI-compatible fixture and verify the model ID and credential reference are handled correctly on reopen.
- Enable web search and fetch under a named policy. Exercise search-to-fetch with a fixture and direct fetch without an Exa key. Verify denied tools make no request and the usage view distinguishes no charge, unknown cost and an estimate of zero.
- Configure one stdio MCP server and one loopback HTTPS server. Discover and call both as an authorized owner. Deny a guest who uses the owner's display identity, and deny a mixed owner/guest turn. Reopen with fresh runtime header material and verify delivery only at the intended endpoint. Check that a plain HTTP 500 leaves the native process and another channel usable. Scan persisted state, exports and diagnostic surfaces for a secret canary.
- Upload and download a general file with the decoder unavailable. Verify owner-only reads before timeline publication and normal shared access afterwards. On an image-capable session, send an image with text, verify the actual provider input and exercise a follow-up inference after a tool call. Verify rejection on a text-only session and check that captures contain metadata without image bytes.
- Reopen after restart, export and import a sample session with referenced media and web usage, and verify that content remains readable and that an older-version rollback uses the backup.
