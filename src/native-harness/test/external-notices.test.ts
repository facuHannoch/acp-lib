import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInProcessHarness } from "../src/testing.ts";
import { spawnHarness } from "./helpers/stdio.ts";
import { modelScenario } from "./helpers/scenario.ts";
import type { ProtocolConfig } from "../src/client.ts";

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 500; attempt++) { if (await check()) return; await Bun.sleep(10); }
  throw new Error("Timed out waiting for notice evidence");
}

for (const transport of ["in-process", "stdio"] as const) test(`${transport}: external notices wake and steer a detached channel with inherited restrictions`, async () => {
  const home = mkdtempSync(join(tmpdir(), "external-notice-"));
  const script = join(home, "model.jsonl"), effects = join(home, "effects"), requests = join(home, "requests");
  writeFileSync(script, modelScenario([
    { content: null, calls: [{ id: "hold", name: "hold", arguments: { key: "wait" } }] },
    { content: null, calls: [{ id: "deny", name: "record", arguments: { text: "forbidden" } }] },
    { content: "Done" },
  ]));
  const config: ProtocolConfig = { version: 1, system: "external", model: { protocol: "scripted", script }, defaultPolicy: "owner",
    policies: { owner: { fallback: "allow", tools: {} }, guest: { fallback: "allow", tools: { record: "deny" } } } };
  const connect = () => transport === "stdio" ? spawnHarness({ home, effects, requests }) : createInProcessHarness({ home, effects, requests });
  const first = connect();
  const notify = (id: string, policyNames = ["guest"], source: string | undefined = "worker") =>
    ({ channel: "alice", notice: { id, text: "result", source, policyNames } });
  try {
    const init = await first.client.initialize();
    expect(init.description.capabilities.methods).toContain("channel/notify");
    await expect(first.client.notify(notify("one"))).rejects.toMatchObject({ code: "invalid_state" });
    await first.client.createSession({ sessionId: "s", participants: [], channels: {}, config });
    await expect(first.client.notify(notify("one"))).rejects.toMatchObject({ code: "not_found" });
    await first.client.createChannel({ channel: "alice" });
    await first.client.createChannel({ channel: "retired" });
    await first.client.deleteChannel({ channel: "retired" });
    await expect(first.client.notify({ ...notify("retired-id"), channel: "retired" })).rejects.toMatchObject({ code: "channel_retired" });
    await first.client.suspendChannel({ channel: "alice" });
    await expect(first.client.notify(notify("suspended-id"))).rejects.toMatchObject({ code: "channel_suspended" });
    await first.client.resumeChannel({ channel: "alice" });
    await expect(first.client.notify(notify("one", ["unknown"]))).rejects.toMatchObject({ code: "invalid_policy" });
    expect(await first.client.notify(notify("one"))).toMatchObject({ accepted: true, duplicate: false, item: { kind: "external_notice", externalSource: "worker" } });
    await until(() => existsSync(effects) && readFileSync(effects, "utf8").includes("start:wait"));
    expect(await first.client.notify(notify("two"))).toMatchObject({ item: { milestone: "received" } });
    writeFileSync(effects + ".release-wait", "");
    await until(async () => (await first.client.status()).execution === "idle");
    const items = await first.client.reconcileChannel({ channel: "alice", itemIds: ["one", "two"] });
    expect(items.items.map(item => item.turnId)).toEqual(["1", "1"]);
    const timeline = await first.client.timeline();
    expect(timeline.events.filter(event => event.kind === "external_notice").map(event => [event.itemId, event.externalSource])).toEqual([["one", "worker"], ["two", "worker"]]);
    expect((await first.client.channelMessages({ channel: "alice" })).messages.map(message => "parts" in message ? message.parts?.[0]?.text : undefined)).toEqual(["Done"]);
    const captured = readFileSync(requests, "utf8");
    expect(captured).toContain('External notice from \\"worker\\" to channel \\"alice\\"');
    expect(captured).toContain("policy_denied");
    expect(readFileSync(effects, "utf8")).not.toContain("forbidden");
    await first.client.suspend();
    const revision = (await first.client.status()).revision;
    expect(await first.client.notify(notify("one", ["guest", "guest"]))).toMatchObject({ duplicate: true });
    expect((await first.client.status()).revision).toBe(revision);
    await expect(first.client.notify(notify("new"))).rejects.toMatchObject({ code: "not_running" });
    await expect(first.client.notify(notify("one", ["guest"], "changed"))).rejects.toMatchObject({ code: "item_conflict" });
  } finally { await first.close(); }
  const second = connect();
  try {
    await second.client.initialize();
    await second.client.openSession({ sessionId: "s", config: { ...config, policies: { owner: config.policies!.owner! } } });
    const revision = (await second.client.status()).revision;
    expect(await second.client.notify(notify("one"))).toMatchObject({ duplicate: true });
    await expect(second.client.notify(notify("new"))).rejects.toMatchObject({ code: "incompatible" });
    expect((await second.client.status()).revision).toBe(revision);
  } finally { await second.close(); rmSync(home, { recursive: true, force: true }); }
}, 20000);

test("stdio: a lost external notice receipt reopens with one accepted item and one take", async () => {
  const home = mkdtempSync(join(tmpdir(), "notice-receipt-loss-"));
  const script = join(home, "model.jsonl");
  writeFileSync(script, modelScenario([{ content: "Once" }, { content: "Unexpected second take" }]));
  const first = spawnHarness({ home, fault: "acceptItem:1" });
  const params = { channel: "alice", notice: { id: "stable", text: "result", policyNames: [] } };
  try {
    await first.client.initialize();
    await first.client.createSession({ sessionId: "s", participants: [], channels: {}, config: {
      version: 1, system: "test", model: { protocol: "scripted", script }, defaultPolicy: "open",
      policies: { open: { fallback: "allow", tools: {} } },
    } });
    await first.client.createChannel({ channel: "alice" });
    await expect(first.client.notify(params)).rejects.toBeDefined();
    expect(await first.child.exited).not.toBe(0);
    const recovered = spawnHarness({ home });
    try {
      await recovered.client.initialize();
      await recovered.client.openSession({ sessionId: "s" });
      expect(await recovered.client.notify(params)).toMatchObject({ duplicate: true });
      await until(async () => (await recovered.client.status()).execution === "idle");
      expect((await recovered.client.timeline()).events.filter(event => event.kind === "external_notice")).toHaveLength(1);
      expect((await recovered.client.modelCalls()).calls).toHaveLength(1);
      await expect(recovered.client.notify({ ...params, notice: { ...params.notice, source: "host" } })).rejects.toMatchObject({ code: "item_conflict" });
    } finally { await recovered.close(); }
  } finally { first.client.close(); first.child.kill(); rmSync(home, { recursive: true, force: true }); }
}, 20000);
