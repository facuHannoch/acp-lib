import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { AgentSessionOperationError, NativeTurnError } from "../../src/index.ts";
import { nativeRig, until } from "./support.ts";

for (const failure of ["429", "500", "transport", "timeout", "interrupted"] as const) {
  test(`native provider ${failure} keeps its safe diagnostic across reconnect`, async () => {
    const rig = await nativeRig();
    const key = crypto.randomUUID();
    const header = crypto.randomUUID();
    const responseBody = crypto.randomUUID();
    const responseUrl = `https://provider-private.invalid/${crypto.randomUUID()}`;
    let mode: typeof failure | "success" = failure;
    let requested = 0;
    let authenticated = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      await request.text();
      requested++;
      if (request.headers.get("authorization") === `Bearer ${key}`) authenticated++;
      if (mode === "429" || mode === "500") return new Response(JSON.stringify({ error: { message: `${responseBody} ${key} ${responseUrl}` } }),
        { status: Number(mode), headers: { "x-private": header, "x-request-id": `echo-${key}-${header}` } });
      if (mode === "timeout" || mode === "interrupted") {
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } });
    } });
    const socketServer = failure === "transport" ? createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requested++;
        if (request.headers.authorization === `Bearer ${key}`) authenticated++;
        if (mode === "transport") { request.socket.destroy(); return; }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    }) : undefined;
    if (socketServer) await new Promise<void>(resolve => socketServer.listen(0, "127.0.0.1", resolve));
    const address = socketServer?.address();
    const baseUrl = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}/v1` : new URL("/v1", server.url).href;
    try {
      rig.env.FIXTURE_PROVIDER_KEY = key;
      rig.env.HARNESS_TEST_MODEL_TIMEOUT_MS = failure === "timeout" ? "350" : "4000";
      rig.harness.config = {
        version: 1, system: "Loopback provider fixture",
        model: { protocol: "openai-compatible", providerId: "fixture", model: "fixture-model",
          baseUrl, apiKeyEnv: "FIXTURE_PROVIDER_KEY" },
        defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} } },
      };
      const agent = await rig.open();
      const channel = await agent.conversations.create();
      const events = rig.watch(channel);
      const host = agent.nativeHarness!;
      const prompt = channel.prompt("Run the failing provider");
      const outcome = prompt.then(() => undefined, error => error);
      if (failure === "interrupted") {
        await until(() => requested > 0, "provider request in flight");
        const active = (await host.status()).channels.find(row => row.channel === channel.id)?.activeTurn;
        expect(active).toBeDefined();
        expect(await host.interrupt(channel.id, active!.turnId, "operator interrupted")).toBe(true);
      }
      const error = await outcome;
      expect(error).toBeInstanceOf(AgentSessionOperationError);
      expect(error.cause).toBeInstanceOf(NativeTurnError);
      const typed = error.cause as NativeTurnError;
      expect(error.message).toBe(typed.message);
      const reason = failure === "timeout" ? "timeout: Model request deadline exceeded"
        : failure === "transport" ? "failed: Chat Completions transport failed"
        : failure === "interrupted" ? "operator interrupted"
        : `failed: Chat Completions HTTP ${failure}`;
      const expectedOutcome = failure === "interrupted" ? "interrupted" : "failed";
      expect(typed.outcome).toBe(expectedOutcome);
      const turnId = typed.message.split(" ")[2]!;
      const detail = reason.replace(/^(failed|interrupted): /, "");
      expect(typed.message).toBe(`native turn ${turnId} ${expectedOutcome}: ${detail}`);
      expect(authenticated).toBe(requested);
      expect(requested).toBeGreaterThan(0);
      await until(() => events.some(event => event.kind === "turn_failed"), "public failure event");
      expect(events.filter(event => event.kind === "turn_failed").map(event => event.error)).toEqual([String(error)]);
      for (const event of events.filter(event => event.kind === "provider_notice")) expect(JSON.stringify(event)).toContain(detail);

      const id = agent.id;
      await agent.close();
      const resumed = await rig.open({ id });
      const opened = await resumed.conversations.open(channel.id);
      const reopened = resumed.nativeHarness!;
      await reopened.start();
      const restored = await reopened.reconcileChannel({ channel: channel.id, turnIds: [turnId] });
      expect(restored.turns).toContainEqual(expect.objectContaining({ state: expectedOutcome, reason }));
      const calls = await reopened.modelCalls();
      expect(calls.calls).toContainEqual(expect.objectContaining({ outcome: failure === "timeout" ? "timeout" : expectedOutcome }));
      mode = "success";
      expect((await opened.conversation.prompt("Try again after recovery")).text).toBe("recovered");
      const restart = await resumed.restartNative();
      expect(restart.kind).toBe("restarted");
      const status = await reopened.operatorStatus();
      await resumed.close();
      const observations = JSON.stringify({ events, logs: rig.logs, restart, status, restored, calls }) + error.stack + typed.stack;
      const files = [...new Bun.Glob("**/*").scanSync({ cwd: rig.directory, absolute: true, dot: true, onlyFiles: true })];
      for (const secret of [key, header, responseBody, responseUrl]) {
        expect(observations).not.toContain(secret);
        for (const file of files) expect(readFileSync(file).includes(secret)).toBe(false);
      }
    } finally {
      await rig.clean();
      await server.stop(true);
      socketServer?.closeAllConnections();
      socketServer?.close();
    }
  }, 15_000);
}
