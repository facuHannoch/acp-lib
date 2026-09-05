import { describe, expect, test } from "bun:test";
import type * as schema from "@agentclientprotocol/sdk";
import type { Capabilities } from "../src/capabilities.ts";
import { AcpClient } from "../src/client.ts";

const CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "test-model",
    options: [{ value: "test-model", name: "Test Model" }],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    type: "select",
    currentValue: "high",
    options: [{ value: "high", name: "High" }],
  },
  {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: "default",
    options: [{ value: "default", name: "Default" }],
  },
] as unknown as schema.SessionConfigOption[];

function capabilities(): Capabilities {
  return {
    protocolVersion: 1,
    client: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    authMethods: [],
    agent: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      auth: null,
      sessionCapabilities: {
        list: false,
        delete: false,
        close: false,
        fork: false,
        resume: false,
        additionalDirectories: false,
      },
    },
  };
}

function clientWithLoad(
  loadSession: (request: schema.LoadSessionRequest) => Promise<schema.LoadSessionResponse>,
): AcpClient {
  const client = new AcpClient({ adapter: { command: ["unused"] }, cwd: "/workspace" });
  const internals = client as unknown as {
    transport: { loadSession: typeof loadSession };
    _capabilities: Capabilities;
  };
  internals.transport = { loadSession };
  internals._capabilities = capabilities();
  return client;
}

describe("AcpClient session loading", () => {
  test("implicit and explicit loads expose the same configuration snapshot", async () => {
    const requests: schema.LoadSessionRequest[] = [];
    const client = clientWithLoad(async (request) => {
      requests.push(request);
      return { configOptions: CONFIG_OPTIONS };
    });

    const implicitResult = await client.startSession({
      sessionId: "provider-session",
      loadFailure: "error",
    });
    const implicitConfig = [...client.configOptions.entries()];

    const explicitResult = await client.loadSession("provider-session");
    const explicitConfig = [...client.configOptions.entries()];

    expect(implicitResult).toEqual({ sessionId: "provider-session", resumed: true });
    expect(explicitResult).toEqual(implicitResult);
    expect(implicitConfig).toEqual(explicitConfig);
    expect([...client.configOptions.keys()]).toEqual(["model", "reasoning_effort", "mode"]);
    expect(requests).toEqual([
      {
        sessionId: "provider-session",
        cwd: "/workspace",
        mcpServers: [],
        additionalDirectories: undefined,
      },
      {
        sessionId: "provider-session",
        cwd: "/workspace",
        mcpServers: [],
        additionalDirectories: undefined,
      },
    ]);
  });

  test("a failed load preserves the previously committed session configuration", async () => {
    let fail = false;
    const client = clientWithLoad(async () => {
      if (fail) throw new Error("load failed");
      return { configOptions: CONFIG_OPTIONS };
    });

    await client.loadSession("original-session");
    const originalConfig = client.configOptions;
    fail = true;

    await expect(
      client.startSession({ sessionId: "failed-session", loadFailure: "error" }),
    ).rejects.toThrow("load failed");
    expect(client.currentSessionId).toBe("original-session");
    expect(client.configOptions).toBe(originalConfig);
  });
});
