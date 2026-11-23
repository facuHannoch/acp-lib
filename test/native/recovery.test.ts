import { expect, spyOn, test } from "bun:test";
import { recoverStoppedReplies } from "../../src/native/recovery.ts";
import { controlledHarnessPeer } from "./controlled-peer.ts";


const emptyPage = { revision: 10, items: [], turns: [], unknownItemIds: [], unknownTurnIds: [], replies: [] };
const reply = (messageId: string, position: string) => ({ messageId, position, turnId: "7" });

test("native stopped-reply recovery bounds a silent read with one shared deadline", async () => {
  const { client, requests } = controlledHarnessPeer(request => {
    if (request.method === "channel/reconcile") return { ...emptyPage, replies: [reply("missing", "1")] };
  }, 12_000);
  const request = spyOn(client, "request");
  const started = performance.now();
  try {
    await expect(recoverStoppedReplies(client, "alpha", "7", [])).rejects.toMatchObject({ code: "cancelled" });
    expect(requests.map(({ method }) => method)).toEqual(["channel/reconcile", "session/message/read"]);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(4_750);
    expect(elapsed).toBeLessThan(9_000);
    const signal = request.mock.calls[0]?.[2];
    expect(signal?.reason?.name).toBe("TimeoutError");
    expect(request.mock.calls[1]?.[2]).toBe(signal);
  } finally {
    request.mockRestore();
    client.close();
  }
}, 15_000);

test("native stopped-reply recovery dedupes seen and repeated provider IDs", async () => {
  const { client, requests } = controlledHarnessPeer(request => {
    if (request.method === "session/message/read") return { data: Buffer.from("Recovered reply.").toString("base64") };
    return "cursor" in request.params
      ? { ...emptyPage, replies: [reply("missing", "2")] }
      : { ...emptyPage, replies: [reply("seen", "1"), reply("missing", "2")], next: "replies-page-two" };
  }, 12_000);
  try {
    const seen = [{ messageId: "seen", text: "Already delivered." }];
    expect(await recoverStoppedReplies(client, "alpha", "7", seen)).toEqual([
      { messageId: "missing", text: "Recovered reply." },
    ]);
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "channel/reconcile", params: { channel: "alpha", turnIds: ["7"] } },
      { method: "session/message/read", params: { messageId: "missing", offset: 0 } },
      { method: "channel/reconcile", params: { channel: "alpha", cursor: "replies-page-two" } },
    ]);
  } finally {
    client.close();
  }
});

test("native stopped-reply recovery surfaces an unknown turn", async () => {
  const { client, requests } = controlledHarnessPeer(() => ({ ...emptyPage, unknownTurnIds: ["7"] }), 12_000);
  try {
    await expect(recoverStoppedReplies(client, "alpha", "7", [])).rejects.toThrow("native stop recovery could not find turn 7");
    expect(requests.map(({ method }) => method)).toEqual(["channel/reconcile"]);
  } finally {
    client.close();
  }
});
