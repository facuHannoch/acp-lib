import { expect, test } from "bun:test";
import type { ProtocolConfig } from "../../src/native-harness/src/client.ts";
import type { ToolDefinition } from "../../src/native-harness/src/contracts/loop.ts";
import hub from "./fixtures/hub-context-tools.json";
import { nativeRig } from "./support.ts";

interface Request {
  max_completion_tokens?: number;
  tools: Array<{ function: ToolDefinition }>;
}

test("managed context sizing carries the Hub catalog through ACP-client and native stdio", async () => {
  const rig = await nativeRig();
  const requests: Request[] = [];
  let rejectContext = false;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(await request.json() as Request);
    if (rejectContext) return Response.json({ error: { code: "context_length_exceeded" } }, { status: 500 });
    return new Response('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
  } });
  const offered = hub.tools.map(({ name, description, inputSchema }) => ({ name, description, parameters: inputSchema }));
  // Replay the real Hub definitions through the host catalog. The MCP schema
  // subset and its discovery limits are independent of request sizing.
  rig.harness.functions = { tools: Object.fromEntries(offered.map(({ name, ...definition }) =>
    [name, { ...definition, handler: () => "unused" }])) };
  const denied = offered[0]!;
  async function run(contextBudget?: NonNullable<Extract<ProtocolConfig["model"], { protocol: "openai-compatible" }>["contextBudget"]>) {
    const config: ProtocolConfig = {
      version: 1, system: "Managed budget fixture", defaultPolicy: "open",
      policies: { open: { fallback: "allow", tools: { [denied.name]: "deny" } } },
      model: { protocol: "openai-compatible", providerId: "fixture", baseUrl: `http://127.0.0.1:${provider.port}/v1`, model: "fixture",
        ...(contextBudget ? { contextBudget } : {}) },
    };
    rig.harness.config = config;
    const agent = await rig.open();
    try {
      const conversation = await agent.conversations.create();
      return await conversation.prompt("Check the catalog.");
    } finally { await agent.close(); }
  }
  try {
    expect(Buffer.byteLength(JSON.stringify(offered))).toBeGreaterThan(13_312);
    await expect(run()).rejects.toThrow("context_limit");
    expect(requests).toHaveLength(0);
    await expect(run({ contextWindowTokens: 128_000, maxRequestBytes: 16_000 })).rejects.toMatchObject({
      cause: { contextFailure: { limit: "request_bytes", budget: { maxRequestBytes: 16_000 } } },
    });
    await expect(run({ contextWindowTokens: 20_000, outputReserveTokens: 8_000 })).rejects.toMatchObject({
      cause: { contextFailure: { limit: "input_tokens", budget: { inputBudgetTokens: 10_976 } } },
    });
    expect(requests).toHaveLength(0);
    expect((await run({ contextWindowTokens: 128_000, outputReserveTokens: 4096 })).text).toBe("ready");
    expect(requests[0]?.max_completion_tokens).toBeUndefined();
    const sent = requests[0]!.tools.map(tool => tool.function);
    for (const definition of offered.slice(1)) expect(sent).toContainEqual(definition);
    expect(sent.some(tool => tool.name === denied.name)).toBe(false);
    expect((await run({ contextWindowTokens: 128_000, maxOutputTokens: 512 })).text).toBe("ready");
    expect(requests[1]?.max_completion_tokens).toBe(512);
    rejectContext = true;
    await expect(run({ contextWindowTokens: 128_000 })).rejects.toMatchObject({ cause: { contextFailure: { limit: "provider_context" } } });
    expect(requests).toHaveLength(3);
  } finally {
    provider.stop(true);
    await rig.clean();
  }
}, 20_000);
