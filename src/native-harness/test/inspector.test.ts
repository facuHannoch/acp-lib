import { expect, spyOn, test } from "bun:test";
import { createInspection } from "../src/interfaces/inspector/state.ts";
import { serveInspector } from "../src/interfaces/inspector/server.ts";
import { createSession } from "../src/index.ts";
import { observeSession } from "../src/interfaces/inspector/observe.ts";
import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { ask } from "./helpers/session.ts";

function fixture() {
  const opened = createMemoryStorageAdapter().open({ mode: "create", identity: { sessionId: "inspector", compatibilityKey: "" } });
  if (!opened.ok) throw new Error(opened.error.message);
  const storage = opened.value;
  const session = createSession({ systemPrompt: "system", storage,
    configureTurn: () => ({ tools: [], executeTool: async () => "unused",
      model: async () => ({ role: "assistant", calls: [], content: "ok" }) }) });
  const inspection = createInspection("system", [], storage, "memory");
  const observer = observeSession(session, inspection);
  return { storage, inspection, session, observer };
}

test("the inspector invalidates without reading storage and fetches only the requested view", async () => {
  const { storage, inspection, session, observer } = fixture();
  const full = spyOn(storage, "snapshot"), status = spyOn(storage, "readInspectionStatus");
  const page = spyOn(storage, "readInspectionPage"), calls = spyOn(storage, "readInspectionCalls");
  const server = serveInspector(inspection, 0);
  const request = (path: string) => fetch(new URL(path, server.url));
  let cancel = async () => {};
  try {
    expect(await (await request("/")).text()).toContain("Harness context inspector");
    expect((await fetch(new URL("/state", server.url), { method: "POST" })).status).toBe(405);
    const events = await request("/events");
    const reader = events.body!.getReader();
    cancel = () => reader.cancel();
    const decode = new TextDecoder();
    expect(decode.decode((await reader.read()).value)).toBe("data: changed\n\n");
    observer.agent.send({ channelId: "a", participantId: "alice", text: "early", itemId: "early" });
    expect(decode.decode((await reader.read()).value)).toBe("data: changed\n\n");
    expect(status).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
    expect(await (await request("/state")).json()).toMatchObject({ channels: [{ id: "a", pending: 1, running: false }] });
    expect(status).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
    session.start();
    await ask(session, { channelId: "b", participantId: "bob", text: "second" });
    expect((await (await request("/context")).json() as ReturnType<typeof inspection.liveContext>).base[1]!.content).toContain("second");
    expect((await (await request("/timeline")).json() as ReturnType<typeof inspection.timeline>).entries[0]).toMatchObject({ channelId: "b", message: { role: "assistant" } });
    expect((await request("/timeline?before=0")).status).toBe(400);
    expect(await (await request("/channel?id=b")).json()).toEqual({ requests: [] });
    expect(calls).not.toHaveBeenCalled();
    expect((await (await request("/calls?id=b")).json() as ReturnType<typeof inspection.modelCalls>).modelCalls).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(full).not.toHaveBeenCalled();
    await reader.cancel();
    const reconnected = (await request("/events")).body!.getReader();
    cancel = () => reconnected.cancel();
    expect(decode.decode((await reconnected.read()).value)).toBe("data: changed\n\n");
    expect((await (await request("/state")).json() as ReturnType<typeof inspection.status>).session.execution).toBe("idle");
  } finally {
    await cancel(); await server.stop(true); observer.stop(); storage.close();
  }
});

test("inspector captures remain detached and bounded per channel", () => {
  const { inspection, observer, storage } = fixture();
  const message = { role: "assistant" as const, content: "B answer", calls: [] };
  for (let i = 0; i < 12; i++) inspection.request("a", JSON.stringify({ messages: [], tools: [] }), i);
  inspection.request("b", "x".repeat(150_000), 2);
  inspection.response("b", message);
  message.content = "mutated";
  const a = inspection.channel("a"), b = inspection.channel("b");
  expect(a.requests.map(request => request.number)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  a.requests.pop();
  expect(inspection.channel("a").requests).toHaveLength(8);
  expect(b.requests[0]).toMatchObject({ turnId: 2, body: { omitted: true }, response: { content: "B answer" } });
  observer.stop(); storage.close();
});
