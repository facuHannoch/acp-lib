import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hold, nativeRig, reply, until } from "./support.ts";

for (const when of ["idle", "now"] as const) {
  test(`Agent native restart ${when} rebuilds the live channel and applies the new system prompt`, async () => {
    const rig = await nativeRig();
    try {
      rig.script([hold("restart", "waiting"), reply("ready"), reply("ready")]);
      const requests = join(rig.directory, "requests.jsonl");
      rig.env.HARNESS_TEST_REQUESTS = requests;
      const script = join(rig.directory, "script.jsonl");
      const agent = await rig.open();
      const channel = await agent.conversations.create();
      const unopened = await agent.conversations.create();
      const events: unknown[] = [];
      agent.subscribeNativeRestart(event => events.push(event));
      expect(await agent.previewNativeRestart()).toEqual({ conversationCount: 2, conversationIds: expect.arrayContaining([channel.id, unopened.id]) });
      const run = channel.prompt("start the old model").then(() => {}, () => {});
      await until(() => rig.effects().length > 0, "old tool starts");
      const host = agent.nativeHarness!;
      const reminder = await channel.reminders.create({ text: "future", schedule: { in: 600_000 } });
      const wake = (await agent.persistence.reminders!.wake()).effectiveAt;
      expect(wake).toBe(reminder.nextRunAt);
      let idle = false;
      const idleBarrier = when === "idle" ? agent.waitForNativeIdle().then(() => { idle = true; }) : undefined;
      const restart = agent.restartNative({ when, config: {
        version: 1, system: "new prompt", model: { protocol: "scripted", script },
        defaultPolicy: "open", policies: { open: { fallback: "allow", tools: {} }, updated: { fallback: "allow", tools: {} } },
      }, functions: { tools: { replacement: { description: "Replacement tool", parameters: { type: "object" }, handler: () => "ready" } } } });
      if (when === "idle") {
        const cancel = new AbortController();
        const cancelled = agent.waitForNativeIdle({ signal: cancel.signal });
        const reason = new Error("cancelled wait");
        cancel.abort(reason);
        await expect(cancelled).rejects.toBe(reason);
        await Bun.sleep(75);
        expect(idle).toBe(false);
        expect(host.launches).toBe(1);
        rig.release("restart");
      }
      const result = await restart;
      await run;
      await idleBarrier;
      expect(result).toMatchObject({ kind: "restarted", conversationCount: 2,
        conversations: expect.arrayContaining([{ id: channel.id, outcome: "reconnected" }, { id: unopened.id, outcome: "deferred" }]) });
      expect(result.interruptedTurns).toHaveLength(when === "now" ? 1 : 0);
      if (when === "now") expect(result.interruptedTurns[0]?.channel).toBe(channel.id);
      expect(events).toEqual([result]);
      expect(host.launches).toBe(2);
      expect((await agent.persistence.reminders!.wake()).effectiveAt).toBe(wake);
      expect(await agent.applyNativeChannelSettings(channel.id, { policy: "updated" })).toEqual({ state: "applied" });
      await channel.prompt("use the new system prompt");
      const request = readFileSync(requests, "utf8").trim().split("\n").at(-1);
      expect(request).toContain("new prompt");
      expect(JSON.parse(request!).tools).toContain("replacement");
    } finally { await rig.clean(); }
  });
}

test("Agent applies live native channel name and policy and rejects unsupported settings as a whole", async () => {
  const rig = await nativeRig({ policies: { open: { fallback: "allow", tools: {} }, strict: { fallback: "deny", tools: {} } } });
  try {
    const tool = (group: "runtime" | "revocable") => ({
      description: "Fixture tool", parameters: { type: "object" }, handler: () => "ok", group,
    });
    rig.harness.functions = { tools: { runtime: tool("runtime"), revocable: tool("revocable") } };
    const agent = await rig.open();
    const channel = await agent.conversations.create();
    expect(agent.channelSettingsLive.channel).toEqual(["displayName", "policy", "lifecycle"]);
    expect(await agent.applyNativeChannelSettings(channel.id, { displayName: "staged" })).toEqual({ state: "pending" });
    const host = agent.nativeHarness!;
    await host.start();
    expect(await agent.applyNativeChannelSettings(channel.id, { displayName: "live", policy: "strict" })).toEqual({ state: "applied" });
    expect((await host.status()).channels).toContainEqual(expect.objectContaining({ channel: channel.id, displayName: "live", policy: "strict" }));
    expect(await agent.applyNativeChannelSettings(channel.id, { displayName: "ignored", participants: ["new"] }))
      .toEqual({ state: "unsupported", code: "channel_settings_not_live", fields: ["participants"] });
    expect((await host.status()).channels).toContainEqual(expect.objectContaining({ channel: channel.id, displayName: "live" }));
    expect(await agent.applyNativeChannelSettings(channel.id, { policy: null })).toEqual({ state: "applied" });
    expect((await host.status()).channels[0]).toMatchObject({ displayName: "live" });
    expect((await host.status()).channels[0]?.policy).toBeUndefined();
    for (const lifecycle of ["suspended", "open", "retired"] as const) {
      expect(await agent.applyNativeChannelSettings(channel.id, { lifecycle })).toEqual({ state: "applied" });
      expect((await host.status()).channels[0]?.lifecycle).toBe(lifecycle);
    }
    for (const [name, operation, available] of [
      ["runtime", "enable", true], ["runtime", "remove", false], ["revocable", "revoke", false], ["revocable", "restore", true],
    ] as const) expect(await agent.applyNativeToolSetting(name, operation)).toMatchObject({ name, available });
    expect(host.launches).toBe(1);
  } finally { await rig.clean(); }
});
