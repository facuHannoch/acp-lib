import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInProcessHarness } from "../src/testing.ts";
import type { ExaTransport } from "../src/capabilities/tools/web/exa.ts";

const script = (path: string, calls: object[]) => writeFileSync(path, [
  { type: "scenario", version: 1, name: "web-session" }, { type: "model", content: null, calls }, { type: "model", content: "done" },
].map(row => JSON.stringify(row)).join("\n") + "\n");
const config = (path: string) => ({ version: 1 as const, system: "test", model: { protocol: "scripted" as const, script: path },
  defaultPolicy: "allow", policies: { allow: { fallback: "allow" as const, tools: {} } }, webSearch: { backend: "exa" as const }, webFetch: { backend: "exa" as const } });

test("checked web tools execute, preserve preview, and commit per-call usage", async () => {
  const home = mkdtempSync(join(tmpdir(), "web-session-")), path = join(home, "script.jsonl");
  const calls = [{ id: "search", name: "web_search", arguments: { query: "example" } }, { id: "fetch", name: "web_fetch", arguments: { url: "https://example.com/" } }];
  script(path, calls); const requests: string[] = [];
  const transport: ExaTransport = async request => { requests.push(request.path); return request.path === "/search"
    ? { status: 200, body: { requestId: "search-id", costDollars: { total: 0 }, results: [{ url: "https://example.com/", title: "Example", highlights: ["source"] }] } }
    : { status: 200, body: { requestId: "fetch-id", costDollars: { total: 0.01 }, statuses: [{ id: "https://example.com/", status: "success" }], results: [{ url: "https://example.com/", title: "Example", text: "body" }] } }; };
  const harness = createInProcessHarness({ home, captureRequests: true, environment: { EXA_API_KEY: "secret-canary" }, webTransport: transport });
  try {
    await harness.client.initialize();
    await harness.client.createSession({ sessionId: "s", config: config(path), participants: [], channels: {} });
    await harness.client.push({ channel: "a", item: { id: "input", kind: "user_message", sender: "p", content: [{ type: "text", text: "research" }] } });
    const deadline = Date.now() + 5000; while (!(await harness.client.idle()).idle && Date.now() < deadline) await Bun.sleep(10);
    expect(requests).toEqual(["/search", "/contents"]);
    const inference = harness.models.get("a")!; expect(inference).toHaveLength(2);
    const results = inference[1]!.messages.filter(message => message.role === "tool");
    expect(results.map(message => JSON.parse(message.content))).toMatchObject([{ results: [{ url: "https://example.com/" }] }, { url: "https://example.com/", text: "body", coverage: "unknown" }]);
    expect(JSON.stringify(results)).not.toContain("search-id");
    expect((await harness.client.toolInvocations("1")).invocations).toMatchObject([
      { tool: "web_search", webUsage: { backend: "exa", operation: "web_search", requestId: "search-id", cost: { kind: "provider_estimate", usd: 0 } } },
      { tool: "web_fetch", webUsage: { backend: "exa", operation: "web_fetch", requestId: "fetch-id", cost: { kind: "provider_estimate", usd: 0.01 } } },
    ]);
    await harness.client.suspend(); const archive = await harness.client.exportArchive();
    expect(Buffer.from(archive).includes("secret-canary")).toBe(false);
  } finally { harness.close(); rmSync(home, { recursive: true, force: true }); }
}, 10000);
