import { expect, test } from "bun:test";
import { createInspection } from "../src/interfaces/inspector/state.ts";
import { serveInspector } from "../src/interfaces/inspector/server.ts";
import type { Message } from "../src/contracts/loop.ts";

test("inspection snapshots do not alias live history or inference requests", () => {
  const inspection = createInspection("system");
  inspection.accepted("a", "alice");
  inspection.running("a", true);
  const history: Message[] = [{ role: "user", content: "original" }];
  inspection.history("a", history);
  inspection.request("a", JSON.stringify({ messages: history, tools: [] }));
  history[0]!.content = "changed";
  const first = inspection.snapshot();
  expect(first[0]?.messages[0]?.content).toBe("original");
  expect(first[0]?.requests[0]?.body).toEqual({ messages: [{ role: "user", content: "original" }], tools: [] });
  first[0]!.messages.length = 0;
  expect(inspection.snapshot()[0]?.messages.length).toBe(1);
  inspection.running("a", false);
  inspection.finished("a", "failed");
  expect(inspection.snapshot()[0]).toMatchObject({ pending: 0, running: false, error: "failed" });
});

test("inspector serves a read-only page, streams changes, and reconnects with current state", async () => {
  const inspection = createInspection("system");
  const server = serveInspector(inspection, 0);
  let cancel = async () => {};
  try {
    const html = await fetch(server.url);
    expect(await html.text()).toContain("Harness context inspector");
    expect((await fetch(new URL("/state", server.url), { method: "POST" })).status).toBe(405);
    const events = await fetch(new URL("/events", server.url));
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    const reader = events.body!.getReader();
    cancel = () => reader.cancel();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain("data: []");
    inspection.accepted("a", "<script>untrusted</script>");
    const update = await reader.read();
    expect(new TextDecoder().decode(update.value)).toContain('"id":"a"');
    await reader.cancel();
    const reconnect = await fetch(new URL("/events", server.url));
    const reconnectedReader = reconnect.body!.getReader();
    cancel = () => reconnectedReader.cancel();
    expect(new TextDecoder().decode((await reconnectedReader.read()).value)).toContain('"id":"a"');
    const state = await (await fetch(new URL("/state", server.url))).json();
    expect(state).toEqual(inspection.snapshot());
  } finally {
    await cancel();
    await server.stop(true);
  }
});
