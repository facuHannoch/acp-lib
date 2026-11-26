import { expect, test } from "bun:test";
import { nativeRig, reply } from "./support.ts";

test("managed inspector serves the full app and captures the live turn", async () => {
  const first = await nativeRig(), second = await nativeRig();
  first.env.HARNESS_INSPECTOR_PORT = second.env.HARNESS_INSPECTOR_PORT = "0";
  const secret = "inspection-canary-api-key";
  first.env.EXA_API_KEY = secret;
  first.script([reply(`inspected reply ${secret}`)]);
  try {
    const [agent, other] = await Promise.all([first.open(), second.open()]);
    const host = agent.nativeHarness!;
    await Promise.all([host.start(), other.nativeHarness!.start()]);
    const status = (await host.status()).inspector;
    const otherStatus = (await other.nativeHarness!.status()).inspector;
    if (status?.state !== "listening" || otherStatus?.state !== "listening") throw new Error("Inspector did not bind");
    expect(status.host).toBe("127.0.0.1");
    expect(status.port).not.toBe(otherStatus.port);
    const url = `http://127.0.0.1:${status.port}`;
    expect(await (await fetch(`${url}/`)).text()).toContain("Harness context inspector");
    expect((await fetch(`${url}/state`, { headers: { Host: "unexpected.invalid" } })).status).toBe(403);
    const context = await (await fetch(`${url}/context`)).json();
    expect(JSON.stringify(context.base)).toContain("Native integration test");
    expect(context.tools).toContainEqual(expect.objectContaining({ name: "notify_channel" }));
    const events = (await fetch(`${url}/events`)).body!.getReader();
    const session = await agent.conversations.create({ title: "Inspector test" });
    expect((await session.prompt(`inspect this ${secret} data:image/png;base64,AAA=`)).text).toBe(`inspected reply ${secret}`);
    expect(await events.read()).toMatchObject({ done: false });
    expect(await events.read()).toMatchObject({ done: false });
    const channel = await (await fetch(`${url}/channel?id=${session.id}`)).json();
    const captured = JSON.stringify(channel);
    expect(channel.requests[0]).toMatchObject({
      turnId: 1, body: { messages: expect.any(Array) }, response: { content: "inspected reply [REDACTED]" },
    });
    expect(captured).toContain("[REDACTED_IMAGE]");
    expect(captured).not.toContain(secret);
    expect(captured).not.toContain("AAA=");
    const timeline = await (await fetch(`${url}/timeline`)).text();
    expect(timeline).toContain("inspected reply");
    expect(timeline).not.toContain(secret);
    expect((await (await fetch(`${url}/calls?id=${session.id}`)).json()).modelCalls).toHaveLength(1);
    expect((await host.status()).inspector).toEqual(status);
    await host.stop();
    await expect(fetch(`${url}/state`)).rejects.toThrow();
    await events.cancel().catch(() => {});
  } finally { await Promise.all([first.clean(), second.clean()]); }
}, 20_000);

test("disabled and failed inspector binds leave managed sessions usable", async () => {
  const disabled = await nativeRig(), failed = await nativeRig();
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  failed.env.HARNESS_INSPECTOR_PORT = String(occupied.port);
  try {
    const [agent, fallback] = await Promise.all([disabled.open(), failed.open()]);
    await Promise.all([agent.nativeHarness!.start(), fallback.nativeHarness!.start()]);
    expect((await agent.nativeHarness!.status()).inspector).toBeUndefined();
    expect((await fallback.nativeHarness!.status()).inspector).toEqual({ state: "unavailable", code: "bind_failed" });
    const session = await fallback.conversations.create({ title: "Still usable" });
    expect((await session.prompt("continue")).text).toBe("reply 1");
  } finally {
    await occupied.stop(true);
    await Promise.all([disabled.clean(), failed.clean()]);
  }
}, 20_000);
