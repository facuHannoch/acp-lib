import { expect, test } from "bun:test";
import { createSession } from "../src/index.ts";
import { createWebRegistry } from "../src/capabilities/tools/web/registry.ts";
import { ask } from "./helpers/session.ts";
import type { Message } from "../src/contracts/loop.ts";

async function scenario(assistantBytes: number) {
  const registration = createWebRegistry({ webSearch: { backend: "exa" } }, { EXA_API_KEY: "fixture" }, { exa: async () => ({ status: 200, body: { results: Array.from({ length: 3 }, (_, i) => ({ title: `source-${i}`, url: `https://example.com/${i}`, highlights: ["x".repeat(512)] })) } }) });
  if (!registration.ok) throw Error(registration.error.message);
  const requests: Message[][] = [];
  const session = createSession({ systemPrompt: "test", webTools: registration.value, configureTurn(turn) {
    let step = 0;
    return { tools: [{ name: "other", description: "paired", parameters: { type: "object" } }],
      executeTool: async () => "other-result",
      model: async messages => {
        if (turn.channelId === "history") return { role: "assistant", content: "HISTORY_MARKER" + "h".repeat(7000), calls: [] };
        requests.push(structuredClone([...messages]));
        return step++ === 0 ? { role: "assistant", content: "a".repeat(assistantBytes), calls: [
          { id: "search", name: "web_search", arguments: JSON.stringify({ query: "example" }) },
          { id: "other", name: "other", arguments: "{}" },
        ] } : { role: "assistant", content: "done", calls: [] };
      } };
  } });
  session.start();
  await ask(session, { channelId: "history", participantId: "p", text: "older" });
  let failure: unknown;
  try { await ask(session, { channelId: "active", participantId: "p", text: "research" }); } catch (error) { failure = error; }
  return { session, requests, failure };
}

test("near budget next provider request retains complete web and sibling tool results before history", async () => {
  const { session, requests, failure } = await scenario(4000);
  try {
    expect(failure).toBeUndefined(); expect(requests).toHaveLength(2);
    const next = requests[1]!;
    expect(JSON.stringify(next)).not.toContain("HISTORY_MARKER");
    const assistant = next.find(message => message.role === "assistant" && message.calls.some(call => call.id === "search"));
    expect(assistant).toMatchObject({ calls: [{ id: "search" }, { id: "other" }] });
    const web = next.find(message => message.role === "tool" && message.callId === "search");
    const other = next.find(message => message.role === "tool" && message.callId === "other");
    if (!web || web.role !== "tool") throw Error("missing web result");
    expect(JSON.parse(web.content).results).toHaveLength(3); expect(Buffer.byteLength(web.content)).toBeLessThanOrEqual(2048);
    expect(other).toMatchObject({ content: "other-result" });
  } finally { session.stop("test complete"); }
});

test("oversized required web exchange fails before the next provider request", async () => {
  const { session, requests, failure } = await scenario(13000);
  try {
    expect(failure).toBeDefined(); expect(requests).toHaveLength(1);
    expect(session.snapshot().turns.find(turn => turn.channelId === "active")?.state).toMatchObject({ status: "failed", reason: "context_limit" });
  } finally { session.stop("test complete"); }
});
